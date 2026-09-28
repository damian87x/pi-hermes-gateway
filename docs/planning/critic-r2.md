# Critic R2 — Fable 5.1, native Claude CLI

Session: c1633819-d975-42e9-b526-06d4078dd8ce. Assistant text only.

**OKAY** (round 2). Every R1 blocker and E1–E4 is fixed in the text, and I found no regression that blocks handoff. The rest is wording cleanup and items the plan already sends to S0 or to a live rehearsal.

## R1 fixes 1–7: all in the plan

1. **Scope:**
   - M1 is outbound-only with a dedicated bot as the default.
   - It makes zero `getUpdates` calls, changes no webhook, and stores no inbound (§4 ¶2).
   - Pairing and callbacks sit under "M3 inbound only".
   - WhatsApp inbound is discarded without being stored, answered or marked read.
   - §7 says the phasing "does not shrink the target modular product".
2. **Worker is explicit (W1/M2):**
   - It is gateway-owned and runs an isolated child with all discovery and tools turned off.
   - Its working directory is empty.
   - Worker profiles are fixed in config.
   - Evidence is passed by value with a size cap.
   - Budgets need owner approval.
   - Each occurrence produces one outbox row.
   - Unsupported isolation flags fail closed.
   - The S3 and S4 gates are static text only; "report text waits for W1".
3. **npm-only daemon:**
   - The gateway has no `pi` key and no Pi peers, and it installs into an operator-managed prefix.
   - `ExecStart` never points into `~/.pi/agent/npm/`.
   - Only companions are Pi packages.
   - S6 tests installing in a home with no Pi.
   - The "passive adapter setup extension" is gone.
4. **Fixed routes:**
   - Routes are owner-only and loaded from config at startup.
   - No IPC method can create, expand or change them.
   - Unauthorized targets get an indistinguishable error.
   - Every enqueue and send gets an audit row.
   - §5 says plainly this is not a security boundary.
5. **Expiry, fuses and receipts:**
   - `notAfter` is mandatory, capped at 24 hours, and checked both at enqueue and immediately before dispatch.
   - Oversized payloads are rejected, with no truncation or chunking.
   - Each adapter declares `receiptLevels`, and `accepted` is a final state.
   - There is a per-account token bucket and a per-route daily cap.
6. **Lifecycle:**
   - The daemon takes an `flock` before opening SQLite or the socket, and a second daemon exits non-zero.
   - Doctor checks cover linger and an absolute Node path.
   - Due occurrences are recomputed on a tick of 60 seconds or less.
   - "Without linger, do not claim survival after logout."
7. **Handoff:**
   - §12 lists the owner decisions and the first step.
   - §11 sets the precedence order.
   - `research.md:3` carries a supersession banner, and `research-initial.md` and `plan-r1.md` are marked history only. The banner is an acceptable substitute for striking individual lines.

## E1–E4: all applied

- **E1:**
  - The filesystem is the boundary.
  - The daemon fails closed on an owner or mode mismatch.
  - The peer-UID check is optional and decided in S0.
- **E2 (rollback quarantine):**
  - The daemon refuses a newer schema and backs up before migrating.
  - A restore runs in dispatch-disabled quarantine.
  - In quarantine, non-terminal deliveries and occurrences due after the backup become commit-unknown or skipped.
  - S1 has a "cannot be resurrected as queued" test.
  - §9 ties any pinned-version revert to proven schema compatibility.
- **E3:**
  - The handoff has a per-milestone checklist and the cross-cutting R1 tests.
  - Verdict files are named, and the terminal-artifact note is there.
  - `telegram-api-reference.md` is annotated as pi-telegram's API and `telegram-bot-api-notes.md` as the Bot API source.
  - The slices are renamed W1 and I1.
- **E4:**
  - "Local companion" replaces "authenticated companion".
  - Rate limits are per-connection or per-route.
  - §2 capabilities carry milestone tags.
  - `inbound.ts` is marked as the discard-only handler.
  - The S1 suspend test is present, and `notAfter` has a bounded maximum.

## Scheduled sends have no TUI dependency

This holds across the plan:
- §1 and the last line of §6 state it.
- §7 routes scheduled notifications "core/outbox directly to daemon transport, no Pi companion required".
- The S2 and S3 gates run with every TUI closed and again after a daemon restart.
- The companion without a daemon "starts nothing".

## Non-blocking wording cleanup

Fix these during S0 docs; none needs re-review.
- The §4 ¶5 tag "M3, not MVP" also covers the sentence "Scheduled jobs use a configured isolated worker profile". That sentence is M2; split it out.
- §4 ¶4 needs an M3 tag. Its inbound-event and route-to-worker text is untagged.
- The §5 "M2 worker only" paragraph also holds inbound, callback and media rules, which belong to M3 and M4.
- The §2 `adapter-whatsapp` bullet has no milestone tags. S4 makes the scope clear anyway.
- `critic-r1.md:112` still cites artifact lines in `architect-r1.md`. The handoff says that file was re-extracted. I did not re-read it this round, so that claim is unverified; it is harmless either way.

## Approved files

- **Normative:** `plan.md` (the current revision) and `handoff.md`, under `brief.md` as the contract.
- **Evidence only:**
  - the `research.md` supplement;
  - `pi-packages-reference.md`;
  - `telegram-api-reference.md`;
  - `telegram-architecture-reference.md`;
  - `telegram-bot-api-notes.md`.
- **History only:**
  - `plan-r1.md` and `research-initial.md`;
  - `architect-r1.md`, `critic-r1.md` and `architect-r2.md`.
- **Record-keeping the parent must do** (no further review needed):
  - save this verdict as `critic-r2.md`;
  - change the status line in `plan.md` and the "Await…" sentence in §11;
  - update the DRAFT banner and the "Review state" section in `handoff.md`.

## Remaining gates (none blocks handoff)

**S0 decisions:**
- Whether to add the peer-UID check.
- Node's built-in SQLite versus a native addon.
- Whether `notAfter` on job-created deliveries anchors to `scheduledInstant` or to a catch-up enqueue time.
- Whether audit rows survive a database restore. An append-only log outside the database is one option.
- Whether recurring `job.create` from a tool needs a confirm dialog.

**Settled by tests, not assumed:**
- Whether production installs omit dev dependencies.
- The Pi CLI `--no-*` isolation flags.
- Provider credentials under a systemd user unit.
- Linger behaviour.

Linger behaviour is from my own knowledge, not the packet; architect R2 lists the other three as unverified in the packet. Pi 0.85.1 in the handoff is an observation to recheck.

**Live rehearsals, each under separate owner authority:**
- Reachability of the dedicated bot, including the owner starting the bot first.
- Shared-token send-only beside a healthy pi-telegram.
- Coexistence of a second WhatsApp linked device.
- Real delivery receipts.
- The M2 no-tools model run.

**Later milestones:**
- I1 (M3) and S5 (M4) need their own detail pass before they start.
- M5 needs owner-approved cutover with a rollback demonstration.
- Publishing, service activation and any customer send each need separate human approval.

I wrote no files, read nothing outside the packet, and ran no sends or commands.
