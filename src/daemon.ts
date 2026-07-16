import { closeSync, openSync } from "node:fs";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { getBaseUrl, getPaths } from "./config.js";
import { pathExists, spawnProcess } from "./utils.js";

export async function collectorHealthy(): Promise<boolean> {
  try {
    const response = await fetch(`${getBaseUrl()}/health`, {
      signal: AbortSignal.timeout(800),
    });
    return response.ok;
  } catch {
    return false;
  }
}

export async function ensureCollector(): Promise<void> {
  if (await collectorHealthy()) return;
  const paths = getPaths();
  await mkdir(dirname(paths.pidFile), { recursive: true });
  const entry = process.argv[1];
  const logFD = openSync(paths.logFile, "a");
  const child = spawnProcess(
    process.execPath,
    [entry, "serve", "--daemon-child"],
    {
      detached: true,
      windowsHide: true,
      stdio: ["ignore", logFD, logFD],
      env: process.env,
    },
  );
  closeSync(logFD);
  child.unref();
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    if (await collectorHealthy()) return;
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  throw new Error(`Collector did not start. See ${paths.logFile}`);
}

export async function writeCollectorPID(pid: number): Promise<void> {
  const path = getPaths().pidFile;
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, String(pid), "utf8");
}

export async function stopCollector(): Promise<boolean> {
  const path = getPaths().pidFile;
  if (!(await pathExists(path))) return false;
  const pid = Number.parseInt((await readFile(path, "utf8")).trim(), 10);
  if (!Number.isFinite(pid)) {
    await rm(path, { force: true });
    return false;
  }
  try {
    process.kill(pid, "SIGTERM");
  } catch {
    // The process may already be gone.
  }
  await rm(path, { force: true });
  return true;
}
