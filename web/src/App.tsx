import { useCallback, useEffect, useMemo, useState } from "react";
import {
  addAnnotation,
  deleteAnnotation,
  getSession,
  listSessions,
  updateReview,
} from "./api";
import type {
  Annotation,
  ReviewStatus,
  RiskLevel,
  SessionBundle,
  SessionSummary,
  TraceMessage,
  TracePart,
} from "./types";

const reviewLabels: Record<ReviewStatus, string> = {
  unreviewed: "未审核",
  reviewing: "审核中",
  approved: "已通过",
  flagged: "已标记",
};

const riskLabels: Record<RiskLevel, string> = {
  none: "无",
  low: "低",
  medium: "中",
  high: "高",
  critical: "严重",
};

export function App() {
  const [sessions, setSessions] = useState<SessionSummary[]>([]);
  const [selected, setSelected] = useState<SessionBundle | null>(null);
  const [search, setSearch] = useState("");
  const [reviewStatus, setReviewStatus] = useState("");
  const [riskLevel, setRiskLevel] = useState("");
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");

  const refreshSessions = useCallback(async () => {
    try {
      const values = await listSessions({ search, reviewStatus, riskLevel });
      setSessions(values);
      setError("");
    } catch (reason) {
      setError(String(reason));
    } finally {
      setLoading(false);
    }
  }, [search, reviewStatus, riskLevel]);

  const refreshSelected = useCallback(async () => {
    if (!selected) return;
    try {
      setSelected(await getSession(selected.adapter, selected.session_id));
    } catch (reason) {
      setError(String(reason));
    }
  }, [selected?.adapter, selected?.session_id]);

  useEffect(() => {
    const timer = window.setTimeout(refreshSessions, 180);
    return () => window.clearTimeout(timer);
  }, [refreshSessions]);

  useEffect(() => {
    const stream = new EventSource("/api/v1/stream");
    const onUpdate = (event: MessageEvent<string>) => {
      const payload = safeJSON(event.data) as { sessionID?: string };
      void refreshSessions();
      if (!selected || !payload?.sessionID || payload.sessionID === selected.session_id) {
        void refreshSelected();
      }
    };
    stream.addEventListener("trace.event", onUpdate as EventListener);
    stream.addEventListener("session.updated", onUpdate as EventListener);
    stream.addEventListener("audit.updated", onUpdate as EventListener);
    return () => stream.close();
  }, [refreshSessions, refreshSelected, selected?.session_id]);

  async function openSession(session: SessionSummary) {
    setLoading(true);
    try {
      setSelected(await getSession(session.adapter, session.session_id));
      history.replaceState(null, "", `/sessions/${session.adapter}/${session.session_id}`);
      setError("");
    } catch (reason) {
      setError(String(reason));
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    const match = location.pathname.match(/^\/sessions\/([^/]+)\/([^/]+)$/);
    if (match) {
      void getSession(match[1], match[2]).then(setSelected).catch((reason) => setError(String(reason)));
    }
  }, []);

  return (
    <div className="app-shell">
      <header className="topbar">
        <div>
          <div className="eyebrow">LOCAL OBSERVABILITY</div>
          <h1>Agent Trace 审计台</h1>
        </div>
        <div className="sensitive-warning">
          <span className="warning-dot" />
          原始提示词、推理、工具输出与 diff 均以明文保存在本机
        </div>
      </header>

      <main className="workspace">
        <aside className="session-panel">
          <div className="filters">
            <label className="search-box">
              <span>⌕</span>
              <input
                aria-label="搜索会话"
                value={search}
                onChange={(event) => setSearch(event.target.value)}
                placeholder="搜索 session、标题、目录、内容"
              />
            </label>
            <div className="filter-row">
              <select
                aria-label="审核状态"
                value={reviewStatus}
                onChange={(event) => setReviewStatus(event.target.value)}
              >
                <option value="">全部审核状态</option>
                {Object.entries(reviewLabels).map(([value, label]) => (
                  <option value={value} key={value}>{label}</option>
                ))}
              </select>
              <select
                aria-label="风险等级"
                value={riskLevel}
                onChange={(event) => setRiskLevel(event.target.value)}
              >
                <option value="">全部风险</option>
                {Object.entries(riskLabels).map(([value, label]) => (
                  <option value={value} key={value}>{label}</option>
                ))}
              </select>
            </div>
          </div>

          <div className="panel-heading">
            <span>会话</span>
            <span className="count">{sessions.length}</span>
          </div>
          <div className="session-list">
            {sessions.map((session) => (
              <button
                key={`${session.adapter}:${session.session_id}`}
                className={`session-card ${selected?.session_id === session.session_id ? "selected" : ""}`}
                onClick={() => void openSession(session)}
              >
                <div className="session-card-top">
                  <span className={`status status-${session.status}`}>{session.status}</span>
                  <RiskBadge value={session.risk_level} />
                </div>
                <strong>{session.title || session.session_id}</strong>
                <code>{session.session_id}</code>
                <div className="muted line-clamp">{session.directory || "未知目录"}</div>
                <div className="session-stats">
                  <span>{formatModel(session)}</span>
                  <span>{Number(session.tool_count)} tools</span>
                  <span>{formatRelative(session.updated_at)}</span>
                </div>
              </button>
            ))}
            {!loading && sessions.length === 0 && <Empty text="没有匹配的会话" />}
          </div>
        </aside>

        <section className="detail-panel">
          {error && <div className="error-banner">{error}</div>}
          {!selected ? (
            <div className="welcome">
              <div className="trace-mark">⌁</div>
              <h2>选择一个会话开始人工审计</h2>
              <p>实时查看消息、推理、工具调用、错误、diff 和子会话。</p>
              <code>agent-trace run opencode .</code>
            </div>
          ) : (
            <SessionDetail
              session={selected}
              onRefresh={async () => {
                await Promise.all([refreshSelected(), refreshSessions()]);
              }}
              onOpenChild={(child) => void openSession(child)}
            />
          )}
        </section>
      </main>
    </div>
  );
}

function SessionDetail({
  session,
  onRefresh,
  onOpenChild,
}: {
  session: SessionBundle;
  onRefresh: () => Promise<void>;
  onOpenChild: (session: SessionSummary) => void;
}) {
  const [tab, setTab] = useState<"timeline" | "events" | "diffs" | "json">("timeline");
  const [review, setReview] = useState({
    status: session.review_status ?? "unreviewed",
    risk_level: session.risk_level ?? "none",
    reviewer: session.reviewer ?? "",
    summary: session.review_summary ?? "",
  });
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    setReview({
      status: session.review_status ?? "unreviewed",
      risk_level: session.risk_level ?? "none",
      reviewer: session.reviewer ?? "",
      summary: session.review_summary ?? "",
    });
  }, [session.session_id, session.review_status, session.risk_level, session.reviewer, session.review_summary]);

  const tokenTotal =
    Number(session.tokens_input || 0) +
    Number(session.tokens_output || 0) +
    Number(session.tokens_reasoning || 0);

  async function saveReview() {
    setSaving(true);
    try {
      await updateReview(session.adapter, session.session_id, {
        status: review.status as ReviewStatus,
        risk_level: review.risk_level as RiskLevel,
        reviewer: review.reviewer,
        summary: review.summary,
      });
      await onRefresh();
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="session-detail">
      <div className="session-header">
        <div className="session-title">
          <div className="eyebrow">{session.adapter.toUpperCase()} / {session.status}</div>
          <h2>{session.title || session.session_id}</h2>
          <div className="session-id-row">
            <code>{session.session_id}</code>
            <button onClick={() => navigator.clipboard.writeText(session.session_id)}>复制</button>
            <a href={`/api/v1/sessions/${session.adapter}/${session.session_id}/export`}>导出</a>
          </div>
        </div>
        <div className="metrics">
          <Metric label="模型" value={formatModel(session)} />
          <Metric label="Token" value={formatNumber(tokenTotal)} />
          <Metric label="成本" value={`$${Number(session.cost || 0).toFixed(4)}`} />
          <Metric label="工具" value={String(session.tool_calls.length)} />
        </div>
      </div>

      <div className="audit-strip">
        <select
          value={review.status}
          onChange={(event) => setReview({ ...review, status: event.target.value as ReviewStatus })}
        >
          {Object.entries(reviewLabels).map(([value, label]) => (
            <option value={value} key={value}>{label}</option>
          ))}
        </select>
        <select
          value={review.risk_level}
          onChange={(event) => setReview({ ...review, risk_level: event.target.value as RiskLevel })}
        >
          {Object.entries(riskLabels).map(([value, label]) => (
            <option value={value} key={value}>风险：{label}</option>
          ))}
        </select>
        <input
          value={review.reviewer}
          onChange={(event) => setReview({ ...review, reviewer: event.target.value })}
          placeholder="审核人"
        />
        <input
          className="review-summary"
          value={review.summary}
          onChange={(event) => setReview({ ...review, summary: event.target.value })}
          placeholder="会话审计结论"
        />
        <button className="primary" onClick={() => void saveReview()} disabled={saving}>
          {saving ? "保存中" : "保存审计"}
        </button>
      </div>

      <nav className="tabs">
        <button className={tab === "timeline" ? "active" : ""} onClick={() => setTab("timeline")}>
          时间线 <span>{session.messages.reduce((sum, message) => sum + message.parts.length, 0)}</span>
        </button>
        <button className={tab === "events" ? "active" : ""} onClick={() => setTab("events")}>
          原始事件 <span>{session.events.length}</span>
        </button>
        <button className={tab === "diffs" ? "active" : ""} onClick={() => setTab("diffs")}>
          Diff <span>{session.diffs.length}</span>
        </button>
        <button className={tab === "json" ? "active" : ""} onClick={() => setTab("json")}>
          会话 JSON
        </button>
      </nav>

      <div className="content-grid">
        <div className="trace-content">
          {tab === "timeline" && (
            <Timeline session={session} onRefresh={onRefresh} />
          )}
          {tab === "events" && (
            <div className="event-list">
              {session.events.map((event) => (
                <TraceCard
                  key={event.event_id}
                  accent="event"
                  title={event.event_type}
                  subtitle={`#${event.seq} · ${formatDate(event.event_time)}`}
                  targetType="event"
                  targetID={event.event_id}
                  session={session}
                  raw={event.raw}
                  onRefresh={onRefresh}
                />
              ))}
            </div>
          )}
          {tab === "diffs" && (
            <div className="event-list">
              {session.diffs.length ? session.diffs.map((diff, index) => (
                <TraceCard
                  key={String(diff.diff_id ?? index)}
                  accent="diff"
                  title={String(diff.file_path ?? diff.file ?? `Diff ${index + 1}`)}
                  subtitle={`+${diff.additions ?? "?"} / -${diff.deletions ?? "?"}`}
                  targetType="diff"
                  targetID={String(diff.diff_id ?? index)}
                  session={session}
                  raw={diff.raw ?? diff}
                  onRefresh={onRefresh}
                />
              )) : <Empty text="该会话没有记录 diff" />}
            </div>
          )}
          {tab === "json" && <JsonView value={session} />}
        </div>

        <aside className="context-rail">
          <section>
            <h3>运行上下文</h3>
            <Fact label="目录" value={session.directory || "-"} mono />
            <Fact label="Agent" value={session.agent || "-"} />
            <Fact label="开始" value={formatDate(session.created_at)} />
            <Fact label="更新" value={formatDate(session.updated_at)} />
          </section>
          <section>
            <h3>子会话</h3>
            {session.children.length ? session.children.map((child) => (
              <button className="child-session" key={child.session_id} onClick={() => onOpenChild(child)}>
                <strong>{child.title || child.session_id}</strong>
                <code>{child.session_id}</code>
              </button>
            )) : <div className="muted">无子会话</div>}
          </section>
          <section>
            <h3>审计标注</h3>
            <SessionAnnotationButton session={session} onRefresh={onRefresh} />
            {session.annotations.length ? session.annotations.map((annotation) => (
              <AnnotationView
                key={annotation.annotation_id}
                annotation={annotation}
                onDelete={async () => {
                  await deleteAnnotation(annotation.annotation_id);
                  await onRefresh();
                }}
              />
            )) : <div className="muted">尚无标注</div>}
          </section>
        </aside>
      </div>
    </div>
  );
}

function Timeline({ session, onRefresh }: { session: SessionBundle; onRefresh: () => Promise<void> }) {
  const notable = session.events.filter((event) =>
    event.event_type === "session.error" ||
    (event.event_type === "session.diff" && hasMeaningfulDiff(event.raw)) ||
    event.event_type.startsWith("permission.") ||
    event.event_type.startsWith("question."),
  );
  if (!session.messages.length && !notable.length) return <Empty text="等待 OpenCode 产生消息事件" />;
  return (
    <div className="timeline">
      {session.messages.map((message) => (
        <MessageBlock key={message.message_id} message={message} session={session} onRefresh={onRefresh} />
      ))}
      {notable.map((event) => (
        <article className="message-block" key={event.event_id}>
          <div className="message-marker">!</div>
          <div className="message-body">
            <TraceCard
              accent={event.event_type}
              title={event.event_type}
              subtitle={formatDate(event.event_time)}
              targetType="event"
              targetID={event.event_id}
              session={session}
              raw={event.raw}
              onRefresh={onRefresh}
            >
              <pre className="trace-text">{eventSummary(event.raw)}</pre>
            </TraceCard>
          </div>
        </article>
      ))}
    </div>
  );
}

function MessageBlock({
  message,
  session,
  onRefresh,
}: {
  message: TraceMessage;
  session: SessionBundle;
  onRefresh: () => Promise<void>;
}) {
  return (
    <article className={`message-block role-${message.role}`}>
      <div className="message-marker">{message.role === "user" ? "U" : message.role === "assistant" ? "A" : "·"}</div>
      <div className="message-body">
        <div className="message-meta">
          <strong>{message.role}</strong>
          <span>{formatDate(message.created_at)}</span>
          {message.model_id && <code>{message.provider_id}/{message.model_id}</code>}
        </div>
        {message.parts.map((part) => (
          <PartCard key={part.part_id} part={part} session={session} onRefresh={onRefresh} />
        ))}
      </div>
    </article>
  );
}

function PartCard({
  part,
  session,
  onRefresh,
}: {
  part: TracePart;
  session: SessionBundle;
  onRefresh: () => Promise<void>;
}) {
  const raw = part.raw ?? {};
  const tool = part.part_type === "tool";
  const title = tool
    ? String(raw.tool ?? "tool")
    : part.part_type === "reasoning"
      ? "Reasoning"
      : part.part_type;
  const content = part.content_text || String(raw.text ?? "");
  return (
    <TraceCard
      accent={part.part_type}
      title={title}
      subtitle={part.call_id ? `call_id: ${part.call_id}` : undefined}
      targetType="part"
      targetID={part.part_id}
      session={session}
      raw={raw}
      onRefresh={onRefresh}
    >
      {part.part_type === "reasoning" ? (
        <details className="reasoning">
          <summary>展开推理内容</summary>
          <pre>{content}</pre>
        </details>
      ) : tool ? (
        <ToolPart raw={raw} />
      ) : content ? (
        <pre className="trace-text">{content}</pre>
      ) : null}
    </TraceCard>
  );
}

function TraceCard({
  accent,
  title,
  subtitle,
  targetType,
  targetID,
  session,
  raw,
  onRefresh,
  children,
}: {
  accent: string;
  title: string;
  subtitle?: string;
  targetType: string;
  targetID: string;
  session: SessionBundle;
  raw: unknown;
  onRefresh: () => Promise<void>;
  children?: React.ReactNode;
}) {
  const [showJSON, setShowJSON] = useState(false);
  const [annotating, setAnnotating] = useState(false);
  return (
    <div className={`trace-card accent-${slug(accent)}`}>
      <div className="trace-card-header">
        <div>
          <strong>{title}</strong>
          {subtitle && <div className="muted">{subtitle}</div>}
        </div>
        <div className="card-actions">
          <button onClick={() => setAnnotating(!annotating)}>标注</button>
          <button onClick={() => setShowJSON(!showJSON)}>JSON</button>
        </div>
      </div>
      {children}
      {showJSON && <JsonView value={raw} />}
      {annotating && (
        <AnnotationForm
          onSave={async (input) => {
            await addAnnotation(session.adapter, session.session_id, {
              target_type: targetType,
              target_id: targetID,
              ...input,
            });
            setAnnotating(false);
            await onRefresh();
          }}
        />
      )}
    </div>
  );
}

function ToolPart({ raw }: { raw: Record<string, unknown> }) {
  const state = isRecord(raw.state) ? raw.state : {};
  return (
    <div className="tool-layout">
      <div>
        <span className={`status status-${String(state.status ?? "unknown")}`}>
          {String(state.status ?? "unknown")}
        </span>
        {state.title ? <strong>{String(state.title)}</strong> : null}
      </div>
      {state.input !== undefined && (
        <details open>
          <summary>输入</summary>
          <JsonView value={state.input} />
        </details>
      )}
      {state.output !== undefined && (
        <details>
          <summary>输出</summary>
          <pre className="trace-text">{String(state.output)}</pre>
        </details>
      )}
      {state.error !== undefined && (
        <details open>
          <summary>错误</summary>
          <JsonView value={state.error} />
        </details>
      )}
    </div>
  );
}

function AnnotationForm({
  onSave,
}: {
  onSave: (input: {
    risk_level: RiskLevel;
    tags: string[];
    comment: string;
    reviewer?: string;
  }) => Promise<void>;
}) {
  const [risk, setRisk] = useState<RiskLevel>("none");
  const [tags, setTags] = useState("");
  const [comment, setComment] = useState("");
  const [reviewer, setReviewer] = useState("");
  const [saving, setSaving] = useState(false);
  return (
    <div className="annotation-form">
      <select value={risk} onChange={(event) => setRisk(event.target.value as RiskLevel)}>
        {Object.entries(riskLabels).map(([value, label]) => (
          <option value={value} key={value}>风险：{label}</option>
        ))}
      </select>
      <input value={tags} onChange={(event) => setTags(event.target.value)} placeholder="标签，逗号分隔" />
      <input value={reviewer} onChange={(event) => setReviewer(event.target.value)} placeholder="审核人" />
      <textarea value={comment} onChange={(event) => setComment(event.target.value)} placeholder="审计评论" />
      <button
        className="primary"
        disabled={saving}
        onClick={async () => {
          setSaving(true);
          try {
            await onSave({
              risk_level: risk,
              tags: tags.split(",").map((value) => value.trim()).filter(Boolean),
              comment,
              reviewer,
            });
          } finally {
            setSaving(false);
          }
        }}
      >
        保存标注
      </button>
    </div>
  );
}

function AnnotationView({ annotation, onDelete }: { annotation: Annotation; onDelete: () => Promise<void> }) {
  return (
    <div className="annotation">
      <div>
        <RiskBadge value={annotation.risk_level} />
        <strong>{annotation.target_type}</strong>
      </div>
      <code>{annotation.target_id}</code>
      <p>{annotation.comment || "无评论"}</p>
      <div className="tag-row">
        {annotation.tags.map((tag) => <span key={tag}>{tag}</span>)}
      </div>
      <button className="danger" onClick={() => void onDelete()}>删除</button>
    </div>
  );
}

function SessionAnnotationButton({
  session,
  onRefresh,
}: {
  session: SessionBundle;
  onRefresh: () => Promise<void>;
}) {
  const [open, setOpen] = useState(false);
  return (
    <div className="session-annotation">
      <button onClick={() => setOpen(!open)}>添加会话标注</button>
      {open && (
        <AnnotationForm
          onSave={async (input) => {
            await addAnnotation(session.adapter, session.session_id, {
              target_type: "session",
              target_id: session.session_id,
              ...input,
            });
            setOpen(false);
            await onRefresh();
          }}
        />
      )}
    </div>
  );
}

function JsonView({ value }: { value: unknown }) {
  return <pre className="json-view">{JSON.stringify(value, null, 2)}</pre>;
}

function RiskBadge({ value }: { value: RiskLevel }) {
  return <span className={`risk risk-${value}`}>{riskLabels[value] ?? value}</span>;
}

function Metric({ label, value }: { label: string; value: string }) {
  return <div className="metric"><span>{label}</span><strong>{value}</strong></div>;
}

function Fact({ label, value, mono = false }: { label: string; value: string; mono?: boolean }) {
  return <div className="fact"><span>{label}</span>{mono ? <code>{value}</code> : <strong>{value}</strong>}</div>;
}

function Empty({ text }: { text: string }) {
  return <div className="empty">{text}</div>;
}

function formatModel(session: Pick<SessionSummary, "provider_id" | "model_id">): string {
  return [session.provider_id, session.model_id].filter(Boolean).join("/") || "-";
}

function formatDate(timestamp?: number | null): string {
  if (!timestamp) return "-";
  return new Intl.DateTimeFormat("zh-CN", {
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  }).format(timestamp);
}

function formatRelative(timestamp: number): string {
  const delta = Date.now() - timestamp;
  if (delta < 60_000) return "刚刚";
  if (delta < 3_600_000) return `${Math.floor(delta / 60_000)} 分钟前`;
  if (delta < 86_400_000) return `${Math.floor(delta / 3_600_000)} 小时前`;
  return `${Math.floor(delta / 86_400_000)} 天前`;
}

function formatNumber(value: number): string {
  return new Intl.NumberFormat("zh-CN", { notation: value > 9999 ? "compact" : "standard" }).format(value);
}

function slug(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9-]+/g, "-");
}

function safeJSON(value: string): unknown {
  try {
    return JSON.parse(value);
  } catch {
    return null;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function eventSummary(value: unknown): string {
  if (!isRecord(value)) return String(value ?? "");
  const properties = isRecord(value.properties) ? value.properties : {};
  const interesting = properties.error ?? properties.permission ?? properties.question ?? properties.diff ?? properties;
  return typeof interesting === "string" ? interesting : JSON.stringify(interesting, null, 2);
}

function hasMeaningfulDiff(value: unknown): boolean {
  if (!isRecord(value)) return false;
  const properties = isRecord(value.properties) ? value.properties : {};
  return Array.isArray(properties.diff) && properties.diff.length > 0;
}
