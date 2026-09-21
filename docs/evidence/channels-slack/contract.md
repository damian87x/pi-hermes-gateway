# Channel slice 3 — Slack send-only adapter

Previous: Telegram HTTP 97a9ea9; WhatsApp send-only 34fbfc0 (122 tests claimed).

Inspiration: Slack `chat.postMessage`. Send-only, no Events API / Socket Mode in this slice.

## Required (TDD)

1. `packages/adapter-slack`: private npm, no `pi` key. adapterId slack. send.text.
2. Injected HTTP post like Telegram. chat.postMessage to a mock origin. Timeout → commit-unknown.
3. Token never logged. No live Slack workspace.
4. Gateway loader can load it. Fake remains default.
5. Existing tests stay green.

No pairing, no dashboard yet, no push. 40 minutes. Evidence docs/evidence/channels-slack/.
