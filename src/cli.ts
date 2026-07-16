#!/usr/bin/env node
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { getBaseUrl, getPaths } from "./config.js";
import { TraceDatabase } from "./db/database.js";
import { ensureCollector, stopCollector, writeCollectorPID } from "./daemon.js";
import { startCollector } from "./service/server.js";
import { OpenCodeAdapter } from "./adapters/opencode/adapter.js";
import type { AdapterLaunchOptions } from "./types.js";
import { commandOutput, now, spawnProcess } from "./utils.js";

async function main(): Promise<void> {
  const [command = "help", ...args] = process.argv.slice(2);
  switch (command) {
    case "serve":
      await serve(args);
      return;
    case "run":
      await run(args);
      return;
    case "ui":
      await ui();
      return;
    case "stop":
      console.log((await stopCollector()) ? "Collector stopped" : "Collector is not running");
      return;
    case "sessions":
      await sessions(args);
      return;
    case "show":
      await show(args);
      return;
    case "events":
      await events(args);
      return;
    case "export":
      await exportSession(args);
      return;
    case "import":
      await importCommand(args);
      return;
    case "query":
      await query(args);
      return;
    case "db":
      await dbCommand(args);
      return;
    case "help":
    case "--help":
    case "-h":
      printHelp();
      return;
    default:
      throw new Error(`Unknown command: ${command}`);
  }
}

async function serve(args: string[]): Promise<void> {
  if (!args.includes("--daemon-child")) {
    const healthy = await fetch(`${getBaseUrl()}/health`).then((r) => r.ok).catch(() => false);
    if (healthy) {
      console.log(`Collector is already running at ${getBaseUrl()}`);
      return;
    }
  }
  await writeCollectorPID(process.pid);
  const service = await startCollector();
  console.log(`Agent Trace collector listening at ${getBaseUrl()}`);
  const shutdown = async () => {
    await service.close();
    await rm(getPaths().pidFile, { force: true });
    process.exit(0);
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
  await new Promise(() => undefined);
}

async function run(args: string[]): Promise<void> {
  if (args[0] !== "opencode") throw new Error("Only the opencode adapter is available in v1");
  const options = parseOpenCodeRun(args.slice(1));
  await ensureCollector();
  const database = new TraceDatabase(getPaths().database);
  const adapter = new OpenCodeAdapter({
    database,
    collectorUrl: getBaseUrl(),
  });
  const launch = await adapter.prepareLaunch(options);
  console.log(`session_id=${launch.sessionID}`);
  console.log(`trace_url=${getBaseUrl()}/sessions/${launch.adapter}/${launch.sessionID}`);
  const captureAbort = new AbortController();
  const capturePromise = adapter.captureEvents({ launch, signal: captureAbort.signal });
  let captureFailure: unknown;
  const capture = capturePromise.catch((error) => {
    captureFailure = error;
    if (!captureAbort.signal.aborted) console.error(`Trace capture failed: ${String(error)}`);
  });
  const captureReady = Promise.race([
    capturePromise.then(() => "ended" as const),
    new Promise<"ready">((resolveReady) => setTimeout(() => resolveReady("ready"), 250)),
  ]);
  let exitCode = 1;
  try {
    const captureState = await captureReady;
    if (captureState === "ended") {
      throw captureFailure instanceof Error
        ? captureFailure
        : new Error("OpenCode event stream ended before the agent started");
    }
    exitCode = await adapter.runAgent(launch, options);
    await adapter.reconcileSession({ launch });
    database.upsertLaunch({
      launchID: launch.launchID,
      adapter: launch.adapter,
      rootSessionID: launch.sessionID,
      mode: options.mode,
      command: options,
      cwd: options.cwd,
      serverUrl: launch.serverUrl,
      status: exitCode === 0 ? "completed" : "failed",
      startedAt: launch.startedAt,
      endedAt: now(),
      exitCode,
    });
  } catch (error) {
    database.upsertLaunch({
      launchID: launch.launchID,
      adapter: launch.adapter,
      rootSessionID: launch.sessionID,
      mode: options.mode,
      command: options,
      cwd: options.cwd,
      serverUrl: launch.serverUrl,
      status: "failed",
      startedAt: launch.startedAt,
      endedAt: now(),
      exitCode,
      error: String(error),
    });
    throw error;
  } finally {
    captureAbort.abort();
    await adapter.terminate(launch);
    await Promise.race([
      capture,
      new Promise<void>((resolveCapture) => setTimeout(resolveCapture, 2_000)),
    ]);
    database.close();
  }
  process.exitCode = exitCode;
}

async function ui(): Promise<void> {
  await ensureCollector();
  const url = getBaseUrl();
  if (process.platform === "win32") {
    spawnProcess("cmd.exe", ["/c", "start", "", url], {
      detached: true,
      stdio: "ignore",
      windowsHide: true,
    }).unref();
  } else if (process.platform === "darwin") {
    spawnProcess("open", [url], { detached: true, stdio: "ignore" }).unref();
  } else {
    spawnProcess("xdg-open", [url], { detached: true, stdio: "ignore" }).unref();
  }
  console.log(url);
}

async function sessions(args: string[]): Promise<void> {
  const database = new TraceDatabase(getPaths().database);
  const { value: search } = takeOption(args, "--search");
  const { value: limit } = takeOption(args, "--limit");
  const rows = database.listSessions({
    search,
    limit: limit ? Number.parseInt(limit, 10) : 100,
  });
  console.log(JSON.stringify(rows, null, 2));
  database.close();
}

async function show(args: string[]): Promise<void> {
  const sessionID = args[0];
  if (!sessionID) throw new Error("Usage: agent-trace show <session_id>");
  const database = new TraceDatabase(getPaths().database);
  console.log(JSON.stringify(database.getSessionBundle("opencode", sessionID), null, 2));
  database.close();
}

async function events(args: string[]): Promise<void> {
  const sessionID = args[0];
  if (!sessionID) throw new Error("Usage: agent-trace events <session_id>");
  const database = new TraceDatabase(getPaths().database);
  console.log(JSON.stringify(database.getEvents("opencode", sessionID, 10000), null, 2));
  database.close();
}

async function exportSession(args: string[]): Promise<void> {
  const sessionID = args[0];
  if (!sessionID) throw new Error("Usage: agent-trace export <session_id> [--output file]");
  const { value: output } = takeOption(args, "--output");
  const database = new TraceDatabase(getPaths().database);
  const payload = JSON.stringify(database.exportSession("opencode", sessionID), null, 2);
  if (output) {
    const file = resolve(output);
    await mkdir(dirname(file), { recursive: true });
    await writeFile(file, payload, "utf8");
    console.log(file);
  } else {
    console.log(payload);
  }
  database.close();
}

async function importCommand(args: string[]): Promise<void> {
  if (args[0] !== "opencode") throw new Error("Usage: agent-trace import opencode (--session id | file)");
  const rest = args.slice(1);
  const { value: sessionID } = takeOption(rest, "--session");
  const file = rest.find((value) => !value.startsWith("-"));
  const database = new TraceDatabase(getPaths().database);
  const adapter = new OpenCodeAdapter({ database });
  const imported = await adapter.importSession({ sessionID, file });
  console.log(JSON.stringify({ session_ids: imported }, null, 2));
  database.close();
}

async function query(args: string[]): Promise<void> {
  let sql = args.join(" ").trim();
  const { value: file } = takeOption(args, "--file");
  if (file) sql = await readFile(resolve(file), "utf8");
  if (!sql) throw new Error("Usage: agent-trace query \"SELECT ...\" or --file query.sql");
  const database = new TraceDatabase(getPaths().database);
  console.log(JSON.stringify(database.queryReadOnly(sql), null, 2));
  database.close();
}

async function dbCommand(args: string[]): Promise<void> {
  if (args[0] !== "path") throw new Error("Usage: agent-trace db path");
  console.log(getPaths().database);
}

function parseOpenCodeRun(args: string[]): AdapterLaunchOptions {
  const copy = [...args];
  let mode: "interactive" | "run" = "interactive";
  let project: string | undefined;
  const message: string[] = [];
  if (copy[0] === "run") {
    mode = "run";
    copy.shift();
  } else if (copy[0] && !copy[0].startsWith("-")) {
    project = copy.shift();
  }

  const values = new Map<string, string>();
  const flags = new Set<string>();
  const passthrough: string[] = [];
  const knownValues = new Set(["--session", "-s", "--model", "-m", "--agent", "--title"]);
  const knownFlags = new Set(["--continue", "-c", "--fork", "--mini"]);
  while (copy.length) {
    const token = copy.shift()!;
    if (token === "--") {
      passthrough.push(...copy);
      break;
    }
    if (knownValues.has(token)) {
      const value = copy.shift();
      if (!value) throw new Error(`Missing value for ${token}`);
      values.set(token, value);
      continue;
    }
    if (knownFlags.has(token)) {
      flags.add(token);
      continue;
    }
    if (mode === "run" && !token.startsWith("-")) {
      message.push(token);
      continue;
    }
    passthrough.push(token);
  }
  const cwd = resolve(project ?? process.cwd());
  return {
    cwd,
    project,
    mode,
    message,
    sessionID: values.get("--session") ?? values.get("-s"),
    continueLast: flags.has("--continue") || flags.has("-c"),
    fork: flags.has("--fork"),
    model: values.get("--model") ?? values.get("-m"),
    agent: values.get("--agent"),
    title: values.get("--title"),
    mini: flags.has("--mini"),
    passthrough,
  };
}

function takeOption(args: string[], name: string): { value?: string } {
  const index = args.indexOf(name);
  if (index < 0) return {};
  const value = args[index + 1];
  args.splice(index, value ? 2 : 1);
  return { value };
}

function printHelp(): void {
  console.log(`Agent Trace

Commands:
  agent-trace serve
  agent-trace ui
  agent-trace stop
  agent-trace run opencode [project] [options]
  agent-trace run opencode run [message...] [options]
  agent-trace sessions [--search text] [--limit n]
  agent-trace show <session_id>
  agent-trace events <session_id>
  agent-trace export <session_id> [--output file]
  agent-trace import opencode --session <id>
  agent-trace import opencode <export.json>
  agent-trace query "SELECT ..."
  agent-trace db path

Environment:
  AGENT_TRACE_HOME   Local storage directory
  AGENT_TRACE_PORT   Collector port (default 4318)`);
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
