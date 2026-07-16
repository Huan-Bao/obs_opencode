import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { TraceDatabase } from "../src/db/database.js";

export function withDatabase<T>(run: (database: TraceDatabase, directory: string) => T): T {
  const directory = mkdtempSync(join(tmpdir(), "agent-trace-test-"));
  const database = new TraceDatabase(join(directory, "trace.db"));
  try {
    const result = run(database, directory);
    if (result instanceof Promise) {
      return result.finally(() => {
        database.close();
        rmSync(directory, { recursive: true, force: true });
      }) as T;
    }
    database.close();
    rmSync(directory, { recursive: true, force: true });
    return result;
  } catch (error) {
    database.close();
    rmSync(directory, { recursive: true, force: true });
    throw error;
  }
}

export function sampleExport(sessionID = "ses_test") {
  return {
    info: {
      id: sessionID,
      slug: "sample",
      projectID: "global",
      directory: "D:\\sample",
      title: "Sample trace",
      version: "1.18.2",
      time: { created: 1_000, updated: 2_000 },
    },
    messages: [
      {
        info: {
          id: "msg_user",
          sessionID,
          role: "user",
          agent: "build",
          model: { providerID: "test", modelID: "model" },
          time: { created: 1_100 },
        },
        parts: [
          {
            id: "prt_user",
            sessionID,
            messageID: "msg_user",
            type: "text",
            text: "hello trace",
          },
        ],
      },
      {
        info: {
          id: "msg_assistant",
          sessionID,
          role: "assistant",
          providerID: "test",
          modelID: "model",
          cost: 0.01,
          tokens: {
            input: 10,
            output: 4,
            reasoning: 2,
            cache: { read: 1, write: 0 },
          },
          time: { created: 1_200, completed: 1_800 },
          finish: "stop",
        },
        parts: [
          {
            id: "prt_reason",
            sessionID,
            messageID: "msg_assistant",
            type: "reasoning",
            text: "thinking",
            time: { start: 1_250, end: 1_300 },
          },
          {
            id: "prt_tool",
            sessionID,
            messageID: "msg_assistant",
            type: "tool",
            tool: "read",
            callID: "call_read",
            state: {
              status: "completed",
              input: { filePath: "README.md" },
              output: "contents",
              metadata: { truncated: false },
              title: "README.md",
              time: { start: 1_350, end: 1_500 },
            },
          },
          {
            id: "prt_text",
            sessionID,
            messageID: "msg_assistant",
            type: "text",
            text: "done",
            time: { start: 1_600, end: 1_700 },
          },
        ],
      },
    ],
  };
}
