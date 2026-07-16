import { defineConfig } from "@playwright/test";

const port = Number.parseInt(process.env.AGENT_TRACE_E2E_PORT ?? "14318", 10);
const home = process.env.AGENT_TRACE_E2E_HOME ?? ".agent-trace/e2e";

export default defineConfig({
  testDir: "./test/e2e",
  timeout: 30_000,
  use: {
    baseURL: `http://127.0.0.1:${port}`,
    trace: "retain-on-failure",
  },
  webServer: {
    command: `node dist/cli.js serve`,
    url: `http://127.0.0.1:${port}/health`,
    reuseExistingServer: false,
    env: {
      ...process.env,
      AGENT_TRACE_PORT: String(port),
      AGENT_TRACE_HOME: home,
    },
    timeout: 30_000,
  },
});
