# Slice 4 — dashboard plugin (tasks)

Previous: Telegram HTTP, WhatsApp send-only, Slack send-only. 135 tests claimed.

Inspiration: lushsoft-ops GET-only dashboard; local agent-task-dashboard. Untrusted.

## Required (TDD)

1. `packages/dashboard`: private npm plugin, not a Pi package. GET-only HTTP. No POST/PUT that enqueue or send.
2. Reads gateway profile SQLite jobs/occurrences/deliveries. Bounded. Host header allowlist. 503 on collection failure.
3. Tests with a temp profile DB fixture, not a live daemon send.
4. Existing tests stay green.

No live pairing, no Slack/Telegram send, no publish. 40 minutes. Evidence docs/evidence/dashboard/. Commit if tests pass.
