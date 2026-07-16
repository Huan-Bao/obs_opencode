import { DatabaseSync } from "node:sqlite";
import type { SQLInputValue } from "node:sqlite";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { schemaSQL } from "./schema.js";
import {
  type NormalizedEvent,
  type ReviewStatus,
  type RiskLevel,
  REVIEW_STATUSES,
  RISK_LEVELS,
  type TraceExport,
} from "../types.js";
import { collectText, createID, isObject, json, now, parseJSON } from "../utils.js";

type Row = Record<string, unknown>;

export class TraceDatabase {
  readonly db: DatabaseSync;

  constructor(readonly path: string) {
    mkdirSync(dirname(path), { recursive: true });
    this.db = new DatabaseSync(path);
    this.db.exec(schemaSQL);
    this.db
      .prepare("INSERT OR IGNORE INTO schema_migrations(version, applied_at) VALUES(1, ?)")
      .run(now());
  }

  close(): void {
    this.db.close();
  }

  upsertLaunch(input: {
    launchID: string;
    adapter: string;
    rootSessionID?: string;
    mode: string;
    command: unknown;
    cwd: string;
    serverUrl?: string;
    status?: string;
    pid?: number;
    startedAt?: number;
    endedAt?: number;
    exitCode?: number;
    error?: string;
  }): void {
    this.db
      .prepare(`
        INSERT INTO launches (
          launch_id, adapter, root_session_id, mode, command_json, cwd, server_url,
          status, pid, started_at, ended_at, exit_code, error
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(launch_id) DO UPDATE SET
          root_session_id=COALESCE(excluded.root_session_id, launches.root_session_id),
          server_url=COALESCE(excluded.server_url, launches.server_url),
          status=excluded.status,
          pid=COALESCE(excluded.pid, launches.pid),
          ended_at=COALESCE(excluded.ended_at, launches.ended_at),
          exit_code=COALESCE(excluded.exit_code, launches.exit_code),
          error=COALESCE(excluded.error, launches.error)
      `)
      .run(
        input.launchID,
        input.adapter,
        input.rootSessionID ?? null,
        input.mode,
        json(input.command) ?? "[]",
        input.cwd,
        input.serverUrl ?? null,
        input.status ?? "starting",
        input.pid ?? null,
        input.startedAt ?? now(),
        input.endedAt ?? null,
        input.exitCode ?? null,
        input.error ?? null,
      );
  }

  upsertSession(adapter: string, session: unknown, launchID?: string): string {
    if (!isObject(session) || typeof session.id !== "string") {
      throw new Error("Session object must contain an id");
    }
    const time = isObject(session.time) ? session.time : {};
    const model = isObject(session.model) ? session.model : {};
    const tokens = isObject(session.tokens) ? session.tokens : {};
    const cache = isObject(tokens.cache) ? tokens.cache : {};
    const createdAt = numberValue(time.created, now());
    const updatedAt = numberValue(time.updated, createdAt);
    this.db
      .prepare(`
        INSERT INTO sessions (
          adapter, session_id, launch_id, parent_session_id, project_id, workspace_id,
          title, slug, directory, path, agent, provider_id, model_id, version, status,
          created_at, updated_at, ended_at, cost, tokens_input, tokens_output,
          tokens_reasoning, tokens_cache_read, tokens_cache_write, raw_json
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(adapter, session_id) DO UPDATE SET
          launch_id=COALESCE(excluded.launch_id, sessions.launch_id),
          parent_session_id=COALESCE(excluded.parent_session_id, sessions.parent_session_id),
          project_id=COALESCE(excluded.project_id, sessions.project_id),
          workspace_id=COALESCE(excluded.workspace_id, sessions.workspace_id),
          title=CASE WHEN excluded.title <> '' THEN excluded.title ELSE sessions.title END,
          slug=COALESCE(excluded.slug, sessions.slug),
          directory=COALESCE(excluded.directory, sessions.directory),
          path=COALESCE(excluded.path, sessions.path),
          agent=COALESCE(excluded.agent, sessions.agent),
          provider_id=COALESCE(excluded.provider_id, sessions.provider_id),
          model_id=COALESCE(excluded.model_id, sessions.model_id),
          version=COALESCE(excluded.version, sessions.version),
          status=CASE WHEN excluded.status <> 'unknown' THEN excluded.status ELSE sessions.status END,
          updated_at=MAX(excluded.updated_at, sessions.updated_at),
          ended_at=COALESCE(excluded.ended_at, sessions.ended_at),
          cost=MAX(excluded.cost, sessions.cost),
          tokens_input=MAX(excluded.tokens_input, sessions.tokens_input),
          tokens_output=MAX(excluded.tokens_output, sessions.tokens_output),
          tokens_reasoning=MAX(excluded.tokens_reasoning, sessions.tokens_reasoning),
          tokens_cache_read=MAX(excluded.tokens_cache_read, sessions.tokens_cache_read),
          tokens_cache_write=MAX(excluded.tokens_cache_write, sessions.tokens_cache_write),
          raw_json=excluded.raw_json
      `)
      .run(
        adapter,
        session.id,
        launchID ?? stringValue(session.launchID) ?? null,
        stringValue(session.parentID ?? session.parent_session_id) ?? null,
        stringValue(session.projectID ?? session.project_id) ?? null,
        stringValue(session.workspaceID ?? session.workspace_id) ?? null,
        stringValue(session.title) ?? "",
        stringValue(session.slug) ?? null,
        stringValue(session.directory) ?? null,
        stringValue(session.path) ?? null,
        stringValue(session.agent) ?? null,
        stringValue(model.providerID ?? session.providerID) ?? null,
        stringValue(model.id ?? model.modelID ?? session.modelID) ?? null,
        stringValue(session.version) ?? null,
        stringValue(session.status) ?? "unknown",
        createdAt,
        updatedAt,
        numberOrNull(time.completed ?? time.ended ?? session.ended_at),
        numberValue(session.cost, 0),
        numberValue(tokens.input ?? session.tokens_input, 0),
        numberValue(tokens.output ?? session.tokens_output, 0),
        numberValue(tokens.reasoning ?? session.tokens_reasoning, 0),
        numberValue(cache.read ?? session.tokens_cache_read, 0),
        numberValue(cache.write ?? session.tokens_cache_write, 0),
        json(session) ?? "{}",
      );
    this.ensureReview(adapter, session.id);
    this.indexFTS(adapter, session.id, "session", session.id, collectText(session));
    return session.id;
  }

  ensureSession(adapter: string, sessionID: string, launchID?: string, eventTime = now()): void {
    const existing = this.db
      .prepare("SELECT 1 FROM sessions WHERE adapter=? AND session_id=?")
      .get(adapter, sessionID);
    if (existing) return;
    this.upsertSession(
      adapter,
      {
        id: sessionID,
        title: sessionID,
        status: "unknown",
        time: { created: eventTime, updated: eventTime },
      },
      launchID,
    );
  }

  setSessionStatus(adapter: string, sessionID: string, status: string, timestamp = now()): void {
    this.ensureSession(adapter, sessionID, undefined, timestamp);
    this.db
      .prepare("UPDATE sessions SET status=?, updated_at=? WHERE adapter=? AND session_id=?")
      .run(status, timestamp, adapter, sessionID);
  }

  ingestEvent(event: NormalizedEvent): boolean {
    this.ensureSession(event.adapter, event.sessionID, event.launchID, event.eventTime);
    const seq =
      event.seq ??
      numberValue(
        this.db
          .prepare("SELECT COALESCE(MAX(seq), 0) + 1 AS seq FROM events WHERE adapter=? AND session_id=?")
          .get(event.adapter, event.sessionID)?.seq,
        1,
      );
    const result = this.db
      .prepare(`
        INSERT OR IGNORE INTO events (
          event_id, adapter, session_id, launch_id, seq, event_type, event_time,
          message_id, part_id, call_id, raw_json
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `)
      .run(
        event.eventID,
        event.adapter,
        event.sessionID,
        event.launchID ?? null,
        seq,
        event.eventType,
        event.eventTime,
        event.messageID ?? null,
        event.partID ?? null,
        event.callID ?? null,
        json(event.raw) ?? "{}",
      );
    if (result.changes === 0) return false;
    this.applyEvent(event);
    this.indexFTS(event.adapter, event.sessionID, "event", event.eventID, collectText(event.raw));
    return true;
  }

  ingestMessage(adapter: string, sessionID: string, info: unknown): void {
    if (!isObject(info) || typeof info.id !== "string") return;
    this.ensureSession(adapter, sessionID);
    const time = isObject(info.time) ? info.time : {};
    const model = isObject(info.model) ? info.model : {};
    const tokens = isObject(info.tokens) ? info.tokens : {};
    const cache = isObject(tokens.cache) ? tokens.cache : {};
    this.db
      .prepare(`
        INSERT INTO messages (
          adapter, session_id, message_id, parent_message_id, role, agent, provider_id,
          model_id, finish_reason, cost, tokens_input, tokens_output, tokens_reasoning,
          tokens_cache_read, tokens_cache_write, created_at, completed_at, raw_json
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(adapter, message_id) DO UPDATE SET
          parent_message_id=COALESCE(excluded.parent_message_id, messages.parent_message_id),
          role=excluded.role,
          agent=COALESCE(excluded.agent, messages.agent),
          provider_id=COALESCE(excluded.provider_id, messages.provider_id),
          model_id=COALESCE(excluded.model_id, messages.model_id),
          finish_reason=COALESCE(excluded.finish_reason, messages.finish_reason),
          cost=MAX(excluded.cost, messages.cost),
          tokens_input=MAX(excluded.tokens_input, messages.tokens_input),
          tokens_output=MAX(excluded.tokens_output, messages.tokens_output),
          tokens_reasoning=MAX(excluded.tokens_reasoning, messages.tokens_reasoning),
          tokens_cache_read=MAX(excluded.tokens_cache_read, messages.tokens_cache_read),
          tokens_cache_write=MAX(excluded.tokens_cache_write, messages.tokens_cache_write),
          completed_at=COALESCE(excluded.completed_at, messages.completed_at),
          raw_json=excluded.raw_json
      `)
      .run(
        adapter,
        sessionID,
        info.id,
        stringValue(info.parentID) ?? null,
        stringValue(info.role) ?? "unknown",
        stringValue(info.agent ?? info.mode) ?? null,
        stringValue(info.providerID ?? model.providerID) ?? null,
        stringValue(info.modelID ?? model.modelID ?? model.id) ?? null,
        stringValue(info.finish) ?? null,
        numberValue(info.cost, 0),
        numberValue(tokens.input, 0),
        numberValue(tokens.output, 0),
        numberValue(tokens.reasoning, 0),
        numberValue(cache.read, 0),
        numberValue(cache.write, 0),
        numberValue(time.created, now()),
        numberOrNull(time.completed),
        json(info) ?? "{}",
      );
    this.indexFTS(adapter, sessionID, "message", info.id, collectText(info));
    this.recomputeSessionMetrics(adapter, sessionID);
  }

  ingestPart(adapter: string, sessionID: string, part: unknown): void {
    if (!isObject(part) || typeof part.id !== "string") return;
    const messageID = stringValue(part.messageID);
    if (!messageID) return;
    const existingMessage = this.db
      .prepare("SELECT 1 FROM messages WHERE adapter=? AND message_id=?")
      .get(adapter, messageID);
    if (!existingMessage) {
      this.ingestMessage(adapter, sessionID, {
        id: messageID,
        role: "unknown",
        time: { created: now() },
      });
    }
    const time = isObject(part.time) ? part.time : {};
    const createdAt = numberValue(time.start ?? time.created, now());
    const updatedAt = numberValue(time.end ?? time.completed, createdAt);
    const callID = stringValue(part.callID);
    const content = collectText(part);
    this.db
      .prepare(`
        INSERT INTO parts (
          adapter, session_id, message_id, part_id, part_type, call_id,
          created_at, updated_at, content_text, raw_json
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(adapter, part_id) DO UPDATE SET
          part_type=excluded.part_type,
          call_id=COALESCE(excluded.call_id, parts.call_id),
          updated_at=MAX(excluded.updated_at, parts.updated_at),
          content_text=excluded.content_text,
          raw_json=excluded.raw_json
      `)
      .run(
        adapter,
        sessionID,
        messageID,
        part.id,
        stringValue(part.type) ?? "unknown",
        callID ?? null,
        createdAt,
        updatedAt,
        content,
        json(part) ?? "{}",
      );
    this.indexFTS(adapter, sessionID, "part", part.id, content);
    if (part.type === "tool" && callID) this.ingestToolPart(adapter, sessionID, part);
  }

  ingestDiffs(adapter: string, sessionID: string, diffs: unknown[], messageID?: string): void {
    for (const diff of diffs) {
      if (!isObject(diff)) continue;
      const path = stringValue(diff.file ?? diff.path ?? diff.file_path);
      this.db
        .prepare(`
          INSERT INTO session_diffs (
            adapter, session_id, message_id, file_path, additions, deletions, raw_json
          ) VALUES (?, ?, ?, ?, ?, ?, ?)
          ON CONFLICT(adapter, session_id, message_id, file_path) DO UPDATE SET
            additions=excluded.additions,
            deletions=excluded.deletions,
            raw_json=excluded.raw_json
        `)
        .run(
          adapter,
          sessionID,
          messageID ?? null,
          path ?? null,
          numberOrNull(diff.additions),
          numberOrNull(diff.deletions),
          json(diff) ?? "{}",
        );
      this.indexFTS(adapter, sessionID, "diff", `${messageID ?? ""}:${path ?? ""}`, collectText(diff));
    }
  }

  listSessions(filters: {
    search?: string;
    status?: string;
    reviewStatus?: string;
    riskLevel?: string;
    limit?: number;
    offset?: number;
  } = {}): Row[] {
    const conditions: string[] = [];
    const params: SQLInputValue[] = [];
    if (filters.search) {
      conditions.push(
        `(
          s.title LIKE ? OR s.directory LIKE ? OR s.session_id LIKE ? OR
          EXISTS (
            SELECT 1 FROM trace_fts f
            WHERE f.adapter=s.adapter AND f.session_id=s.session_id
              AND f.content MATCH ?
          )
        )`,
      );
      const like = `%${filters.search}%`;
      params.push(like, like, like, quoteFTS(filters.search));
    }
    if (filters.status) {
      conditions.push("s.status=?");
      params.push(filters.status);
    }
    if (filters.reviewStatus) {
      conditions.push("r.status=?");
      params.push(filters.reviewStatus);
    }
    if (filters.riskLevel) {
      conditions.push("r.risk_level=?");
      params.push(filters.riskLevel);
    }
    const where = conditions.length ? `WHERE ${conditions.join(" AND ")}` : "";
    params.push(Math.min(filters.limit ?? 100, 500), filters.offset ?? 0);
    return this.db
      .prepare(`
        SELECT
          s.*,
          r.status AS review_status,
          r.risk_level,
          r.reviewer,
          r.summary AS review_summary,
          COUNT(DISTINCT t.call_id) AS tool_count,
          COUNT(DISTINCT c.session_id) AS child_count
        FROM sessions s
        LEFT JOIN audit_reviews r ON r.adapter=s.adapter AND r.session_id=s.session_id
        LEFT JOIN tool_calls t ON t.adapter=s.adapter AND t.session_id=s.session_id
        LEFT JOIN sessions c ON c.adapter=s.adapter AND c.parent_session_id=s.session_id
        ${where}
        GROUP BY s.adapter, s.session_id
        ORDER BY s.updated_at DESC
        LIMIT ? OFFSET ?
      `)
      .all(...params) as Row[];
  }

  getSession(adapter: string, sessionID: string): Row | null {
    const session = this.db
      .prepare(`
        SELECT s.*, r.status AS review_status, r.risk_level, r.reviewer,
          r.summary AS review_summary
        FROM sessions s
        LEFT JOIN audit_reviews r ON r.adapter=s.adapter AND r.session_id=s.session_id
        WHERE s.adapter=? AND s.session_id=?
      `)
      .get(adapter, sessionID) as Row | undefined;
    if (!session) return null;
    return hydrateRow(session);
  }

  getSessionBundle(adapter: string, sessionID: string): Row | null {
    const session = this.getSession(adapter, sessionID);
    if (!session) return null;
    const messages = this.rows(
      "SELECT * FROM messages WHERE adapter=? AND session_id=? ORDER BY created_at, message_id",
      adapter,
      sessionID,
    );
    const parts = this.rows(
      "SELECT * FROM parts WHERE adapter=? AND session_id=? ORDER BY created_at, part_id",
      adapter,
      sessionID,
    );
    const partsByMessage = new Map<string, Row[]>();
    for (const part of parts) {
      const key = String(part.message_id);
      const values = partsByMessage.get(key) ?? [];
      values.push(hydrateRow(part));
      partsByMessage.set(key, values);
    }
    return {
      ...session,
      messages: messages.map((message) => ({
        ...hydrateRow(message),
        parts: partsByMessage.get(String(message.message_id)) ?? [],
      })),
      events: this.getEvents(adapter, sessionID, 10000),
      tool_calls: this.rows(
        "SELECT * FROM tool_calls WHERE adapter=? AND session_id=? ORDER BY COALESCE(started_at, ended_at), call_id",
        adapter,
        sessionID,
      ).map(hydrateRow),
      diffs: this.rows(
        "SELECT * FROM session_diffs WHERE adapter=? AND session_id=? ORDER BY diff_id",
        adapter,
        sessionID,
      ).map(hydrateRow),
      children: this.rows(
        "SELECT * FROM sessions WHERE adapter=? AND parent_session_id=? ORDER BY created_at",
        adapter,
        sessionID,
      ).map(hydrateRow),
      annotations: this.getAnnotations(adapter, sessionID),
    };
  }

  getEvents(adapter: string, sessionID: string, limit = 1000, afterSeq = 0): Row[] {
    return this.rows(
      `SELECT * FROM events
       WHERE adapter=? AND session_id=? AND seq>?
       ORDER BY seq LIMIT ?`,
      adapter,
      sessionID,
      afterSeq,
      Math.min(limit, 10000),
    ).map(hydrateRow);
  }

  updateReview(
    adapter: string,
    sessionID: string,
    input: {
      status?: ReviewStatus;
      riskLevel?: RiskLevel;
      reviewer?: string;
      summary?: string;
    },
  ): Row {
    this.ensureSession(adapter, sessionID);
    if (input.status && !REVIEW_STATUSES.includes(input.status)) throw new Error("Invalid review status");
    if (input.riskLevel && !RISK_LEVELS.includes(input.riskLevel)) throw new Error("Invalid risk level");
    const existing = this.db
      .prepare("SELECT * FROM audit_reviews WHERE adapter=? AND session_id=?")
      .get(adapter, sessionID) as Row;
    this.db
      .prepare(`
        INSERT INTO audit_reviews(adapter, session_id, status, risk_level, reviewer, summary, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(adapter, session_id) DO UPDATE SET
          status=excluded.status,
          risk_level=excluded.risk_level,
          reviewer=excluded.reviewer,
          summary=excluded.summary,
          updated_at=excluded.updated_at
      `)
      .run(
        adapter,
        sessionID,
        input.status ?? stringValue(existing.status) ?? "unreviewed",
        input.riskLevel ?? stringValue(existing.risk_level) ?? "none",
        input.reviewer ?? stringValue(existing.reviewer) ?? null,
        input.summary ?? stringValue(existing.summary) ?? null,
        now(),
      );
    return this.db
      .prepare("SELECT * FROM audit_reviews WHERE adapter=? AND session_id=?")
      .get(adapter, sessionID) as Row;
  }

  addAnnotation(
    adapter: string,
    sessionID: string,
    input: {
      annotationID?: string;
      targetType: string;
      targetID: string;
      riskLevel?: RiskLevel;
      tags?: string[];
      comment?: string;
      reviewer?: string;
    },
  ): Row {
    this.ensureSession(adapter, sessionID);
    if (input.riskLevel && !RISK_LEVELS.includes(input.riskLevel)) throw new Error("Invalid risk level");
    const id = input.annotationID ?? createID("ann");
    const timestamp = now();
    this.db
      .prepare(`
        INSERT INTO audit_annotations (
          annotation_id, adapter, session_id, target_type, target_id, risk_level,
          tags_json, comment, reviewer, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(annotation_id) DO UPDATE SET
          target_type=excluded.target_type,
          target_id=excluded.target_id,
          risk_level=excluded.risk_level,
          tags_json=excluded.tags_json,
          comment=excluded.comment,
          reviewer=excluded.reviewer,
          updated_at=excluded.updated_at
      `)
      .run(
        id,
        adapter,
        sessionID,
        input.targetType,
        input.targetID,
        input.riskLevel ?? "none",
        json(input.tags ?? []) ?? "[]",
        input.comment ?? "",
        input.reviewer ?? null,
        timestamp,
        timestamp,
      );
    return hydrateRow(
      this.db.prepare("SELECT * FROM audit_annotations WHERE annotation_id=?").get(id) as Row,
    );
  }

  deleteAnnotation(annotationID: string): boolean {
    return this.db
      .prepare("DELETE FROM audit_annotations WHERE annotation_id=?")
      .run(annotationID).changes > 0;
  }

  getAnnotations(adapter: string, sessionID: string): Row[] {
    return this.rows(
      "SELECT * FROM audit_annotations WHERE adapter=? AND session_id=? ORDER BY created_at",
      adapter,
      sessionID,
    ).map(hydrateRow);
  }

  exportSession(adapter: string, sessionID: string): TraceExport {
    const bundle = this.getSessionBundle(adapter, sessionID);
    if (!bundle) throw new Error(`Session not found: ${adapter}/${sessionID}`);
    return {
      schema_version: 1,
      exported_at: now(),
      session: stripBundle(bundle),
      children: (bundle.children as unknown[]) ?? [],
      messages: (bundle.messages as unknown[]) ?? [],
      events: (bundle.events as unknown[]) ?? [],
      tool_calls: (bundle.tool_calls as unknown[]) ?? [],
      diffs: (bundle.diffs as unknown[]) ?? [],
      audit: {
        review: {
          status: bundle.review_status,
          risk_level: bundle.risk_level,
          reviewer: bundle.reviewer,
          summary: bundle.review_summary,
        },
        annotations: (bundle.annotations as unknown[]) ?? [],
      },
    };
  }

  importTraceExport(payload: TraceExport): string {
    if (payload.schema_version !== 1 || !isObject(payload.session)) {
      throw new Error("Unsupported trace export");
    }
    const session = payload.session;
    const adapter = stringValue(session.adapter) ?? "opencode";
    const sessionID = stringValue(session.session_id ?? session.id);
    if (!sessionID) throw new Error("Export session is missing session_id");
    this.upsertSession(adapter, sessionToRaw(session, sessionID));
    for (const child of payload.children ?? []) {
      if (isObject(child)) this.upsertSession(adapter, sessionToRaw(child, String(child.session_id ?? child.id)));
    }
    for (const event of payload.events ?? []) {
      if (!isObject(event)) continue;
      this.ingestEvent({
        eventID: String(event.event_id ?? createID("evt")),
        adapter,
        sessionID,
        launchID: stringValue(event.launch_id),
        seq: numberOrNull(event.seq) ?? undefined,
        eventType: String(event.event_type ?? "imported"),
        eventTime: numberValue(event.event_time, now()),
        messageID: stringValue(event.message_id),
        partID: stringValue(event.part_id),
        callID: stringValue(event.call_id),
        raw: parseJSON(event.raw_json) ?? event,
      });
    }
    for (const message of payload.messages ?? []) {
      if (!isObject(message)) continue;
      const info = parseJSON(message.raw_json) ?? message;
      this.ingestMessage(adapter, sessionID, info);
      const nestedParts = Array.isArray(message.parts) ? message.parts : [];
      for (const part of nestedParts) {
        this.ingestPart(adapter, sessionID, parseJSON(isObject(part) ? part.raw_json : null) ?? part);
      }
    }
    for (const annotation of payload.audit?.annotations ?? []) {
      if (!isObject(annotation)) continue;
      this.addAnnotation(adapter, sessionID, {
        annotationID: stringValue(annotation.annotation_id),
        targetType: String(annotation.target_type ?? "session"),
        targetID: String(annotation.target_id ?? sessionID),
        riskLevel: String(annotation.risk_level ?? "none") as RiskLevel,
        tags: parseJSON<string[]>(annotation.tags_json) ?? [],
        comment: String(annotation.comment ?? ""),
        reviewer: stringValue(annotation.reviewer),
      });
    }
    if (isObject(payload.audit?.review)) {
      this.updateReview(adapter, sessionID, {
        status: String(payload.audit.review.status ?? "unreviewed") as ReviewStatus,
        riskLevel: String(payload.audit.review.risk_level ?? "none") as RiskLevel,
        reviewer: stringValue(payload.audit.review.reviewer),
        summary: stringValue(payload.audit.review.summary),
      });
    }
    return sessionID;
  }

  queryReadOnly(sql: string): Row[] {
    const normalized = sql.trim().replace(/;+\s*$/, "");
    if (!/^(select|with|pragma)\b/i.test(normalized)) {
      throw new Error("Only SELECT, WITH, and read-only PRAGMA queries are allowed");
    }
    if (
      /^pragma\b/i.test(normalized) &&
      !/^pragma\s+(database_list|compile_options|journal_mode|query_only|table_info|table_xinfo|index_list|index_info|index_xinfo|foreign_key_list)(\s*\([^)]*\))?\s*$/i.test(
        normalized,
      )
    ) {
      throw new Error("This PRAGMA is not in the read-only allowlist");
    }
    if (/\b(insert|update|delete|replace|create|alter|drop|attach|detach|vacuum|reindex)\b/i.test(normalized)) {
      throw new Error("Mutating SQL is not allowed");
    }
    this.db.exec("PRAGMA query_only = ON");
    try {
      return this.db.prepare(normalized).all() as Row[];
    } finally {
      this.db.exec("PRAGMA query_only = OFF");
    }
  }

  private applyEvent(event: NormalizedEvent): void {
    const raw = isObject(event.raw) ? event.raw : {};
    const properties = isObject(raw.properties) ? raw.properties : {};
    switch (event.eventType) {
      case "session.created":
      case "session.updated":
        this.upsertSession(event.adapter, properties.info ?? properties.session ?? {}, event.launchID);
        break;
      case "session.deleted":
        this.setSessionStatus(event.adapter, event.sessionID, "deleted", event.eventTime);
        break;
      case "session.status": {
        const status = isObject(properties.status)
          ? stringValue(properties.status.type)
          : stringValue(properties.status);
        if (status) this.setSessionStatus(event.adapter, event.sessionID, status, event.eventTime);
        break;
      }
      case "session.idle":
        this.setSessionStatus(event.adapter, event.sessionID, "idle", event.eventTime);
        break;
      case "session.error":
        this.setSessionStatus(event.adapter, event.sessionID, "error", event.eventTime);
        break;
      case "message.updated":
        this.ingestMessage(event.adapter, event.sessionID, properties.info);
        break;
      case "message.part.updated":
        this.ingestPart(event.adapter, event.sessionID, properties.part);
        break;
      case "session.diff":
        if (Array.isArray(properties.diff)) {
          this.ingestDiffs(event.adapter, event.sessionID, properties.diff, event.messageID);
        }
        break;
      default:
        if (event.eventType.startsWith("session.next.tool.")) {
          this.ingestToolEvent(event);
        }
    }
  }

  private ingestToolPart(adapter: string, sessionID: string, part: Row): void {
    const state = isObject(part.state) ? part.state : {};
    const time = isObject(state.time) ? state.time : {};
    const started = numberOrNull(time.start);
    const ended = numberOrNull(time.end);
    this.db
      .prepare(`
        INSERT INTO tool_calls (
          adapter, session_id, message_id, part_id, call_id, tool_name, status,
          title, input_json, output_text, error_json, metadata_json,
          started_at, ended_at, duration_ms, raw_json
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(adapter, call_id) DO UPDATE SET
          message_id=COALESCE(excluded.message_id, tool_calls.message_id),
          part_id=COALESCE(excluded.part_id, tool_calls.part_id),
          tool_name=excluded.tool_name,
          status=excluded.status,
          title=COALESCE(excluded.title, tool_calls.title),
          input_json=COALESCE(excluded.input_json, tool_calls.input_json),
          output_text=COALESCE(excluded.output_text, tool_calls.output_text),
          error_json=COALESCE(excluded.error_json, tool_calls.error_json),
          metadata_json=COALESCE(excluded.metadata_json, tool_calls.metadata_json),
          started_at=COALESCE(excluded.started_at, tool_calls.started_at),
          ended_at=COALESCE(excluded.ended_at, tool_calls.ended_at),
          duration_ms=COALESCE(excluded.duration_ms, tool_calls.duration_ms),
          raw_json=excluded.raw_json
      `)
      .run(
        adapter,
        sessionID,
        stringValue(part.messageID) ?? null,
        stringValue(part.id) ?? null,
        String(part.callID),
        stringValue(part.tool) ?? "unknown",
        stringValue(state.status) ?? "unknown",
        stringValue(state.title) ?? null,
        json(state.input),
        stringValue(state.output) ?? null,
        json(state.error),
        json(state.metadata),
        started,
        ended,
        started !== null && ended !== null ? ended - started : null,
        json(part) ?? "{}",
      );
    this.indexFTS(adapter, sessionID, "tool", String(part.callID), collectText(part));
  }

  private ingestToolEvent(event: NormalizedEvent): void {
    if (!event.callID || !isObject(event.raw)) return;
    const properties = isObject(event.raw.properties) ? event.raw.properties : {};
    const suffix = event.eventType.split(".").at(-1) ?? "unknown";
    const existing = this.db
      .prepare("SELECT * FROM tool_calls WHERE adapter=? AND call_id=?")
      .get(event.adapter, event.callID) as Row | undefined;
    const started = suffix === "called" ? event.eventTime : numberOrNull(existing?.started_at);
    const ended = ["success", "failed"].includes(suffix) ? event.eventTime : numberOrNull(existing?.ended_at);
    const content = Array.isArray(properties.content)
      ? properties.content.map((item) => (isObject(item) ? item.text ?? item.uri ?? "" : "")).join("\n")
      : undefined;
    this.db
      .prepare(`
        INSERT INTO tool_calls (
          adapter, session_id, message_id, part_id, call_id, tool_name, status,
          input_json, output_text, error_json, metadata_json, started_at, ended_at,
          duration_ms, raw_json
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(adapter, call_id) DO UPDATE SET
          tool_name=CASE WHEN excluded.tool_name <> 'unknown' THEN excluded.tool_name ELSE tool_calls.tool_name END,
          status=excluded.status,
          input_json=COALESCE(excluded.input_json, tool_calls.input_json),
          output_text=COALESCE(excluded.output_text, tool_calls.output_text),
          error_json=COALESCE(excluded.error_json, tool_calls.error_json),
          metadata_json=COALESCE(excluded.metadata_json, tool_calls.metadata_json),
          started_at=COALESCE(tool_calls.started_at, excluded.started_at),
          ended_at=COALESCE(excluded.ended_at, tool_calls.ended_at),
          duration_ms=COALESCE(excluded.duration_ms, tool_calls.duration_ms),
          raw_json=excluded.raw_json
      `)
      .run(
        event.adapter,
        event.sessionID,
        event.messageID ?? null,
        event.partID ?? null,
        event.callID,
        stringValue(properties.tool) ?? stringValue(existing?.tool_name) ?? "unknown",
        suffix,
        json(properties.input),
        typeof content === "string" ? content : null,
        json(properties.error),
        json(properties.provider ?? properties.structured),
        started,
        ended,
        started !== null && ended !== null ? ended - started : null,
        json(event.raw) ?? "{}",
      );
  }

  private ensureReview(adapter: string, sessionID: string): void {
    this.db
      .prepare(`
        INSERT OR IGNORE INTO audit_reviews(
          adapter, session_id, status, risk_level, updated_at
        ) VALUES (?, ?, 'unreviewed', 'none', ?)
      `)
      .run(adapter, sessionID, now());
  }

  private recomputeSessionMetrics(adapter: string, sessionID: string): void {
    this.db
      .prepare(`
        UPDATE sessions
        SET
          cost=COALESCE((
            SELECT SUM(cost) FROM messages
            WHERE messages.adapter=sessions.adapter
              AND messages.session_id=sessions.session_id
          ), 0),
          tokens_input=COALESCE((
            SELECT SUM(tokens_input) FROM messages
            WHERE messages.adapter=sessions.adapter
              AND messages.session_id=sessions.session_id
          ), 0),
          tokens_output=COALESCE((
            SELECT SUM(tokens_output) FROM messages
            WHERE messages.adapter=sessions.adapter
              AND messages.session_id=sessions.session_id
          ), 0),
          tokens_reasoning=COALESCE((
            SELECT SUM(tokens_reasoning) FROM messages
            WHERE messages.adapter=sessions.adapter
              AND messages.session_id=sessions.session_id
          ), 0),
          tokens_cache_read=COALESCE((
            SELECT SUM(tokens_cache_read) FROM messages
            WHERE messages.adapter=sessions.adapter
              AND messages.session_id=sessions.session_id
          ), 0),
          tokens_cache_write=COALESCE((
            SELECT SUM(tokens_cache_write) FROM messages
            WHERE messages.adapter=sessions.adapter
              AND messages.session_id=sessions.session_id
          ), 0)
        WHERE adapter=? AND session_id=?
      `)
      .run(adapter, sessionID);
  }

  private indexFTS(
    adapter: string,
    sessionID: string,
    entityType: string,
    entityID: string,
    content: string,
  ): void {
    this.db
      .prepare(
        "DELETE FROM trace_fts WHERE adapter=? AND session_id=? AND entity_type=? AND entity_id=?",
      )
      .run(adapter, sessionID, entityType, entityID);
    if (!content.trim()) return;
    this.db
      .prepare(
        "INSERT INTO trace_fts(adapter, session_id, entity_type, entity_id, content) VALUES(?, ?, ?, ?, ?)",
      )
      .run(adapter, sessionID, entityType, entityID, content);
  }

  private rows(sql: string, ...params: SQLInputValue[]): Row[] {
    return this.db.prepare(sql).all(...params) as Row[];
  }
}

function numberValue(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

function numberOrNull(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function hydrateRow(row: Row): Row {
  const hydrated = { ...row };
  for (const [key, value] of Object.entries(hydrated)) {
    if (key.endsWith("_json") && typeof value === "string") {
      hydrated[key.replace(/_json$/, "")] = parseJSON(value);
    }
  }
  return hydrated;
}

function quoteFTS(value: string): string {
  return `"${value.replaceAll('"', '""')}"`;
}

function stripBundle(bundle: Row): Row {
  const result = { ...bundle };
  delete result.messages;
  delete result.events;
  delete result.tool_calls;
  delete result.diffs;
  delete result.children;
  delete result.annotations;
  return result;
}

function sessionToRaw(session: Row, id: string): Row {
  const raw = parseJSON<Row>(session.raw_json);
  if (raw) return raw;
  return {
    id,
    title: session.title ?? id,
    parentID: session.parent_session_id,
    projectID: session.project_id,
    workspaceID: session.workspace_id,
    directory: session.directory,
    path: session.path,
    agent: session.agent,
    model: { providerID: session.provider_id, id: session.model_id },
    version: session.version,
    status: session.status,
    cost: session.cost,
    time: {
      created: session.created_at,
      updated: session.updated_at,
      completed: session.ended_at,
    },
  };
}
