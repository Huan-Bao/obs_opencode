import { homedir } from "node:os";
import { join, resolve } from "node:path";

export interface AppPaths {
  home: string;
  database: string;
  journals: string;
  runtime: string;
  pidFile: string;
  logFile: string;
}

export function getPort(): number {
  const value = Number.parseInt(process.env.AGENT_TRACE_PORT ?? "4318", 10);
  return Number.isFinite(value) && value > 0 && value < 65536 ? value : 4318;
}

export function getHost(): string {
  return "127.0.0.1";
}

export function getBaseUrl(): string {
  return `http://${getHost()}:${getPort()}`;
}

export function getPaths(): AppPaths {
  const defaultHome =
    process.platform === "win32"
      ? join(process.env.LOCALAPPDATA ?? join(homedir(), "AppData", "Local"), "agent-trace")
      : join(process.env.XDG_DATA_HOME ?? join(homedir(), ".local", "share"), "agent-trace");
  const home = resolve(process.env.AGENT_TRACE_HOME ?? defaultHome);
  return {
    home,
    database: join(home, "agent-trace.db"),
    journals: join(home, "journals"),
    runtime: join(home, "runtime"),
    pidFile: join(home, "runtime", "collector.pid"),
    logFile: join(home, "runtime", "collector.log"),
  };
}

export function getWebRoot(): string {
  return resolve(new URL("../web/dist", import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1"));
}
