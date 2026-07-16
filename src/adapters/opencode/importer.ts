import { readFile } from "node:fs/promises";
import { TraceDatabase } from "../../db/database.js";
import { createID, isObject, now } from "../../utils.js";

export interface OpenCodeExport {
  info: Record<string, unknown>;
  messages: Array<{
    info: Record<string, unknown>;
    parts: Array<Record<string, unknown>>;
  }>;
}

export async function readOpenCodeExport(file: string): Promise<OpenCodeExport> {
  return parseOpenCodeExport(JSON.parse(await readFile(file, "utf8")));
}

export function parseOpenCodeExport(value: unknown): OpenCodeExport {
  if (!isObject(value) || !isObject(value.info) || typeof value.info.id !== "string") {
    throw new Error("Invalid OpenCode export: missing info.id");
  }
  const messages = Array.isArray(value.messages)
    ? value.messages.filter(isObject).map((message) => ({
        info: isObject(message.info) ? message.info : {},
        parts: Array.isArray(message.parts) ? message.parts.filter(isObject) : [],
      }))
    : [];
  return { info: value.info, messages };
}

export function importOpenCodeExport(
  database: TraceDatabase,
  payload: OpenCodeExport,
  launchID?: string,
): string[] {
  const sessionID = String(payload.info.id);
  database.upsertSession("opencode", payload.info, launchID);
  let seq = 1;
  for (const message of payload.messages) {
    database.ingestMessage("opencode", sessionID, message.info);
    database.ingestEvent({
      eventID: `import-message-${String(message.info.id ?? createID("msg"))}`,
      adapter: "opencode",
      sessionID,
      launchID,
      seq: seq++,
      eventType: "message.updated",
      eventTime: messageTime(message.info),
      messageID: stringValue(message.info.id),
      raw: {
        id: `import-message-${String(message.info.id ?? seq)}`,
        type: "message.updated",
        properties: { sessionID, info: message.info },
      },
    });
    for (const part of message.parts) {
      database.ingestPart("opencode", sessionID, part);
      database.ingestEvent({
        eventID: `import-part-${String(part.id ?? createID("part"))}`,
        adapter: "opencode",
        sessionID,
        launchID,
        seq: seq++,
        eventType: "message.part.updated",
        eventTime: partTime(part),
        messageID: stringValue(part.messageID),
        partID: stringValue(part.id),
        callID: stringValue(part.callID),
        raw: {
          id: `import-part-${String(part.id ?? seq)}`,
          type: "message.part.updated",
          properties: { sessionID, part, time: partTime(part) },
        },
      });
    }
    const summary = isObject(message.info.summary) ? message.info.summary : {};
    if (Array.isArray(summary.diffs)) {
      database.ingestDiffs("opencode", sessionID, summary.diffs, stringValue(message.info.id));
    }
  }
  database.setSessionStatus("opencode", sessionID, "idle");
  return [sessionID];
}

function messageTime(info: Record<string, unknown>): number {
  const time = isObject(info.time) ? info.time : {};
  return numberValue(time.created);
}

function partTime(part: Record<string, unknown>): number {
  const time = isObject(part.time) ? part.time : {};
  return numberValue(time.start ?? time.created);
}

function numberValue(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? value : now();
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}
