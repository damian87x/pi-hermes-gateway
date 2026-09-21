# Slice 6 — Karpathy-style local wiki

Previous slices: Telegram, WhatsApp, Slack adapters; GET-only dashboard; approvals CLI. 157 tests claimed.

Inspiration (public, untrusted): toolboxmd/karpathy-wiki — notes compile into articles + concepts, compounding local knowledge. Not a CMS. Not RAG cloud.

## Required (TDD)

1. `packages/wiki`: private npm, not a Pi package. Reads `notes/*.md`, writes `wiki/articles/` and `wiki/concepts/`.
2. Compile is deterministic. Empty notes → empty indexes. Unicode titles OK.
3. No network. No live send. Existing tests stay green.

40 minutes. Evidence docs/evidence/wiki/. Commit if tests pass. No push.
