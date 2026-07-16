param(
  [Parameter(Mandatory = $true)]
  [string]$SessionId
)

$sql = @"
SELECT
  e.seq,
  e.event_type,
  e.event_time,
  e.message_id,
  e.part_id,
  e.call_id
FROM events e
WHERE e.adapter='opencode' AND e.session_id='$($SessionId.Replace("'", "''"))'
ORDER BY e.seq;
"@

agent-trace query $sql
