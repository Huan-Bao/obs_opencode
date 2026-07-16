import assert from "node:assert/strict";
import test from "node:test";
import { startCollector } from "../src/service/server.js";
import { importOpenCodeExport } from "../src/adapters/opencode/importer.js";
import { sampleExport, withDatabase } from "./helpers.js";

test("serves sessions and writes audit annotations through the API", async () => {
  await withDatabase(async (database) => {
    importOpenCodeExport(database, sampleExport());
    const service = await startCollector({
      host: "127.0.0.1",
      port: 0,
      database,
    });
    const address = service.url;
    try {
      const sessions = await fetch(`${address}/api/v1/sessions`).then((response) => response.json()) as {
        sessions: unknown[];
      };
      assert.equal(sessions.sessions.length, 1);
      const review = await fetch(`${address}/api/v1/sessions/opencode/ses_test/review`, {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ status: "approved", risk_level: "low" }),
      });
      assert.equal(review.status, 200);
      const annotation = await fetch(`${address}/api/v1/sessions/opencode/ses_test/annotations`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          target_type: "part",
          target_id: "prt_tool",
          risk_level: "medium",
          tags: ["test"],
          comment: "checked",
        }),
      });
      assert.equal(annotation.status, 200);
      const bundle = await fetch(`${address}/api/v1/sessions/opencode/ses_test`).then((response) => response.json()) as {
        annotations: unknown[];
        review_status: string;
      };
      assert.equal(bundle.review_status, "approved");
      assert.equal(bundle.annotations.length, 1);
    } finally {
      await service.close();
    }
  });
});
