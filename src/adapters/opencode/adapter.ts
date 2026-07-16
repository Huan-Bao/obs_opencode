import { mkdir, readFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { createOpencodeClient } from "@opencode-ai/sdk/v2";
import type { Session } from "@opencode-ai/sdk/v2";
import type {
  AdapterImportInput,
  AdapterLaunchOptions,
  CaptureContext,
  PreparedLaunch,
  ReconcileContext,
  TraceAdapter,
} from "../../types.js";
import { TraceDatabase } from "../../db/database.js";
import { getBaseUrl, getPaths } from "../../config.js";
import { EventJournal } from "../../journal.js";
import {
  commandOutput,
  createID,
  extractModel,
  isObject,
  now,
  resolveOpenCodeExecutable,
  spawnProcess,
  terminateProcessTree,
  waitForExit,
} from "../../utils.js";
import { normalizeOpenCodeEvent } from "./normalize.js";
import {
  importOpenCodeExport,
  parseOpenCodeExport,
  readOpenCodeExport,
} from "./importer.js";

interface AdapterDependencies {
  database: TraceDatabase;
  publish?: (event: string, data: unknown) => void;
  collectorUrl?: string;
}

export class OpenCodeAdapter implements TraceAdapter {
  readonly id = "opencode";
  private readonly captures = new Map<string, AbortController>();
  private executable?: string;

  constructor(private readonly dependencies: AdapterDependencies) {}

  async detect(): Promise<{ available: boolean; version?: string; executable?: string }> {
    try {
      const executable = await this.getExecutable();
      const version = (await commandOutput(executable, ["--version"])).trim();
      return { available: true, version, executable };
    } catch {
      return { available: false };
    }
  }

  async prepareLaunch(options: AdapterLaunchOptions): Promise<PreparedLaunch> {
    const detected = await this.detect();
    if (!detected.available) throw new Error("OpenCode CLI is not installed or not on PATH");
    const launchID = createID("launch");
    const startedAt = now();
    const externalServerUrl = process.env.AGENT_TRACE_OPENCODE_URL;
    const executable = detected.executable ?? await this.getExecutable();
    const serverProcess = externalServerUrl
      ? undefined
      : spawnProcess(
          executable,
          ["serve", "--hostname=127.0.0.1", "--port=0"],
          {
            cwd: options.cwd,
            env: process.env,
            stdio: ["ignore", "pipe", "pipe"],
            windowsHide: true,
          },
        );
    const serverUrl = externalServerUrl ?? await waitForOpenCodeServer(serverProcess!);
    const client = createOpencodeClient({
      baseUrl: serverUrl,
      directory: options.cwd,
    });

    let sourceSessionID = options.sessionID;
    if (!sourceSessionID && options.continueLast) {
      const sessions = await sdkData<Session[]>(client.session.list({ limit: 1 }));
      sourceSessionID = sessions?.[0]?.id;
      if (!sourceSessionID) throw new Error("No OpenCode session is available to continue");
    }

    let session: Session;
    if (sourceSessionID && options.fork) {
      session = await sdkData<Session>(client.session.fork({ sessionID: sourceSessionID }));
    } else if (sourceSessionID) {
      session = await sdkData<Session>(client.session.get({ sessionID: sourceSessionID }));
    } else {
      const model = extractModel(options.model);
      session = await sdkData<Session>(
        client.session.create({
          title: options.title,
          agent: options.agent,
          model: model ? { id: model.modelID, providerID: model.providerID } : undefined,
        }),
      );
    }

    const launch: PreparedLaunch = {
      launchID,
      adapter: this.id,
      sessionID: session.id,
      cwd: options.cwd,
      serverUrl,
      startedAt,
      serverProcess,
    };
    this.dependencies.database.upsertLaunch({
      launchID,
      adapter: this.id,
      rootSessionID: session.id,
      mode: options.mode,
      command: options,
      cwd: options.cwd,
      serverUrl,
      status: "running",
      pid: serverProcess?.pid,
      startedAt,
    });
    this.dependencies.database.upsertSession(this.id, session, launchID);
    this.dependencies.publish?.("session.updated", {
      adapter: this.id,
      sessionID: session.id,
    });
    return launch;
  }

  async captureEvents(context: CaptureContext): Promise<void> {
    const controller = new AbortController();
    this.captures.set(context.launch.launchID, controller);
    const journal = new EventJournal(
      join(getPaths().journals, `${context.launch.launchID}.ndjson`),
    );
    await journal.replay(async (raw) => {
      const normalized = normalizeOpenCodeEvent(raw, context.launch.launchID);
      if (normalized) await this.persistEvent(context.launch, raw, normalized);
    });
    const client = createOpencodeClient({
      baseUrl: context.launch.serverUrl,
      directory: context.launch.cwd,
    });
    const subscription = await client.event.subscribe(
      { directory: context.launch.cwd },
      {
        signal: AbortSignal.any([context.signal, controller.signal]),
        sseMaxRetryAttempts: 3,
      },
    );
    context.launch.closeCapture = () => controller.abort();
    try {
      for await (const raw of subscription.stream) {
        const normalized = normalizeOpenCodeEvent(raw, context.launch.launchID);
        if (!normalized) continue;
        await journal.append(raw);
        await this.persistEvent(context.launch, raw, normalized);
        await journal.markStored(raw);
      }
    } catch (error) {
      if (!controller.signal.aborted && !context.signal.aborted) throw error;
    } finally {
      this.captures.delete(context.launch.launchID);
    }
  }

  async reconcileSession(context: ReconcileContext): Promise<void> {
    const client = createOpencodeClient({
      baseUrl: context.launch.serverUrl,
      directory: context.launch.cwd,
      responseStyle: "data",
      throwOnError: true,
    });
    await this.reconcileOne(client, context.launch, context.launch.sessionID);
  }

  async importSession(input: AdapterImportInput): Promise<string[]> {
    if (input.file) {
      const file = resolve(input.file);
      const raw = JSON.parse(await readFile(file, "utf8")) as unknown;
      if (isObject(raw) && raw.schema_version === 1) {
        return [this.dependencies.database.importTraceExport(raw as never)];
      }
      return importOpenCodeExport(
        this.dependencies.database,
        parseOpenCodeExport(raw),
        input.launchID,
      );
    }
    if (!input.sessionID) throw new Error("OpenCode import requires --session or a file");
    const stdout = await commandOutput(await this.getExecutable(), ["export", input.sessionID]);
    const firstBrace = stdout.indexOf("{");
    if (firstBrace < 0) throw new Error("OpenCode export did not return JSON");
    const payload = parseOpenCodeExport(JSON.parse(stdout.slice(firstBrace)));
    return importOpenCodeExport(this.dependencies.database, payload, input.launchID);
  }

  async terminate(context: PreparedLaunch): Promise<void> {
    this.captures.get(context.launchID)?.abort();
    context.closeCapture?.();
    await terminateProcessTree(context.agentProcess);
    await terminateProcessTree(context.serverProcess);
  }

  async runAgent(launch: PreparedLaunch, options: AdapterLaunchOptions): Promise<number> {
    const args = this.buildAgentCommand(launch, options);
    const agentProcess = spawnProcess(await this.getExecutable(), args, {
      cwd: options.cwd,
      env: process.env,
      stdio: "inherit",
      windowsHide: false,
    });
    launch.agentProcess = agentProcess;
    this.dependencies.database.upsertLaunch({
      launchID: launch.launchID,
      adapter: this.id,
      rootSessionID: launch.sessionID,
      mode: options.mode,
      command: args,
      cwd: options.cwd,
      serverUrl: launch.serverUrl,
      status: "running",
      pid: agentProcess.pid,
      startedAt: launch.startedAt,
    });
    return waitForExit(agentProcess);
  }

  buildAgentCommand(launch: PreparedLaunch, options: AdapterLaunchOptions): string[] {
    let args: string[];
    if (options.mode === "run") {
      args = ["run", ...options.message, "--attach", launch.serverUrl, "--session", launch.sessionID];
      if (options.title) args.push("--title", options.title);
      if (options.model) args.push("--model", options.model);
      if (options.agent) args.push("--agent", options.agent);
    } else {
      args = ["attach", launch.serverUrl, "--session", launch.sessionID, "--dir", options.cwd];
      if (options.mini) args.push("--mini");
    }
    args.push(...options.passthrough);
    return args;
  }

  private async persistEvent(
    launch: PreparedLaunch,
    raw: unknown,
    prepared?: NonNullable<ReturnType<typeof normalizeOpenCodeEvent>>,
  ): Promise<void> {
    const normalized = prepared ?? normalizeOpenCodeEvent(raw, launch.launchID);
    if (!normalized) return;
    const inserted = await this.sendToCollector(normalized);
    if (!inserted) this.dependencies.database.ingestEvent(normalized);
    this.dependencies.publish?.("trace.event", {
      adapter: normalized.adapter,
      sessionID: normalized.sessionID,
      eventType: normalized.eventType,
      eventID: normalized.eventID,
    });
  }

  private async getExecutable(): Promise<string> {
    this.executable ??= await resolveOpenCodeExecutable();
    return this.executable;
  }

  private async sendToCollector(event: ReturnType<typeof normalizeOpenCodeEvent>): Promise<boolean> {
    if (!event) return false;
    const url = this.dependencies.collectorUrl;
    if (!url) return false;
    try {
      const response = await fetch(`${url}/api/v1/ingest/events`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ events: [event] }),
      });
      return response.ok;
    } catch {
      return false;
    }
  }

  private async reconcileOne(
    client: ReturnType<typeof createOpencodeClient>,
    launch: PreparedLaunch,
    sessionID: string,
  ): Promise<void> {
    const session = await sdkData<Session>(client.session.get({ sessionID }));
    this.dependencies.database.upsertSession(this.id, session, launch.launchID);
    const messages = await sdkData<Array<{ info: unknown; parts: unknown[] }>>(
      client.session.messages({ sessionID, limit: 10000 }),
    );
    for (const message of messages ?? []) {
      this.dependencies.database.ingestMessage(this.id, sessionID, message.info);
      for (const part of message.parts) {
        this.dependencies.database.ingestPart(this.id, sessionID, part);
      }
    }
    const diffs = await sdkData<unknown[]>(client.session.diff({ sessionID }));
    this.dependencies.database.ingestDiffs(this.id, sessionID, diffs ?? []);
    const children = await sdkData<Session[]>(client.session.children({ sessionID }));
    for (const child of children ?? []) {
      this.dependencies.database.upsertSession(this.id, child, launch.launchID);
      await this.reconcileOne(client, launch, child.id);
    }
    this.dependencies.database.setSessionStatus(this.id, sessionID, "idle");
  }
}

async function sdkData<T>(request: Promise<unknown>): Promise<T> {
  const result = (await request) as { data?: T; error?: unknown } | T;
  if (result && typeof result === "object" && "data" in result) {
    if (result.data !== undefined) return result.data;
    throw new Error(`OpenCode API request failed: ${JSON.stringify(result.error)}`);
  }
  return result as T;
}

async function waitForOpenCodeServer(process: import("node:child_process").ChildProcess): Promise<string> {
  return new Promise((resolvePromise, reject) => {
    let output = "";
    let settled = false;
    const timeout = setTimeout(() => {
      if (!settled) reject(new Error(`Timed out waiting for OpenCode server: ${output}`));
    }, 15_000);
    const onData = (chunk: Buffer | string) => {
      output += chunk.toString();
      const match = output.match(/opencode server listening[^\n]*on\s+(https?:\/\/[^\s]+)/i);
      if (match && !settled) {
        settled = true;
        clearTimeout(timeout);
        resolvePromise(match[1]);
      }
    };
    process.stdout?.on("data", onData);
    process.stderr?.on("data", onData);
    process.once("error", (error) => {
      clearTimeout(timeout);
      if (!settled) reject(error);
    });
    process.once("exit", (code) => {
      clearTimeout(timeout);
      if (!settled) reject(new Error(`OpenCode server exited with ${code}: ${output}`));
    });
  });
}
