# Agent Trace Export Contract

Agent Trace exports use this top-level shape:

```json
{
  "schema_version": 1,
  "exported_at": 0,
  "session": {},
  "children": [],
  "messages": [],
  "events": [],
  "tool_calls": [],
  "diffs": [],
  "audit": {
    "review": {},
    "annotations": []
  }
}
```

## Contract rules

- `schema_version` is required and currently equals `1`.
- `session.adapter` and `session.session_id` identify the root session.
- Child sessions retain `parent_session_id`.
- Messages contain nested `parts`.
- Parsed JSON fields may appear beside their original `*_json` columns.
- Events retain `event_id`, `seq`, source time, correlation IDs, and raw payload.
- Import is idempotent for stable session, message, part, event, tool, and annotation IDs.
- Consumers must ignore unknown fields and preserve `raw`/`raw_json` when re-exporting.
