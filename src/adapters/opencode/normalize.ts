import { createHash } from "node:crypto";
import type { NormalizedEvent } from "../../types.js";
import { eventTimestamp, isObject } from "../../utils.js";

export function extractOpenCodeSessionID(raw: unknown): string | undefined {
  if (!isObject(raw)) return undefined;
  const properties = isObject(raw.properties) ? raw.properties : {};
  if (typeof properties.sessionID === "string") return properties.sessionID;
  if (isObject(properties.info) && typeof properties.info.id === "string") return properties.info.id;
  if (isObject(properties.part) && typeof properties.part.sessionID === "string") {
    return properties.part.sessionID;
  }
  if (isObject(properties.permission) && typeof properties.permission.sessionID === "string") {
    return properties.permission.sessionID;
  }
  if (isObject(properties.question) && typeof properties.question.sessionID === "string") {
    return properties.question.sessionID;
  }
  return undefined;
}

export function normalizeOpenCodeEvent(
  raw: unknown,
  launchID?: string,
  fallbackSessionID?: string,
): NormalizedEvent | null {
  if (!isObject(raw) || typeof raw.type !== "string") return null;
  const properties = isObject(raw.properties) ? raw.properties : {};
  const part = isObject(properties.part) ? properties.part : {};
  const info = isObject(properties.info) ? properties.info : {};
  const sessionID =
    extractOpenCodeSessionID(raw) ??
    (isSessionScopedType(raw.type) ? fallbackSessionID : undefined);
  if (!sessionID) return null;
  const messageID =
    stringValue(properties.messageID) ??
    stringValue(part.messageID) ??
    (raw.type === "message.updated" ? stringValue(info.id) : undefined);
  const partID = stringValue(properties.partID) ?? stringValue(part.id);
  const callID = stringValue(properties.callID) ?? stringValue(part.callID);
  const eventID = stringValue(raw.id) ?? stableEventID(raw);
  return {
    eventID,
    adapter: "opencode",
    sessionID,
    launchID,
    eventType: raw.type,
    eventTime: eventTimestamp(raw),
    messageID,
    partID,
    callID,
    raw,
  };
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function stableEventID(value: unknown): string {
  return `evt_${createHash("sha256").update(JSON.stringify(value)).digest("hex").slice(0, 32)}`;
}

function isSessionScopedType(type: string): boolean {
  return (
    type.startsWith("session.") ||
    type.startsWith("message.") ||
    type.startsWith("permission.") ||
    type.startsWith("question.") ||
    type.startsWith("todo.")
  );
}
