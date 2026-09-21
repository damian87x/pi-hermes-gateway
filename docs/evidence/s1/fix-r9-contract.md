# S1 technical correction 9 — conductor ruling

Owner: fix and move on under conductor.
Start a55da121a67532d3f206ac29a81de2c4ecbb01fb.
Opus r8 code-safety REJECT session c641cbdd-cb93-434e-bd9a-a2abea14be12.
Prior EPIPE and requestId Mediums independently verified fixed.

## Required (AC5)

Re-check `routeAllowed` against current startup config at tick admission and immediately before `adapter.send`. On failure: do not send; mark delivery refused/failed; occurrence skipped/refused; audit `delivery.send.rejected` with `invalid_route`.

Regression: job created on R2, reopen with routes [R1], tick past due → 0 sends + refusal audit. Same for a queued enqueue delivery.

Lows deferred. TDD first. Fresh Grok. 40 minutes. Evidence docs/evidence/s1/fix-r9/. No push.
