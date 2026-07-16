import assert from "node:assert/strict";
import test from "node:test";
import { OpenCodeAdapter } from "../src/adapters/opencode/adapter.js";
import { withDatabase } from "./helpers.js";

test("builds OpenCode argument arrays without shell concatenation", () => {
  withDatabase((database) => {
    const adapter = new OpenCodeAdapter({ database });
    const args = adapter.buildAgentCommand(
      {
        launchID: "launch",
        adapter: "opencode",
        sessionID: "ses_1",
        cwd: "D:\\path with spaces",
        serverUrl: "http://127.0.0.1:1234",
        startedAt: 1,
      },
      {
        cwd: "D:\\path with spaces",
        mode: "run",
        message: ["hello; echo unsafe"],
        model: "provider/model",
        agent: "build",
        passthrough: ["--thinking"],
      },
    );
    assert.deepEqual(args, [
      "run",
      "hello; echo unsafe",
      "--attach",
      "http://127.0.0.1:1234",
      "--session",
      "ses_1",
      "--model",
      "provider/model",
      "--agent",
      "build",
      "--thinking",
    ]);
  });
});
