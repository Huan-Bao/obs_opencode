import assert from "node:assert/strict";
import test from "node:test";
import { join } from "node:path";
import { EventJournal } from "../src/journal.js";
import { withDatabase } from "./helpers.js";

test("replays only journal events without a stored marker", async () => {
  await withDatabase(async (_database, directory) => {
    const journal = new EventJournal(join(directory, "events.ndjson"));
    const stored = { id: "evt_1", type: "session.idle" };
    const pending = { id: "evt_2", type: "session.error" };
    await journal.append(stored);
    await journal.markStored(stored);
    await journal.append(pending);
    const values: unknown[] = [];
    const count = await journal.replay(async (event) => {
      values.push(event);
    });
    assert.equal(count, 1);
    assert.deepEqual(values, [pending]);
  });
});
