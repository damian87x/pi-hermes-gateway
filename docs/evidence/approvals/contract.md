# Slice 5 — approvals

Dashboard stays GET-only. Approvals are CLI/core, not HTTP mutate.

Inspiration: pairing confirmation; no action merely because a job exists.

## Required (TDD)

1. Jobs/deliveries can be created with `requireApproval: true` and stay pending until `gateway approve <id>`.
2. Tick/dispatch must not send pending-approval rows.
3. Approve is owner-local CLI against the profile DB. Dashboard may *list* pending (already GET). No dashboard POST approve.
4. Existing tests stay green.

No live send, pairing, publish. 40 minutes. Evidence docs/evidence/approvals/. Commit if tests pass.
