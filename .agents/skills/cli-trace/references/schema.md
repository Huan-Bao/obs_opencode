# Agent Trace SQLite Schema

## Contents

- [Identity and ordering](#identity-and-ordering)
- [Tables](#tables)
- [JSON fields](#json-fields)

## Identity and ordering

- A session is uniquely identified by `(adapter, session_id)`.
- `launch_id` groups the root session and child sessions created by one wrapper invocation.
- `parent_session_id` links child or forked sessions.
- `events.seq` is the collector's monotonically increasing per-session order.
- Source timestamps are Unix epoch milliseconds.

## Tables

### `launches`

One row per `agent-trace run` invocation. Important fields: `launch_id`, `adapter`,
`root_session_id`, `mode`, `cwd`, `server_url`, `status`, `started_at`, `ended_at`,
`exit_code`, and `error`.

### `sessions`

Session metadata and aggregate usage. Important fields: `session_id`, `launch_id`,
`parent_session_id`, `title`, `directory`, `agent`, `provider_id`, `model_id`, `status`,
token counters, `cost`, timestamps, and `raw_json`.

### `events`

Append-only normalized events. Important fields: `event_id`, `session_id`, `seq`,
`event_type`, `event_time`, optional `message_id`/`part_id`/`call_id`, and `raw_json`.
`(adapter, event_id)` and `(adapter, session_id, seq)` are unique.

### `messages`

One row per user, assistant, or synthetic message. Includes model, token, cost, finish,
timestamps, and complete `raw_json`.

### `parts`

Message components such as `text`, `reasoning`, `tool`, `step-start`, `step-finish`,
`patch`, `snapshot`, `retry`, and `compaction`. `content_text` is searchable extracted
content; `raw_json` is authoritative.

### `tool_calls`

One row per `call_id`. Includes tool name, lifecycle status, input, output, error,
metadata, start/end times, duration, and complete `raw_json`.

### `session_diffs`

Structured file-diff records, optionally associated with a message.

### `audit_reviews` and `audit_annotations`

Manual audit state. Review status is `unreviewed`, `reviewing`, `approved`, or `flagged`.
Risk is `none`, `low`, `medium`, `high`, or `critical`.

### `trace_fts`

FTS5 search index covering extracted session, message, part, event, tool, and diff text.
Use the `MATCH` operator.

## JSON fields

Fields ending in `_json` are JSON text in SQLite. The CLI and HTTP API also expose parsed
versions without the `_json` suffix. Preserve the original JSON when transforming records.
