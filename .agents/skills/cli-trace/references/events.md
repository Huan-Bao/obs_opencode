# Trace Event Semantics

## Ordering

Use `events.seq` to replay the collector's stored order. `event_time` is the source event time
and may be equal, delayed, or out of order after journal replay.

## Core OpenCode events

- `session.created`, `session.updated`, `session.status`, `session.idle`, `session.error`
- `message.updated`, `message.removed`
- `message.part.updated`, `message.part.removed`, `message.part.delta`
- `session.diff`, `permission.asked`, `permission.replied`
- `question.asked`, `question.replied`, `question.rejected`

OpenCode may add event types. Inspect `raw_json` instead of discarding unknown events.

## Tool lifecycle

Classic OpenCode traces commonly store a `message.part.updated` event whose part type is `tool`
and whose `state.status` evolves through pending/running/completed/error states.

Newer event streams may also emit:

- `session.next.tool.input.started|delta|ended`
- `session.next.tool.called`
- `session.next.tool.progress`
- `session.next.tool.success`
- `session.next.tool.failed`

Correlate them with `call_id`. The `tool_calls` table contains the latest normalized state;
the `events` table retains every received transition.

## Messages and parts

`messages` contains the envelope and aggregate token/cost data. Join `parts` on
`adapter` and `message_id` for text, reasoning, tool calls, snapshots, patches, and step
boundaries. `content_text` is for search and display; `raw_json` remains authoritative.

## Child sessions

Use `sessions.parent_session_id`. A launch can contain the root session and recursively
reconciled child sessions, each with its own `session_id`.
