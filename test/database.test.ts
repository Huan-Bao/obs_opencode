import assert from "node:assert/strict";
import test from "node:test";
import { importOpenCodeExport } from "../src/adapters/opencode/importer.js";
import { sampleExport, withDatabase } from "./helpers.js";

test("imports OpenCode exports idempotently and indexes tool lifecycle", () => {
  withDatabase((database) => {
    const payload = sampleExport();
    importOpenCodeExport(database, payload);
    importOpenCodeExport(database, payload);

    const session = database.getSessionBundle("opencode", "ses_test");
    assert.ok(session);
    assert.equal((session.messages as unknown[]).length, 2);
    assert.equal((session.tool_calls as Array<Record<string, unknown>>).length, 1);
    assert.equal(
      (session.tool_calls as Array<Record<string, unknown>>)[0].status,
      "completed",
    );
    assert.equal(database.getEvents("opencode", "ses_test", 100).length, 6);
    assert.equal(database.listSessions({ search: "hello trace" }).length, 1);
  });
});

test("deduplicates events and preserves per-session order", () => {
  withDatabase((database) => {
    database.ensureSession("opencode", "ses_events");
    const event = {
      eventID: "evt_same",
      adapter: "opencode",
      sessionID: "ses_events",
      seq: 2,
      eventType: "session.idle",
      eventTime: 2,
      raw: { id: "evt_same", type: "session.idle", properties: { sessionID: "ses_events" } },
    };
    assert.equal(database.ingestEvent(event), true);
    assert.equal(database.ingestEvent(event), false);
    database.ingestEvent({
      ...event,
      eventID: "evt_first",
      seq: 1,
      eventTime: 1,
    });
    assert.deepEqual(
      database.getEvents("opencode", "ses_events", 10).map((row) => row.seq),
      [1, 2],
    );
  });
});

test("stores child sessions and validates audit state", () => {
  withDatabase((database) => {
    database.upsertSession("opencode", {
      id: "ses_parent",
      title: "parent",
      time: { created: 1, updated: 1 },
    });
    database.upsertSession("opencode", {
      id: "ses_child",
      parentID: "ses_parent",
      title: "child",
      time: { created: 2, updated: 2 },
    });
    database.updateReview("opencode", "ses_parent", {
      status: "flagged",
      riskLevel: "high",
      reviewer: "alice",
    });
    database.addAnnotation("opencode", "ses_parent", {
      targetType: "session",
      targetID: "ses_parent",
      riskLevel: "medium",
      tags: ["security"],
      comment: "review this",
    });

    const bundle = database.getSessionBundle("opencode", "ses_parent");
    assert.equal((bundle?.children as unknown[]).length, 1);
    assert.equal(bundle?.review_status, "flagged");
    assert.equal((bundle?.annotations as unknown[]).length, 1);
    assert.throws(
      () => database.queryReadOnly("DELETE FROM sessions"),
      /Only SELECT|Mutating SQL/,
    );
  });
});

test("exports and reimports versioned traces", () => {
  withDatabase((database) => {
    importOpenCodeExport(database, sampleExport());
    const payload = database.exportSession("opencode", "ses_test");
    assert.equal(payload.schema_version, 1);
    assert.equal(database.importTraceExport(payload), "ses_test");
    assert.equal(database.listSessions().length, 1);
  });
});
