---
name: cli-trace
description: Inspect and operate the Agent Trace structured store for CLI agent sessions. Use when starting a traced OpenCode run, locating a session by session_id, querying trace events/messages/tool calls/diffs, importing OpenCode exports, exporting a versioned trace, or interpreting the Agent Trace SQLite schema. Do not use this skill for the Web audit interface.
---

# CLI Trace

Use the repository's `agent-trace` command to capture and inspect CLI agent traces. Treat
`session_id` as the primary identifier and preserve raw trace content unless the user explicitly
requests a transformation.

## Start a traced session

Run an interactive OpenCode TUI:

```powershell
agent-trace run opencode <project-path> [--model provider/model] [--agent name]
```

Run a non-interactive prompt:

```powershell
agent-trace run opencode run "the prompt" [--model provider/model] [--agent name]
```

Resume or fork:

```powershell
agent-trace run opencode <project-path> --session <session_id>
agent-trace run opencode <project-path> --session <session_id> --fork
agent-trace run opencode <project-path> --continue
```

Read the emitted `session_id=...` line and use that exact ID for every later operation.

## Inspect structured data

Prefer the stable commands before writing SQL:

```powershell
agent-trace sessions --search "<text>"
agent-trace show <session_id>
agent-trace events <session_id>
agent-trace db path
```

Use `agent-trace query` for read-only analysis. Only `SELECT`, `WITH`, and read-only `PRAGMA`
statements are accepted.

```powershell
agent-trace query "SELECT event_type, COUNT(*) AS count FROM events WHERE session_id='<session_id>' GROUP BY event_type"
```

Read [references/schema.md](references/schema.md) before composing joins or relying on field
semantics. Read [references/events.md](references/events.md) when interpreting event ordering,
tool lifecycles, sub-sessions, or raw payloads. Read [references/queries.md](references/queries.md)
for reusable query patterns.

## Import and export

Import an existing OpenCode session through the public OpenCode export command:

```powershell
agent-trace import opencode --session <session_id>
```

Import a saved OpenCode export or an Agent Trace v1 export:

```powershell
agent-trace import opencode <path-to-json>
```

Export a complete versioned trace:

```powershell
agent-trace export <session_id> --output <path-to-json>
```

Read [references/export-contract.md](references/export-contract.md) before consuming exports in
another program. Preserve unknown raw fields so future OpenCode event variants remain usable.

## Analysis rules

- Join records with both `adapter` and `session_id`; IDs are only guaranteed unique within an adapter.
- Use `events.seq` for stored event order and `event_time` for source time.
- Use `parent_session_id` to traverse sub-agent or fork relationships.
- Prefer structured `messages`, `parts`, `tool_calls`, and `session_diffs`; inspect `raw_json` when a
  structured field is absent.
- Expect raw prompts, reasoning, source content, tool arguments, tool output, and diffs to contain
  secrets or personal data. Do not print unrelated sensitive content.
- Do not describe or operate the visual audit interface from this skill.
