import { randomUUID } from "node:crypto";
import { access } from "node:fs/promises";
import type { SpawnOptions, ChildProcess } from "node:child_process";
import { join } from "node:path";
import crossSpawn from "cross-spawn";

export function createID(prefix: string): string {
  return `${prefix}_${randomUUID().replaceAll("-", "")}`;
}

export function now(): number {
  return Date.now();
}

export function json(value: unknown): string | null {
  return value === undefined ? null : JSON.stringify(value);
}

export function parseJSON<T = unknown>(value: unknown): T | null {
  if (value === null || value === undefined) return null;
  if (typeof value !== "string") return value as T;
  try {
    return JSON.parse(value) as T;
  } catch {
    return null;
  }
}

export function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export async function pathExists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

export function spawnProcess(
  command: string,
  args: string[],
  options: SpawnOptions = {},
): ChildProcess {
  return crossSpawn(command, args, {
    shell: false,
    windowsHide: false,
    ...options,
  });
}

export async function waitForExit(process: ChildProcess): Promise<number> {
  return new Promise((resolve, reject) => {
    process.once("error", reject);
    process.once("exit", (code) => resolve(code ?? 1));
  });
}

export async function commandOutput(command: string, args: string[], cwd?: string): Promise<string> {
  const child = spawnProcess(command, args, {
    cwd,
    stdio: ["ignore", "pipe", "pipe"],
  });
  let stdout = "";
  let stderr = "";
  child.stdout?.on("data", (chunk) => (stdout += chunk.toString()));
  child.stderr?.on("data", (chunk) => (stderr += chunk.toString()));
  const code = await waitForExit(child);
  if (code !== 0) {
    throw new Error(`${command} exited with ${code}: ${stderr.trim()}`);
  }
  return stdout;
}

export async function resolveOpenCodeExecutable(): Promise<string> {
  const explicit = process.env.OPENCODE_BIN;
  if (explicit && await pathExists(explicit)) return explicit;
  if (process.platform !== "win32") return "opencode";

  const appDataCandidate = process.env.APPDATA
    ? join(process.env.APPDATA, "npm", "node_modules", "opencode-ai", "bin", "opencode.exe")
    : undefined;
  if (appDataCandidate && await pathExists(appDataCandidate)) return appDataCandidate;

  try {
    const npmRoot = (await commandOutput("npm", ["root", "-g"])).trim();
    const npmCandidate = join(npmRoot, "opencode-ai", "bin", "opencode.exe");
    if (await pathExists(npmCandidate)) return npmCandidate;
  } catch {
    // Fall back to PATH resolution below.
  }
  return "opencode";
}

export async function terminateProcessTree(child?: ChildProcess): Promise<void> {
  if (!child || child.exitCode !== null || !child.pid) return;
  if (process.platform === "win32") {
    const killer = spawnProcess(
      "taskkill.exe",
      ["/PID", String(child.pid), "/T", "/F"],
      { stdio: "ignore", windowsHide: true },
    );
    await waitForExit(killer).catch(() => 1);
    return;
  }
  child.kill("SIGTERM");
}

export function extractModel(model?: string): { providerID: string; modelID: string } | undefined {
  if (!model) return undefined;
  const slash = model.indexOf("/");
  if (slash <= 0 || slash === model.length - 1) {
    throw new Error(`Model must use provider/model format: ${model}`);
  }
  return { providerID: model.slice(0, slash), modelID: model.slice(slash + 1) };
}

export function eventTimestamp(raw: unknown, fallback = now()): number {
  if (!isObject(raw)) return fallback;
  const properties = isObject(raw.properties) ? raw.properties : {};
  const timestamp = properties.timestamp ?? properties.time;
  if (typeof timestamp === "number") return timestamp;
  const part = isObject(properties.part) ? properties.part : {};
  const partTime = isObject(part.time) ? part.time : {};
  if (typeof partTime.start === "number") return partTime.start;
  if (typeof partTime.created === "number") return partTime.created;
  const info = isObject(properties.info) ? properties.info : {};
  const infoTime = isObject(info.time) ? info.time : {};
  if (typeof infoTime.created === "number") return infoTime.created;
  return fallback;
}

export function collectText(value: unknown): string {
  if (typeof value === "string") return value;
  if (Array.isArray(value)) return value.map(collectText).filter(Boolean).join("\n");
  if (!isObject(value)) return "";
  const entries: string[] = [];
  for (const [key, nested] of Object.entries(value)) {
    if (["text", "output", "title", "error", "message", "command", "tool"].includes(key)) {
      entries.push(collectText(nested));
    }
  }
  return entries.filter(Boolean).join("\n");
}
