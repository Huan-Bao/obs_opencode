export interface SessionSummary {
  adapter: string;
  session_id: string;
  parent_session_id?: string | null;
  title: string;
  directory?: string | null;
  agent?: string | null;
  provider_id?: string | null;
  model_id?: string | null;
  status: string;
  created_at: number;
  updated_at: number;
  ended_at?: number | null;
  cost: number;
  tokens_input: number;
  tokens_output: number;
  tokens_reasoning: number;
  tool_count: number;
  child_count: number;
  review_status: ReviewStatus;
  risk_level: RiskLevel;
  reviewer?: string | null;
  review_summary?: string | null;
  raw?: unknown;
}

export type ReviewStatus = "unreviewed" | "reviewing" | "approved" | "flagged";
export type RiskLevel = "none" | "low" | "medium" | "high" | "critical";

export interface TraceEvent {
  event_pk: number;
  event_id: string;
  adapter: string;
  session_id: string;
  seq: number;
  event_type: string;
  event_time: number;
  message_id?: string | null;
  part_id?: string | null;
  call_id?: string | null;
  raw: unknown;
}

export interface TracePart {
  part_id: string;
  message_id: string;
  part_type: string;
  call_id?: string | null;
  created_at: number;
  updated_at: number;
  content_text?: string | null;
  raw: Record<string, unknown>;
}

export interface TraceMessage {
  message_id: string;
  role: string;
  agent?: string | null;
  provider_id?: string | null;
  model_id?: string | null;
  finish_reason?: string | null;
  cost: number;
  tokens_input: number;
  tokens_output: number;
  tokens_reasoning: number;
  created_at: number;
  completed_at?: number | null;
  raw: unknown;
  parts: TracePart[];
}

export interface ToolCall {
  call_id: string;
  tool_name: string;
  status: string;
  title?: string | null;
  input?: unknown;
  output_text?: string | null;
  error?: unknown;
  metadata?: unknown;
  started_at?: number | null;
  ended_at?: number | null;
  duration_ms?: number | null;
  raw: unknown;
}

export interface Annotation {
  annotation_id: string;
  target_type: string;
  target_id: string;
  risk_level: RiskLevel;
  tags: string[];
  comment: string;
  reviewer?: string | null;
  created_at: number;
}

export interface SessionBundle extends SessionSummary {
  messages: TraceMessage[];
  events: TraceEvent[];
  tool_calls: ToolCall[];
  diffs: Array<Record<string, unknown>>;
  children: SessionSummary[];
  annotations: Annotation[];
}
