import Fastify from "fastify";
import fastifyStatic from "@fastify/static";
import { createReadStream, existsSync } from "node:fs";
import { readdir } from "node:fs/promises";
import { readFile } from "node:fs/promises";
import { basename, resolve } from "node:path";
import { getHost, getPaths, getPort, getWebRoot } from "../config.js";
import { TraceDatabase } from "../db/database.js";
import type { NormalizedEvent, ReviewStatus, RiskLevel, TraceExport } from "../types.js";
import { EventHub } from "./events.js";
import { OpenCodeAdapter } from "../adapters/opencode/adapter.js";
import { isObject } from "../utils.js";
import { EventJournal } from "../journal.js";
import { normalizeOpenCodeEvent } from "../adapters/opencode/normalize.js";

export interface CollectorService {
  database: TraceDatabase;
  hub: EventHub;
  adapter: OpenCodeAdapter;
  url: string;
  close(): Promise<void>;
}

export async function startCollector(options: {
  host?: string;
  port?: number;
  database?: TraceDatabase;
} = {}): Promise<CollectorService> {
  const database = options.database ?? new TraceDatabase(getPaths().database);
  const hub = new EventHub();
  const adapter = new OpenCodeAdapter({
    database,
    publish: (event, data) => hub.publish(event, data),
  });
  await replayPendingJournals(database);
  const app = Fastify({ logger: false, bodyLimit: 100 * 1024 * 1024 });

  app.get("/health", async () => ({
    ok: true,
    database: database.path,
    version: 1,
  }));

  app.get("/api/v1/sessions", async (request) => {
    const query = request.query as Record<string, string | undefined>;
    return {
      sessions: database.listSessions({
        search: query.search,
        status: query.status,
        reviewStatus: query.review_status,
        riskLevel: query.risk_level,
        limit: toNumber(query.limit),
        offset: toNumber(query.offset),
      }),
    };
  });

  app.get("/api/v1/sessions/:adapter/:sessionID", async (request, reply) => {
    const { adapter: adapterID, sessionID } = request.params as Record<string, string>;
    const session = database.getSessionBundle(adapterID, sessionID);
    if (!session) return reply.code(404).send({ error: "session_not_found" });
    return session;
  });

  app.get("/api/v1/sessions/:adapter/:sessionID/events", async (request) => {
    const { adapter: adapterID, sessionID } = request.params as Record<string, string>;
    const query = request.query as Record<string, string | undefined>;
    return {
      events: database.getEvents(
        adapterID,
        sessionID,
        toNumber(query.limit) ?? 1000,
        toNumber(query.after_seq) ?? 0,
      ),
    };
  });

  app.get("/api/v1/sessions/:adapter/:sessionID/export", async (request, reply) => {
    const { adapter: adapterID, sessionID } = request.params as Record<string, string>;
    try {
      const payload = database.exportSession(adapterID, sessionID);
      reply.header("content-disposition", `attachment; filename="${sessionID}.trace.json"`);
      return payload;
    } catch (error) {
      return reply.code(404).send({ error: String(error) });
    }
  });

  app.post("/api/v1/ingest/events", async (request) => {
    const body = request.body as { events?: NormalizedEvent[] };
    let inserted = 0;
    for (const event of body.events ?? []) {
      if (database.ingestEvent(event)) {
        inserted += 1;
        hub.publish("trace.event", {
          adapter: event.adapter,
          sessionID: event.sessionID,
          eventID: event.eventID,
          eventType: event.eventType,
        });
      }
    }
    return { inserted };
  });

  app.post("/api/v1/import/opencode", async (request, reply) => {
    const body = request.body as { session_id?: string; file?: string };
    try {
      const sessionIDs = await adapter.importSession({
        sessionID: body.session_id,
        file: body.file,
      });
      for (const sessionID of sessionIDs) {
        hub.publish("session.updated", { adapter: "opencode", sessionID });
      }
      return { session_ids: sessionIDs };
    } catch (error) {
      return reply.code(400).send({ error: String(error) });
    }
  });

  app.post("/api/v1/import/trace", async (request, reply) => {
    try {
      const sessionID = database.importTraceExport(request.body as TraceExport);
      hub.publish("session.updated", { adapter: "opencode", sessionID });
      return { session_id: sessionID };
    } catch (error) {
      return reply.code(400).send({ error: String(error) });
    }
  });

  app.put("/api/v1/sessions/:adapter/:sessionID/review", async (request, reply) => {
    const { adapter: adapterID, sessionID } = request.params as Record<string, string>;
    const body = request.body as {
      status?: ReviewStatus;
      risk_level?: RiskLevel;
      reviewer?: string;
      summary?: string;
    };
    try {
      const review = database.updateReview(adapterID, sessionID, {
        status: body.status,
        riskLevel: body.risk_level,
        reviewer: body.reviewer,
        summary: body.summary,
      });
      hub.publish("audit.updated", { adapter: adapterID, sessionID });
      return review;
    } catch (error) {
      return reply.code(400).send({ error: String(error) });
    }
  });

  app.post("/api/v1/sessions/:adapter/:sessionID/annotations", async (request, reply) => {
    const { adapter: adapterID, sessionID } = request.params as Record<string, string>;
    const body = request.body as {
      target_type?: string;
      target_id?: string;
      risk_level?: RiskLevel;
      tags?: string[];
      comment?: string;
      reviewer?: string;
    };
    if (!body.target_type || !body.target_id) {
      return reply.code(400).send({ error: "target_type and target_id are required" });
    }
    try {
      const annotation = database.addAnnotation(adapterID, sessionID, {
        targetType: body.target_type,
        targetID: body.target_id,
        riskLevel: body.risk_level,
        tags: body.tags,
        comment: body.comment,
        reviewer: body.reviewer,
      });
      hub.publish("audit.updated", { adapter: adapterID, sessionID });
      return annotation;
    } catch (error) {
      return reply.code(400).send({ error: String(error) });
    }
  });

  app.delete("/api/v1/annotations/:annotationID", async (request, reply) => {
    const { annotationID } = request.params as { annotationID: string };
    if (!database.deleteAnnotation(annotationID)) {
      return reply.code(404).send({ error: "annotation_not_found" });
    }
    hub.publish("audit.updated", { annotationID });
    return { deleted: true };
  });

  app.post("/api/v1/query", async (request, reply) => {
    const body = request.body as { sql?: string };
    if (!body.sql) return reply.code(400).send({ error: "sql is required" });
    try {
      return { rows: database.queryReadOnly(body.sql) };
    } catch (error) {
      return reply.code(400).send({ error: String(error) });
    }
  });

  app.get("/api/v1/stream", async (request, reply) => {
    reply.hijack();
    const response = reply.raw;
    response.writeHead(200, {
      "content-type": "text/event-stream; charset=utf-8",
      "cache-control": "no-cache, no-transform",
      connection: "keep-alive",
      "x-accel-buffering": "no",
    });
    response.write(`event: ready\ndata: ${JSON.stringify({ now: Date.now() })}\n\n`);
    const remove = hub.add(response);
    request.raw.on("close", remove);
  });

  const webRoot = getWebRoot();
  if (existsSync(webRoot)) {
    await app.register(fastifyStatic, {
      root: webRoot,
      wildcard: false,
    });
    app.get("/*", async (request, reply) => {
      if (request.url.startsWith("/api/")) return reply.code(404).send({ error: "not_found" });
      return reply.type("text/html").send(createReadStream(resolve(webRoot, "index.html")));
    });
  } else {
    app.get("/", async (_request, reply) =>
      reply
        .type("text/html")
        .send("<h1>Agent Trace</h1><p>Web UI is not built. Run <code>npm run build:web</code>.</p>"),
    );
  }

  const url = await app.listen({
    host: options.host ?? getHost(),
    port: options.port ?? getPort(),
  });

  return {
    database,
    hub,
    adapter,
    url,
    async close() {
      hub.close();
      await app.close();
      if (!options.database) database.close();
    },
  };
}

function toNumber(value?: string): number | undefined {
  if (!value) return undefined;
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) ? parsed : undefined;
}

async function replayPendingJournals(database: TraceDatabase): Promise<void> {
  const directory = getPaths().journals;
  let files: string[];
  try {
    files = await readdir(directory);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
    throw error;
  }
  for (const file of files.filter((value) => value.endsWith(".ndjson"))) {
    const launchID = basename(file, ".ndjson");
    const journal = new EventJournal(resolve(directory, file));
    await journal.replay(async (raw) => {
      const event = normalizeOpenCodeEvent(raw, launchID);
      if (!event) return;
      database.ingestEvent(event);
      await journal.markStored(raw);
    });
  }
}
