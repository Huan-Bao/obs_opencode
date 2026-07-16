import type { ChildProcess } from "node:child_process";

export const REVIEW_STATUSES = [
  "unreviewed",
  "reviewing",
  "approved",
  "flagged",
] as const;

export const RISK_LEVELS = [
  "none",
  "low",
  "medium",
  "high",
  "critical",
] as const;

export type ReviewStatus = (typeof REVIEW_STATUSES)[number];
export type RiskLevel = (typeof RISK_LEVELS)[number];

export interface TraceAdapter {
  readonly id: string;
  detect(): Promise<{ available: boolean; version?: string; executable?: string }>;
  prepareLaunch(options: AdapterLaunchOptions): Promise<PreparedLaunch>;
  captureEvents(context: CaptureContext): Promise<void>;
  reconcileSession(context: ReconcileContext): Promise<void>;
  importSession(input: AdapterImportInput): Promise<string[]>;
  terminate(context: PreparedLaunch): Promise<void>;
}

export interface AdapterLaunchOptions {
  cwd: string;
  mode: "interactive" | "run";
  project?: string;
  message: string[];
  sessionID?: string;
  continueLast?: boolean;
  fork?: boolean;
  model?: string;
  agent?: string;
  title?: string;
  mini?: boolean;
  passthrough: string[];
}

export interface PreparedLaunch {
  launchID: string;
  adapter: string;
  sessionID: string;
  cwd: string;
  serverUrl: string;
  startedAt: number;
  serverProcess?: ChildProcess;
  agentProcess?: ChildProcess;
  closeCapture?: () => void;
}

export interface CaptureContext {
  launch: PreparedLaunch;
  signal: AbortSignal;
}

export interface ReconcileContext {
  launch: PreparedLaunch;
}

export interface AdapterImportInput {
  sessionID?: string;
  file?: string;
  launchID?: string;
}

export interface NormalizedEvent {
  eventID: string;
  adapter: string;
  sessionID: string;
  launchID?: string;
  seq?: number;
  eventType: string;
  eventTime: number;
  messageID?: string;
  partID?: string;
  callID?: string;
  raw: unknown;
}

export interface TraceExport {
  schema_version: 1;
  exported_at: number;
  session: unknown;
  children: unknown[];
  messages: unknown[];
  events: unknown[];
  tool_calls: unknown[];
  diffs: unknown[];
  audit: {
    review: unknown;
    annotations: unknown[];
  };
}
