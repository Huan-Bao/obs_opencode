import assert from "node:assert/strict";
import { createServer } from "node:http";
import test from "node:test";
import { join } from "node:path";
import { OpenCodeAdapter } from "../src/adapters/opencode/adapter.js";
import type { PreparedLaunch } from "../src/types.js";
import { withDatabase } from "./helpers.js";

test("captures OpenCode SSE events and reconciles the final session snapshot", async () => {
  await withDatabase(async (database, directory) => {
    const previousHome = process.env.AGENT_TRACE_HOME;
    process.env.AGENT_TRACE_HOME = join(directory, "trace-home");
    const sessionID = "ses_mock";
    const message = {
      id: "msg_mock",
      sessionID,
      role: "assistant",
      providerID: "mock",
      modelID: "model",
      tokens: { input: 2, output: 1, reasoning: 0, cache: { read: 0, write: 0 } },
      time: { created: 110, completed: 130 },
      finish: "stop",
    };
    const part = {
      id: "prt_mock",
      sessionID,
      messageID: "msg_mock",
      type: "text",
      text: "mock response",
      time: { start: 115, end: 125 },
    };
    const server = createServer((request, response) => {
      const url = new URL(request.url ?? "/", "http://127.0.0.1");
      if (url.pathname === "/event") {
        response.writeHead(200, {
          "content-type": "text/event-stream",
          "cache-control": "no-cache",
          connection: "keep-alive",
        });
        response.write(
          `data: ${JSON.stringify({
            id: "evt_message",
            type: "message.updated",
            properties: { sessionID, info: message },
          })}\n\n`,
        );
        response.write(
          `data: ${JSON.stringify({
            id: "evt_part",
            type: "message.part.updated",
            properties: { sessionID, part, time: 115 },
          })}\n\n`,
        );
        setTimeout(() => response.end(), 20);
        return;
      }
      if (url.pathname === `/session/${sessionID}`) {
        return jsonResponse(response, {
          id: sessionID,
          slug: "mock",
          projectID: "global",
          directory,
          title: "Mock session",
          version: "1.18.2",
          time: { created: 100, updated: 140 },
        });
      }
      if (url.pathname === `/session/${sessionID}/message`) {
        return jsonResponse(response, [{ info: message, parts: [part] }]);
      }
      if (url.pathname === `/session/${sessionID}/diff`) {
        return jsonResponse(response, [
          { file: "README.md", additions: 1, deletions: 0, before: "", after: "hello" },
        ]);
      }
      if (url.pathname === `/session/${sessionID}/children`) {
        return jsonResponse(response, []);
      }
      response.writeHead(404).end();
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("Mock server did not bind");
    const launch: PreparedLaunch = {
      launchID: "launch_mock",
      adapter: "opencode",
      sessionID,
      cwd: directory,
      serverUrl: `http://127.0.0.1:${address.port}`,
      startedAt: 100,
    };
    database.upsertLaunch({
      launchID: launch.launchID,
      adapter: "opencode",
      rootSessionID: sessionID,
      mode: "run",
      command: [],
      cwd: directory,
      serverUrl: launch.serverUrl,
      status: "running",
      startedAt: 100,
    });
    database.ensureSession("opencode", sessionID, launch.launchID, 100);
    const adapter = new OpenCodeAdapter({ database });

    try {
      await adapter.captureEvents({ launch, signal: new AbortController().signal });
      await adapter.reconcileSession({ launch });
      const bundle = database.getSessionBundle("opencode", sessionID);
      assert.ok(bundle);
      assert.equal(bundle.title, "Mock session");
      assert.equal(bundle.status, "idle");
      assert.equal((bundle.messages as unknown[]).length, 1);
      assert.equal((bundle.events as unknown[]).length, 2);
      assert.equal((bundle.diffs as unknown[]).length, 1);
      assert.equal(bundle.tokens_input, 2);
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
      if (previousHome === undefined) delete process.env.AGENT_TRACE_HOME;
      else process.env.AGENT_TRACE_HOME = previousHome;
    }
  });
});

function jsonResponse(
  response: import("node:http").ServerResponse,
  value: unknown,
): void {
  response.writeHead(200, { "content-type": "application/json" });
  response.end(JSON.stringify(value));
}
