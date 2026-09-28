# Channel slice 1 — Telegram default HTTP (no live bot)

Goal slice: adapters Telegram, WhatsApp, Slack; then dashboard, approvals, wiki. This slice is Telegram only.

Inspiration (public, untrusted): Telegram Bot API sendMessage; existing adapter already send-only. Karpathy wiki and dashboards deferred.

## Required (TDD)

1. Default `post` using `fetch` + AbortSignal timeout. Never log the token. No getUpdates/webhook.
2. Gateway loader supplies that default post so CLI-loaded telegram can send against a **local mock HTTP server**, not api.telegram.org.
3. Tests: mock 200 ok + message_id → accepted; timeout/abort → commit-unknown no retry; token not in errors.
4. Existing 105 tests stay green.

No live Telegram, pairing, WhatsApp/Slack this slice, no push. 40 minutes. Evidence docs/evidence/channels/. Local commit.
