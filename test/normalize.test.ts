import assert from "node:assert/strict";
import test from "node:test";
import {
  extractOpenCodeSessionID,
  normalizeOpenCodeEvent,
} from "../src/adapters/opencode/normalize.js";

test("normalizes part events and correlation identifiers", () => {
  const raw = {
    id: "evt_1",
    type: "message.part.updated",
    properties: {
      sessionID: "ses_1",
      time: 123,
      part: {
        id: "prt_1",
        messageID: "msg_1",
        sessionID: "ses_1",
        callID: "call_1",
        type: "tool",
      },
    },
  };
  assert.equal(extractOpenCodeSessionID(raw), "ses_1");
  assert.deepEqual(normalizeOpenCodeEvent(raw, "launch_1"), {
    eventID: "evt_1",
    adapter: "opencode",
    sessionID: "ses_1",
    launchID: "launch_1",
    eventType: "message.part.updated",
    eventTime: 123,
    messageID: "msg_1",
    partID: "prt_1",
    callID: "call_1",
    raw,
  });
});

test("derives a stable id for events without an event id", () => {
  const raw = {
    type: "session.idle",
    properties: { sessionID: "ses_1", timestamp: 123 },
  };
  const first = normalizeOpenCodeEvent(raw);
  const second = normalizeOpenCodeEvent(raw);
  assert.equal(first?.eventID, second?.eventID);
});

test("does not attribute global events to the fallback session", () => {
  const raw = {
    id: "evt_global",
    type: "plugin.added",
    properties: { plugin: "example" },
  };
  assert.equal(normalizeOpenCodeEvent(raw, "launch_1", "ses_1"), null);
});
