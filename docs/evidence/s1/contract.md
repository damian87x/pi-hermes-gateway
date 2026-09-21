# Gateway S1 — frozen conductor contract

## Human authority

Prior conductor map remains in force: Grok 4.6 workers; native Claude CLI Opus reviews through Herdr; parent consumes compact summaries and yields until completion messages; no background wait/polling jobs; local commits only.

User, after S0 closeout and the S1 expiry recommendation, said:
> continue then

Frozen owner ruling for this lane: **job-created delivery `notAfter` anchors to `scheduledInstant`**, not to catch-up/enqueue/restart time. A restart must not mint a fresh 24h window for a stale occurrence.

Bounded interpretation, announced before dispatch: implement S1 durable core with a **fake adapter only**. Private/unpublished workspace packages. Local tests, local commits. No push/PR/merge/release, no live Telegram/WhatsApp, no real bot tokens, no service/linger activation, no pairing, no credential reads, no model-report smoke, no customer/business sends, no other-project edits. No architecture rewrite. No goal-mode.

## Model and review map

Unchanged from S0: Grok 4.6 implements; independent native Opus reruns gates and four fresh review stages (code safety, spec, origin/AC skipping the implementation plan, observable S1 outcome). No combined verdict. No model fallback.

## Lane inventory and baseline

Only S1 is admitted for mutation. S2 companion/lifecycle, S3 Telegram, S6 publishing, WhatsApp and M2–M5 stay later.

- Repository: /home/damian-linux/workspace/billioner-coder/apps/pi-hermes-gateway
- Isolated worktree: /home/damian-linux/workspace/billioner-coder/apps/pi-hermes-gateway-s1
- Branch: feat/s1-durable-core
- Base for this lane: feat/s0-foundation at `83341eb` (evidence commit). Frozen **product** S0 SHA remains `82d0de5dae6229ff0983267e4b26bdafe99a4178`; do not rewrite S0 reviews as applying to S1.
- Origin/main still `4035d5b60c4ed611f9a81b2f9ca850682b62fb7b`.
- One writer. Do not modify the main clone, S0 worktrees, or sibling projects.
- Product allowlist: `packages/gateway/**`; root workspace `package.json` / lock / tsconfig / `.gitignore` / README only as required to add the gateway package; `docs/architecture.md`, `docs/security.md`, `docs/parity.md`, `docs/migration.md`, `docs/provenance.md`; `docs/evidence/s1/**`. Protocol changes only if a failing S1 test proves an S0 validator cannot express scheduledInstant-anchored `notAfter`; prefer computing `notAfter` in the gateway. No empty future packages (no telegram/whatsapp/companion packages). No install/lifecycle scripts, no Pi manifest/peers on daemon packages, no git hooks, no systemd units, no external Git writes.

## Frozen S1 policies (do not re-open)

1. **Expiry:** For job-created deliveries, `notAfter = scheduledInstant + bound`, bound ≤ 24h. Check at enqueue and immediately before dispatch. If dispatch time is past that instant, mark `expired` — never send late. Operator static `delivery.enqueue` keeps protocol now-relative `notAfter` (mandatory, ≤24h from enqueue clock).
2. **Catch-up:** Default **skip** missed slots with a missed/skipped receipt. Optional **one latest** missed occurrence may run only if it is still within its scheduledInstant-anchored `notAfter`. Never burst every missed slot. DST: skip nonexistent local times; first fold occurrence only.
3. **Restore:** Refuse a newer schema than the binary. Backup before migrate. Explicit restore starts dispatch-disabled quarantine: non-terminal deliveries and occurrences due after backup time through recovery become `commit-unknown` or `skipped`. Do not infer missing post-backup rows were unsent. Already-sent post-backup deliveries must not resurrect as `queued`. Audit rows are preserved; do not delete history to “repair”.
4. **SQLite:** Use Node built-in `node:sqlite` on the observed Node 24 runtime. If it is unusable in this worktree, BLOCKED with evidence — do not silently add a native addon.
5. **Transport:** Fake/file adapter only. No network. Adapter declares `maxTextLength` and `receiptLevels` including `accepted`. No auto-chunking. `accepted` is a valid terminal dispatch state. `commit-unknown` is never auto-retried.
6. **Authority:** Owner-only routes loaded from startup config. No IPC/API method creates, expands, or changes routes. Unauthorized targets return an indistinguishable error. Every enqueue/send attempt writes an audit row. Filesystem owner/mode on profile dir + socket is the boundary; peer-UID is not required.
7. **Lifecycle in tests:** Exclusive `flock` on a persistent profile lock before opening SQLite or binding the socket. Second daemon/process on the same profile exits nonzero and must not disturb the first socket. Recompute due occurrences from SQLite at start and on a tick ≤60s. Clock is injected in tests; do not rely on wall-clock sleeps for DST/suspend proofs.

## Acceptance criteria

AC1. Private npm `packages/gateway` exists, independently installable, no `pi` key, no Pi peers, no transport dependencies. Core runs with the fake adapter only.
AC2. Durable SQLite schema for jobs, occurrences, deliveries, audit/receipts, with migrations, single-writer, backup-before-migrate, refuse-newer-schema, and restore-quarantine behaviour as frozen above.
AC3. Scheduler supports once-at UTC and daily local IANA time, unique `(jobId, scheduledInstant)`, claim-before-dispatch, skip-default catch-up plus optional one-latest-if-still-unexpired, DST skip/first-fold, suspend/clock-jump over two due slots produces the declared skip or single latest catch-up — never a burst.
AC4. Outbox: persist dispatch intent before fake-adapter send; crash/kill injection at claim, dispatch-intent, mid-send, and before receipt write never auto-replays `commit-unknown`; mandatory scheduledInstant-anchored `notAfter` for job deliveries; oversized payload rejected; per-account token bucket and per-route daily cap fuses with audit refusals.
AC5. Owner-only configured routes; no route mutation API; unauthorized route error is indistinguishable; request expiry/dedup; static no-model enqueue/inspect; profile lock/socket owner-mode checks; second instance fails closed.
AC6. Tests are clock-controlled and local. No live network, model, Telegram, WhatsApp, or real filesystem credentials. Independent packed gateway+protocol consumer can load the fake adapter path without Pi.
AC7. Worker records local commit, SHA/digest, gate table with commands/exits/counts/skips and project-relative raw logs. Independent Opus must rerun gates. No push/publication/activation.

## Gate inventory

- G1: containment vs allowlist from `83341eb`; both packages private; no lifecycle scripts; no pi key/peers; no future adapter/companion dirs.
- G2: `npm ci`, typecheck, build; record Node/npm/tsc/`node:sqlite` identities.
- G3: clock-controlled unit/integration tests for once/daily/DST/missed-slot/suspend, expiry, fuses, crash matrix, restore quarantine. Counts, zero silent skips.
- G4: pack gateway (and protocol as needed) into a clean temp consumer; fake adapter only; no Pi/transport pulled.
- G5: second-instance flock/socket test; unauthorized-route indistinguishable errors; no IPC route creation.
- G6: docs updated for S1 policies (scheduledInstant expiry, skip/one-latest catch-up, restore quarantine, node:sqlite). No license invention.
- G7: candidate SHA, base `83341eb`, diff digest, clean status or dirt inventory.

## Execution

40 minutes; last 5 for validation and local commit. If the full S1 gate list cannot land honestly in time, **do not claim PASS**: commit a coherent partial only if tests for the landed surface are green, and report BLOCKED with remaining AC/gates. Timeout is failure even if files survive. Up to three later technical-fix rounds after review; do not guess remaining owner policy.

Herdr pane runs the foreground CLI. Launcher writes a receipt and notifies the parent. Parent does not poll. Not an OS sandbox.
