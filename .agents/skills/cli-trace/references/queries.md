# Common Read-only Queries

Replace `<session_id>` with the target ID.

## Session overview

```sql
SELECT
  session_id, title, status, directory, provider_id, model_id,
  tokens_input, tokens_output, tokens_reasoning, cost, created_at, updated_at
FROM sessions
WHERE adapter='opencode' AND session_id='<session_id>';
```

## Event counts

```sql
SELECT event_type, COUNT(*) AS count
FROM events
WHERE adapter='opencode' AND session_id='<session_id>'
GROUP BY event_type
ORDER BY count DESC;
```

## Tool calls

```sql
SELECT call_id, tool_name, status, duration_ms, input_json, output_text, error_json
FROM tool_calls
WHERE adapter='opencode' AND session_id='<session_id>'
ORDER BY COALESCE(started_at, ended_at), call_id;
```

## Conversation text

```sql
SELECT m.role, m.created_at, p.part_type, p.content_text
FROM messages m
JOIN parts p ON p.adapter=m.adapter AND p.message_id=m.message_id
WHERE m.adapter='opencode' AND m.session_id='<session_id>'
  AND p.part_type IN ('text', 'reasoning')
ORDER BY m.created_at, p.created_at;
```

## Child sessions

```sql
WITH RECURSIVE tree(session_id, parent_session_id, depth) AS (
  SELECT session_id, parent_session_id, 0
  FROM sessions
  WHERE adapter='opencode' AND session_id='<session_id>'
  UNION ALL
  SELECT s.session_id, s.parent_session_id, tree.depth + 1
  FROM sessions s
  JOIN tree ON s.parent_session_id=tree.session_id
  WHERE s.adapter='opencode'
)
SELECT * FROM tree ORDER BY depth, session_id;
```

## Full-text search

```sql
SELECT session_id, entity_type, entity_id, snippet(trace_fts, 4, '[', ']', ' ... ', 20) AS hit
FROM trace_fts
WHERE trace_fts MATCH '"search phrase"';
```
