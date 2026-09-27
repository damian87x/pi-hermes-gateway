# Decisions

Logged defaults. Each entry records the policy the code implements; change the code and this entry together.

## Fuse debit timing (existing policy, recorded not changed)

- Operator `delivery.enqueue` debits the per-account token bucket and the per-route UTC-day cap once, at admission, in the same transaction as its delivery row. This includes rows admitted as `pending-approval` and rows already `expired` at admission.
- Approval and dispatch of an enqueued row do not debit again.
- Scheduled job deliveries debit at dispatch, not at occurrence admission.
- The UTC day charged is the admission day for enqueues, so it can precede the day the row is actually sent.

## Pre-send refusal of job deliveries

- A job delivery refused before send (`text_too_long` or `rate_limited`) is marked `failed`, its occurrence `skipped`, and a `delivery.send.rejected` audit is written, all in one transaction. The row is never retried or sent.
- The text-length check runs before the fuses, so a refused oversized job spends no token or daily-cap slot.
- If the refusal transaction fails, the row stays `queued` with its occurrence `claimed`, the outbox halts, and the next open re-evaluates it.

## Job pause and cancel against queued deliveries

- `job.cancel` marks the job `cancelled`, each of its `queued` deliveries `failed` with its occurrence `skipped`, writes one `delivery.cancelled` audit per row and the `job.cancelled` audit, and records the request, all in one transaction. Success is answered only after that commit; a failed write rolls all of it back and answers an error, so the same request may be retried.
- A job delivery already `dispatching` when the cancel lands is in flight and is left alone; its receipt (`accepted` or `commit-unknown`) is recorded as usual.
- `job.pause` does not touch deliveries. A paused job's unsent `queued` rows stay `queued`, across restarts, and are not dispatched until `job.resume`; after resume the next outbox pass sends a row still within its `notAfter` and expires one past it.
- Dispatch rechecks the owning job before claiming a job row, and writes the dispatch intent with one conditional update that requires the row still `queued` and its job still `active`. A cancelled job can never be resumed or paused back into dispatch.
- CLI `approve` checks and writes under one transaction, so a concurrent daemon cancel cannot be approved back into `active`.
