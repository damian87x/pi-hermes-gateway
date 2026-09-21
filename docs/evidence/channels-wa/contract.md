# Channel slice 2 — WhatsApp send-only adapter

Previous slice: Telegram default HTTP at 97a9ea9, 109 tests, mock HTTP only.

Inspiration: Baileys send-text; discard inbound. Untrusted third-party code.

## Required (TDD)

1. `packages/adapter-whatsapp`: private npm, no `pi` key, no Pi peers. `adapterId` whatsapp. send.text only.
2. Inbound discarded: no store, reply, or read-marking.
3. Tests use a fake socket/send function, not a live WhatsApp account and not the existing auth directory.
4. Timeout/unknown send → commit-unknown, no auto-retry. Token/session secrets never logged.
5. Gateway loader can load it like telegram. Fake remains default.
6. Existing tests stay green.

No live QR, pairing, credential copy, Slack, dashboard, push. 40 minutes. Evidence docs/evidence/channels-wa/.
