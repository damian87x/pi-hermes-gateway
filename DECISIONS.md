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
