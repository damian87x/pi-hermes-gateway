# Architecture (S0 + S1)

Provisional local workspace. Package names `pi-hermes-gateway` and `pi-hermes-gateway-protocol` are identifiers only; they do not claim npm-scope ownership. Publication and scope remain an owner decision.

Historical planning checkout name `pi-messaging-gateway` is superseded by this repository (`pi-hermes-gateway`) as stated by the S0 contract.

## Current packages

`packages/protocol` (S0), `packages/gateway` (S1 durable core + structural send adapter; fake default), `packages/adapter-telegram` (S3 send-only Bot API `sendMessage`, npm-only), `packages/adapter-whatsapp` (S4 send-only injected send; no live socket), and `packages/pi-companion` (S2 Pi package socket client). Do not create telegram-companion here.

The protocol package is a stateless ESM library: compiled `dist` plus declarations, explicit `exports`/`files`, no Pi peer, no `pi` manifest, no transport dependency, no secrets, no runtime singleton, no class/`Symbol` identity, no import side effects. `protocolVersion` (IPC wire) and `adapterApiVersion` (adapter loader) are independent integers, both `1` in this slice.

## Process ownership (approved plan)

- The daemon, not a coding TUI, owns a configured channel's network connection and credentials.
- Closing every interactive Pi session must not prevent an authorised scheduled message or isolated report job from being delivered.
- A Pi session may attach through a local companion; attachment is not required for static sends or scheduled worker execution.
- Companions never own bot tokens or Baileys credentials and do not poll.

## Two loaders

1. **Pi loader:** `package.json.pi.extensions` when the operator runs `pi install`. Only companion packages are Pi packages.
2. **Gateway loader:** operator-managed plugin directory + explicit daemon config. Installing an adapter into Pi does not authorise loading it into a daemon. The loader resolves only registered packages, checks `adapterApiVersion` major compatibility before evaluation, and rejects duplicate adapter IDs. No global registry via npm module identity.

## Milestone map

- **M1** = S0 (this slice) + S1 durable core/fake adapter + S2 companion/lifecycle + S3 Telegram send-only + S6 initial release.
- **M1b** = S4 WhatsApp send-only + S6.
- **M2 / W1** isolated report worker.
- **M3 / I1** inbound ownership and Pi attachments.
- **M4 / S5** rich Telegram companion parity.
- **M5** optional existing-account cutover.
- S6 (distribution) repeats at each publishable milestone.

S0 is not M1 completion. S1 durable core with fake adapter is implemented in `packages/gateway`. S2 companion, S3 telegram send-only, and S4 WhatsApp send-only (injected send, inbound discarded) are implemented as separate packages; fake remains the gateway default. Live sockets, S5, and S6 are not implemented here.

## v1 protocol limits (concrete)

Measured on this library, not left as TODO:

| Limit | Value | Measurement |
| --- | --- | --- |
| `protocolVersion` | `1` | integer equality |
| `adapterApiVersion` | `1` | integer equality (independent axis) |
| max frame | 65536 | bytes of the transport frame supplied by the caller |
| max payload | 32768 | UTF-8 bytes of `JSON.stringify(body)` |
| max text | 4096 | ECMAScript string length (UTF-16 code units) |
| request `expiresAt` | `(now, now+60s]` | unix ms |
| delivery `notAfter` | `(now, now+24h]` | unix ms; mandatory, no unbounded default |
| methods | `job.create/list/pause/resume/cancel/inspect`, `delivery.enqueue/inspect` | allowlist |

Capability `send.text` is the only v1 capability string. Duplicate or unknown capability names are rejected. Adapters must declare `receiptLevels` including `accepted`.

The protocol package does not schedule, persist, or send. S1 `packages/gateway` owns SQLite persistence, scheduling, outbox, and the in-tree fake adapter.

## S0 decisions recorded from observed runtime

- **SQLite:** Node `v24.20.0` exposes `node:sqlite` (`DatabaseSync` import succeeds) and `process.versions.sqlite = 3.53.4`. S1 uses built-in `node:sqlite` (no native addon). Compatibility on other Node versions is **unverified**.
- **Peer-UID:** Evaluated. v1 security boundary is filesystem ownership/mode on the profile directory and socket (see `docs/security.md`). A native `SO_PEERCRED` check is **not** a mandatory dependency for v1. Optional defence-in-depth remains a later slice if it can be done without a new native addon.
- **Pi CLI:** `pi --version` observed `0.85.1`. The protocol package does not depend on Pi. Isolation flags and systemd-user credential behaviour stay unverified until W1/S2.

## S1 frozen policies (implemented in gateway, not by mutating S0 validators)

- **Expiry:** Job-created delivery `notAfter = scheduledInstant + bound` with bound ≤ 24h. Checked at occurrence admit and immediately before dispatch. Late items become `expired`, never sent. Operator `delivery.enqueue` keeps protocol now-relative `notAfter`. S0 `validateStaticDelivery` cannot express a future slot whose `notAfter` is more than 24h from enqueue-now; the gateway computes job `notAfter` and does not change the S0 validator.
- **Catch-up:** Default **skip** missed slots (missed/skipped receipt). Optional **one latest** missed occurrence runs only if still within its scheduledInstant-anchored `notAfter`. Never burst every missed slot. DST: skip nonexistent local times; first fold occurrence only.
- **Restore:** Refuse schema newer than the binary. Backup before migrate. Explicit restore starts dispatch-disabled quarantine: non-terminal deliveries become `commit-unknown`; occurrences due after backup through recovery become `skipped`. Already-sent rows are not resurrected as `queued`. Audit rows are preserved.
- **Transport:** Fake adapter is the default (`adapterId=fake`). Gateway talks a structural `{ manifest, send }` object (no class/Symbol identity). Telegram and WhatsApp send-only adapters load via explicit module path; WhatsApp uses an injected send function and discards inbound. `notAfter`/size stay gateway-enforced. No live network in this slice, no auto-chunking.
- **Lifecycle:** Exclusive Node-only SQLite lock on a persistent profile lock file before opening the gateway DB or binding the socket. Process death releases the lock. Second process on the same profile exits nonzero and must not disturb the first socket. Default daemon clock is the system clock; `tick()` runs at start and on an interval ≤60s. TestClock is injected only in tests.

## Open items deferred (not guessed)

- Whether recurring `job.create` from a tool needs a confirm dialog (companion).
- npm scope, outbound license, publication identity.

## Toolchain actually checked (this worktree)

- Node `v24.20.0` (`/usr/bin/node`)
- npm `11.19.0`
- TypeScript `5.9.3` (workspace `devDependency`; global `tsc` was `7.0.2` and is not the project compiler)
- `node:test` built-in
- No `@types/node` (protocol `tsconfig` lib is `ES2022` only)
