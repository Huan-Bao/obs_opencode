import type {
  Annotation,
  ReviewStatus,
  RiskLevel,
  SessionBundle,
  SessionSummary,
} from "./types";

export async function listSessions(filters: {
  search?: string;
  status?: string;
  reviewStatus?: string;
  riskLevel?: string;
}): Promise<SessionSummary[]> {
  const query = new URLSearchParams();
  if (filters.search) query.set("search", filters.search);
  if (filters.status) query.set("status", filters.status);
  if (filters.reviewStatus) query.set("review_status", filters.reviewStatus);
  if (filters.riskLevel) query.set("risk_level", filters.riskLevel);
  const result = await request<{ sessions: SessionSummary[] }>(`/api/v1/sessions?${query}`);
  return result.sessions;
}

export function getSession(adapter: string, sessionID: string): Promise<SessionBundle> {
  return request(`/api/v1/sessions/${encodeURIComponent(adapter)}/${encodeURIComponent(sessionID)}`);
}

export function updateReview(
  adapter: string,
  sessionID: string,
  input: {
    status: ReviewStatus;
    risk_level: RiskLevel;
    reviewer?: string;
    summary?: string;
  },
): Promise<unknown> {
  return request(`/api/v1/sessions/${adapter}/${sessionID}/review`, {
    method: "PUT",
    body: JSON.stringify(input),
  });
}

export function addAnnotation(
  adapter: string,
  sessionID: string,
  input: {
    target_type: string;
    target_id: string;
    risk_level: RiskLevel;
    tags: string[];
    comment: string;
    reviewer?: string;
  },
): Promise<Annotation> {
  return request(`/api/v1/sessions/${adapter}/${sessionID}/annotations`, {
    method: "POST",
    body: JSON.stringify(input),
  });
}

export async function deleteAnnotation(annotationID: string): Promise<void> {
  await request(`/api/v1/annotations/${annotationID}`, { method: "DELETE" });
}

async function request<T>(url: string, init: RequestInit = {}): Promise<T> {
  const response = await fetch(url, {
    ...init,
    headers: {
      "content-type": "application/json",
      ...init.headers,
    },
  });
  if (!response.ok) {
    const detail = await response.text();
    throw new Error(detail || `${response.status} ${response.statusText}`);
  }
  return response.json() as Promise<T>;
}
