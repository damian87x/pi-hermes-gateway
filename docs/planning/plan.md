# Pluggable Pi Messaging Gateway — draft for Ralplan review

Status: **RALPLAN APPROVED — Fable 5.1 critic OKAY, round 2 (2026-09-20).** Planning complete; no implementation/activation authority. Read with `brief.md` and the research reports in this directory. Names below are logical package names; npm scope/availability must be selected before publication, not guessed as already owned.

## 1. Decision and success condition

Use one TypeScript npm-workspaces monorepo with separate publishable packages. Build a small new gateway core rather than adopt gamalan's whole extension or port Hermes. Reuse proven contracts and explicitly licensed presentation components where technically possible; do not assume the installed Telegram extension is an injectable transport library.

The daemon, not a coding TUI, owns a configured channel's network connection and credentials. Closing every interactive Pi session must not prevent an authorised scheduled message or isolated report job from being delivered. A user may attach a Pi session through a local companion; attachment is not required for static sends or scheduled worker execution.

Non-goals: change Lushsoft jobs; auto-migrate credentials; install services during npm/Pi installation; promise exactly-once remote delivery; implement all channels in core; recreate the full pi-telegram feature set in the MVP; claim a trusted Node process is a security sandbox.

## 2. Package graph and proposed new repository

Proposed future checkout: a NEW sibling repository `pi-messaging-gateway` (not implementation files in billioner-coder). The implementation agent must first confirm an unused destination and owned npm scope. All paths in this section are NEW, relative to that checkout.

- `packages/protocol/`: versioned JSON wire schemas, adapter types, capability declarations, no process singletons or secrets. Ordinary npm library.
- `packages/gateway/`: daemon binary, config validation, Unix socket server, routes/authorization, durable SQLite jobs/outbox/receipts, adapter loader, health, supervisor templates. npm-only, no `pi` manifest or Pi peers. The daemon installs into an operator-managed versioned prefix separate from Pi's package directory; systemd must not point into `~/.pi/agent/npm/`. Core is independently installable; Pi installation is through its separate companion.
- `packages/adapter-telegram/`: daemon-side Bot API transport; M1 send-only, no polling/webhook changes; M3 sole receiving owner for its bot profile; later send/edit/file/keyboard/typing capabilities and callback/inbound normalization. No Pi session implementation.
- `packages/adapter-whatsapp/`: daemon-side Baileys transport; sole auth-directory/socket owner; text/media receipts and inbound normalization. Baileys in production dependencies. Routine stop disconnects, never logs out/unlinks.
- `packages/pi-companion/`: Pi extension and socket client, M1 `/gateway` status and owner-route tools for authorised jobs/delivery; M3 attach/detach maps Pi session lifecycle into attachments. No bot token/Baileys credentials, no pollers. Standalone daemon runs without it.
- `packages/telegram-companion/`: optional Pi presentation integration—Telegram-specific view/actions/activity/voice/Generative Apps features, layered on protocol + gateway client. It does not own Telegram networking. Existing pi-telegram public APIs are inspiration/integration candidates, not an assumed cross-process transport seam.

These are target boundaries, not a requirement to create every package at S0. Create `telegram-companion` only at M4. Protocol and adapters exchange plain structural data, never cross-package classes, Symbols, `instanceof`, or singleton identities. Version `adapterApiVersion` separately from IPC `protocolVersion`. Start with these boundaries, not an additional plugin marketplace or generic DI framework. Core includes fake/file adapters for tests only; no transport dependencies. Rich WhatsApp companion is deferred unless actual WhatsApp-specific Pi presentation needs justify it.

Single writer/owner per package lane. Shared protocol reviewed before parallel implementation. One shared release train initially; packages remain independently installable and versioned with aligned versions to simplify compatibility. Split release cadence only when needed.

## 3. Two different plugin systems

Pi discovers extension resources through `package.json.pi.extensions` when the operator runs `pi install`. Gateway discovers daemon adapters through its OWN explicit local config. Pi installing an adapter does not automatically authorise loading it into a daemon.

Each adapter exports a compiled ESM entry and a static manifest: `adapterId`, `adapterApiVersion`, `capabilities`, `configSchemaVersion`. Its lifecycle is `start(context, config)`, `stop(reason)`, `send(envelope)`, optional `edit`, `health`; core passes stable IDs, cancellation and a logging interface with redaction. No global registry shared through npm module identity.

Gateway-owned plugin directory with a package manifest/lockfile is separate from Pi's extension module roots. Operator installs an exact package version there and explicitly registers the package name/entry with the daemon. Loader resolves only registered packages in that directory, checks API-major compatibility before evaluation, rejects duplicate adapter IDs, and does not import arbitrary message-supplied paths. Dependencies are installed before start, never by an incoming chat/tool request. Adapters execute trusted native code with the daemon user's OS authority; the registry is not a sandbox.

Companions speak versioned IPC, not import another separately installed Pi extension's private singleton. Optional Pi APIs inside one host may be used only through documented registrations with a startup compatibility check. No bundled duplicate gateway/Telegram network owner.

## 4. Process, transport and session ownership

Gateway is one explicit OS-supervised service per profile, initially Linux systemd user service. Start/enable is a separate operator action; installation is passive. Terminal detach is not reboot survival. Doctor checks user linger and an absolute working Node path/native SQLite compatibility; enabling linger requires owner approval. Without linger, do not claim survival after logout. Before opening SQLite or binding a socket, take an exclusive Linux `flock` on a persistent profile lock file; hold it for daemon lifetime, never replace it. A second daemon exits nonzero without touching the active socket. Only the locked owner removes a stale socket. Recompute due occurrences from SQLite at startup and at most 60-second ticks, including after suspend; do not rely on long in-memory timers. Service restart recovers durable state; offline machine means no remote sends until restart/catch-up policy.

M1 defaults to a dedicated gateway Telegram bot/profile with an explicitly configured owner destination and separately approved reachability test (owner starts the bot first). It is outbound-only: zero `getUpdates`, webhook mutation, inbound storage or callback handling. Shared-token send-only is an optional separately tested mode, with shared rate-budget/token-duplication caveats; it does not own polling. M1b WhatsApp uses its own deliberately paired test profile/account, not the existing live auth store; discard socket inbound events without storing, replying or marking read. A second linked device is not assumed conflict-free—rehearse only with separate authority. Inbound/attachment capability is M3, not M1.

From M3 onward, one receiving connection owner per transport account/profile. New gateway credentials live in its own private profile store. Migration of an existing account requires a maintenance window: stop the existing connector without logout; verify it has released polling/socket ownership; pair/configure gateway explicitly; test; then disable the old connector for that profile. Do not reuse a live auth directory. A separate test bot/account is preferred. Rollback stops gateway before reconnecting the old owner; never run two pollers/sockets over one credential store.

Routes identify `profileId/adapterId/accountId/chatId/threadId?`; remote names/phone strings alone are not authority. Inbound event carries provider event ID, sender ID, conversation/thread identity, timestamp and normalized content. Route-to-worker mapping is persisted and allowlisted. Default inbound behavior is refuse until explicitly paired/allowed.

**M3, not MVP:** `attach` is a revocable lease for a particular Pi session and route. On disconnect, no silent transfer of conversation privileges to another process. Scheduled jobs use a configured isolated worker profile, not whichever TUI is active. Offline attached-chat requests either queue with expiry or receive an explicit unavailable response according to route policy; no hidden execution fallback.

## 5. IPC and security

Linux v1: Unix-domain socket under a mode-0700 profile directory, socket0600; no public HTTP listener. Verify directory/socket owner and mode at startup; fail closed on filesystem ownership/permission mismatch. Filesystem permissions protect against other OS users. Peer-UID checks are optional defence in depth, evaluated in S0 rather than an unimplemented mandatory native dependency. No tokens in argv/logs. v1 routes are owner-only and loaded from operator configuration at startup; no IPC method can create, expand or change routes. Every enqueue and send attempt has an audit row. This constrains accidental/confused-deputy requests through the gateway API; it is not a security boundary against same-UID hostile or shell-capable agents that can modify config/run the operator CLI. Do not invent credentials bound to npm package identity.

Wire requests contain `protocolVersion`, `requestId`, `method`, validated body and bounded expiry. Maximum frame size, method timeout, per-connection/per-route rate limits and max queued items apply. Reject unsupported versions, unknown methods, expired requests and unauthorized targets before looking up private conversation data. Responses use stable error codes without revealing whether an unauthorized chat exists. Short-lived leases and remote action capabilities belong to M3/M4 only.

**M3 inbound only:** pairing is operator-approved and bounded. CLI initiates a random 128-bit one-use challenge, short TTL (5 minutes), stored hashed; user sends it to the bot; CLI displays numeric sender/route for explicit local confirmation before binding. Apply per-sender/global throttles and bounded attempts; consume atomically; no trust from display names. Telegram callbacks bind nonce/action/session/route/user plus expiry; changing actions are single-use and stale/duplicate clicks fail closed. Webhook mode, if later enabled, requires authenticated origin/secret and update dedup; polling is initial Telegram mode.

**M2 worker only:** report jobs receive a frozen evidence packet and explicitly configured model/run budget; no tools in the initial worker. Model inference is separately authorized expenditure of subscription/quota, not implied by allowing delivery. No arbitrary shell commands or executable paths in chat-supplied job bodies. Internal trusted runner spawns registered worker profiles with argv arrays. Inbound text, documents, callbacks and upstream prompts are untrusted input, not host commands. Media has bounded size/type/path handling; no arbitrary host-file attachment through a remote request.

Static operator test sends and later reports to an approved owner route are separate from business/customer outreach permission. A gateway installation must not make existing local-only jobs send externally.

## 6. Durable scheduling and delivery

Core database owns jobs, occurrences, deliveries, adapters/account leases and audit receipts. Use migrations and a single writer service. Define SQLite transaction boundaries and recovery tests before daemon implementation. Refuse a database schema newer than the binary supports; back up before migration. Prefer forward repair over downgrade. If an operator explicitly restores a backup, restore in dispatch-disabled quarantine mode: quarantine every non-terminal delivery and all schedule occurrences due after backup time through recovery time as commit-unknown/skipped; do not infer that missing post-backup records were unsent. Require operator reconciliation before resuming. Add a rollback test where an already-sent post-backup delivery cannot be resurrected as queued.

Job methods: `job.create`, `job.list`, `job.pause`, `job.resume`, `job.cancel`, `job.inspect`. Delivery methods: `delivery.enqueue`, `delivery.inspect`; no model needed for a static send. Initial schedules: once-at UTC and daily local time with IANA zone, bounded end/max-occurrences. General cron parser is deferred until needed. Explicit DST policy: skip nonexistent local times; choose first fold occurrence only. Catch-up: default skip with missed receipt; optional one latest missed occurrence inside configured grace period. Never burst every missed slot.

Job spec fixes worker profile or static text, destination route, owner authorization, schedule/timezone, expiry, max-occurrences, timeout, evidence reference and delivery policy. Separate counters for due occurrences, worker starts/completions, accepted sends, remote-confirmed sends, unknown sends. A scheduled occurrence is not a guaranteed successful report.

Unique `(jobId, scheduledInstant)` key prevents duplicate occurrence admission. Transaction claims pending occurrence before dispatch; crash after claim creates interrupted occurrence, not invisible success. Worker result accepted only once into outbox by occurrence ID. Lease recovery may retry a proven-not-started job; uncertain worker starts/results become interrupted and need explicit retry policy/manual action. At-most-once attempt is safe default for side-effecting jobs; no-tools report generation may have separately bounded retries, recorded as attempts of same occurrence.

Every delivery has mandatory `notAfter`, greater than enqueue time and at most 24 hours later in v1; there is no forever/default-unbounded value. Check it at enqueue and immediately before transport dispatch. Queued items that expire during outage become `expired`, never sent late. Each adapter declares `maxTextLength` with its measurement/format rules and `receiptLevels`. Reject oversized payloads (no silent truncation or auto-chunking in M1/M1b); partial multi-message delivery requires a later child-receipt design. Add a per-account token bucket, per-route daily cap and persistent audit records as runaway-send fuses.

Outbox states: `queued -> dispatching -> accepted`; `confirmed` is an optional receipt level only where a provider can supply stronger evidence. Accepted is a valid completed dispatch state, not a wait for acknowledgements that may never arrive. Telegram success returns a Message (zero/nonstable ID treated separately); WhatsApp later acknowledgements may refine evidence, not trigger re-send. Definitive rejection -> failed; network timeout/crash after dispatch without authoritative outcome -> `commit-unknown`. Persist dispatch intent before calling transport. Delivery key is unique; adapter returns provider message ID and receipt evidence when available. Do not describe provider acceptance as recipient read. Retry only documented pre-send/definitively-rejected transient failures, honor retry-after, bounded backoff. Never auto-retry commit-unknown; operator can reconcile or explicitly reissue with new linked ID. No exactly-once network claim.

Cancellation prevents future dispatch but cannot recall a send already accepted; racing cancellation reports actual state. Remove/disable an adapter blocks its queued destinations without deleting jobs or guessing another channel. Scheduled data survives restart independent of interactive sessions.

## 7. Telegram feature composition and parity

Capability negotiation is explicit, additive within protocol major, with unsupported results/fallback visible. Core provides text/message identity; transport adapters implement network primitives; Pi/Telegram companions implement higher-level interactive behavior.

Parity inventory required before full migration:
- Text, streaming edits, Markdown/HTML safe formatting: adapter + Telegram renderer.
- Files/images/albums and size policy: adapter + authorized attachment service.
- Buttons/menus and callback acknowledgement: adapter primitives + companion action registry.
- Threads, reply ownership, session routing and leader/follower semantics: core route/attachment leases + companion mapping.
- Activity/status, errors and tool-progress views: companion emits events; adapter renders with throttling.
- Voice input/output: separate optional transcription/TTS providers configured explicitly; no implied provider spending.
- Generative Apps/custom plugin registrations: explicit bridge contract and capability tests; not promised by copying markup parsers.
- Approvals/permission prompts: explicit challenge mapping; no action merely because a callback was clicked.
- Scheduled reports/static notifications: core/outbox directly to daemon transport, no Pi companion required.

MVP is durable owner-only **static text delivery**, outbound-only, with pi-companion status/enqueue/job tools; no live leases. M1b adds the second real transport (WhatsApp), proving pluggability. M2 adds isolated report workers; M3 adds inbound/attach/pairing; M4 adds rich parity; M5 optionally cuts over an existing account. This phasing does not shrink the target modular product. It is NOT full pi-telegram parity. Later rich milestones cannot be marked done until per-feature recorded demonstrations pass. Existing plugin is not removed or called obsolete before an approved parity/cutover decision.

## 8. Implementation slices and tests

Milestone mapping: **M1 = S0 + S1 + S2 + S3 send-only + S6 initial release** (protocol/gateway/Telegram adapter/Pi companion); **M1b = S4 send-only + S6 WhatsApp release**; **M2 = W1 report worker**; **M3 = I1 inbound**; **M4 = S5 parity**; **M5 = optional existing-account cutover**. S6 applies at each publishable milestone, not only after every feature.

### S0 — contracts, licenses and compatibility packet
NEW root `package.json`, `packages/protocol/src/{wire,adapter,jobs,delivery}.ts`, `docs/{architecture,security,parity,migration}.md`, source attribution. Pin actual supported Pi/Node/package versions from local docs/tests. Gate: protocol schema tests, capability mismatch tests and package tarball contents design. S0 records the parity inventory; full approved parity gates S5, not basic core implementation. Check upstream licensing before copying code; license metadata alone is not a complete provenance audit.

### S1 — durable core with fake adapter
NEW gateway `src/{daemon,ipc,auth,adapter-loader,store,scheduler,outbox,cli}.ts`, migrations and fixture adapters. Gate: clock-controlled once/daily/DST/missed-slot tests; crash injection at claim/send/receipt boundaries; delivery notAfter and size rejection; per-account/per-route send fuses; filesystem ownership/mode rejection, fixed owner-route enforcement, unauthorized-route indistinguishable error, request expiry/dedup; no-model static enqueue and inspect. No IPC route creation. Suspend test: advance past two due slots and prove exactly the declared single latest catch-up or skipped occurrence receipts, not a send burst. Database restore/downgrade test: unknown post-backup sends remain quarantined, never automatically resent. No production transport yet.

### S2 — service lifecycle and Pi companion
NEW `packages/pi-companion/src/{extension,client}.ts` for status, owner-route enqueue/job tools and setup help; gateway service templates and doctor/status. Session attachment comes in M3. Gate: disposable home/profile, close every TUI, restart daemon, prove once/daily occurrence still fires to fake sink; second daemon fails while first stays healthy; missing linger warns/blocks logout-survival claim; absolute Node/native SQLite doctor checks; companion without daemon starts nothing; multiple Pi packages do not create singleton collisions. No install hooks or activation on extension import.

### S3 — Telegram daemon adapter
NEW adapter `src/{index,transport,render}.ts` plus isolated tests. Gate: mock Bot API suite and separately authorized dedicated test-bot rehearsal; zero getUpdates/webhook calls; Message receipt vs timeout unknown; notAfter and Unicode text limit rejection; close every coding TUI and deliver scheduled static text, repeat after restart. Shared-token alternative must separately prove existing pi-telegram remains healthy without daemon polling. Inbound/callbacks/pairing move to I1/S5; report text waits for W1. Existing account cutover is not required for M1.

### S4 — WhatsApp daemon adapter
NEW adapter `src/{index,connection,identity,inbound,send}.ts`; `inbound.ts` is a discard-only handler in M1b, not inbound execution. Gate: production-only dependency install loads Baileys; QR via supported API; stop preserves linked-device credentials; explicit logout is separate; LID vs phone identity tested; restart reconnect; fake/live-authorized scheduled static-send test with TUI closed; inbound events discarded without persistence/reply/read marking. No existing auth directory reuse or active-session takeover.

### W1 / M2 — isolated report worker (gateway-owned)
NEW gateway `src/worker/{runner,profiles,budgets,results}.ts`. Use a registered absolute Pi CLI/version and explicit provider/model, run an isolated child with extension, skills, context-file and prompt-template discovery disabled (`--no-extensions --no-skills --no-context-files --no-prompt-templates --no-tools` against verified installed CLI). Supply bounded evidence explicitly. No hidden session/TUI attachment, WhatsApp/Telegram extensions, arbitrary job executables, auto-model purchases or quota fallback without policy. Gateway package remains usable without Pi; model jobs refuse with a helpful missing-worker error until configured. Run workers in an empty gateway-owned cwd so project settings cannot auto-install packages. Worker profiles are fixed operator config, referenced by ID in IPC; evidence is passed by value with a size cap (no message-supplied file path). Doctor checks provider availability under the actual service environment without printing credentials and verifies all isolation flags before enabling the worker; unsupported flags fail closed with no unisolated fallback.

Owner separately approves worker model/quota use, per-job timeout/output cap and daily invocation budget; reject admission when exhausted, no auto-reset or upgrade. Child termination covers the owned process group; record interrupted/unknown outcomes honestly. Exactly one accepted result/outbox row per occurrence; no implicit send tool inside worker. Test a fake child first, then separately authorized no-tools model rehearsal; assert no ambient extensions/sockets, budget exhaustion, timeout cleanup, malformed/oversized output rejection, and restart at result handoff. These tests do not modify existing Lushsoft/nightly workers.

### I1 / M3 — inbound ownership and Pi attachments
NEW adapter inbound modules; gateway route inbox/update dedup, pairing registry and attachment leases; companion `session-attachment.ts`. Apply §4/§5 remote security contracts. Gate: owner identity binding, code expiry/replay/throttle, no default inbound execution, single receiver, disconnect/restart routing isolation, no event replay into a wrong session, expired messages and revoked attachments fail closed. Only then advertise two-way chat. No existing connector cutover unless separately authorized.

### S5 — rich Telegram companion
NEW companion `src/{extension,views,actions,threads,activity,apps,voice}.ts` only as features become implemented. Gate: parity matrix demos for every feature above; remote callbacks expire and reject replay; safe downgrade where unsupported; multiple session routing cannot cross recipients. Source reuse only after verifying actual public transport seam or documented fork scope.

### S6 — distribution and implementation closeout
Root CI + `scripts/release` and per-package pack tests. Gate: install packed production-only tarballs in clean disposable Pi/npm homes; daemon-side packages install in a home without Pi and pull in no Pi packages; worker availability remains optional; every package independently loadable; core works without adapters; missing/incompatible adapters fail visibly; companion without daemon gives helpful unavailable status. No bundling transport packages into core. Publish after human approval only.

## 9. Publishing strategy

One repository, npm workspaces, shared protocol tests/CI, aligned initial release versions. Publish compiled ESM/types, LICENSE/NOTICE, README, explicit `exports` and `files`; daemon supplies `bin`. Adapter runtime dependencies are real dependencies, never dev-only. Protocol package is ordinary stateless dependency; wire version, not npm singleton identity, governs compatibility.

Daemon-side protocol/gateway/adapters are ordinary npm packages with no `pi` key and no Pi peer injection. Only companions use `keywords: ["pi-package"]` and explicit `pi.extensions`; their Pi-bundled core peers follow official package docs. `pi-companion` owns setup/status help. Daemon and adapters install in a separate operator-managed prefix/plugin directory; no service ExecStart points inside Pi-managed extension installs. Optional model worker invokes a configured external Pi CLI; no Pi dependency is pulled into the daemon tarball. Adapter daemon entry is not a Pi extension factory.

User installation documentation must distinguish `pi install npm:<owned-scope>/<companion>@<version>` from installation/registration in the gateway plugin directory. Avoid a convenience all-in-one meta-package in v1. If one is added later, follow Pi's documented bundling/resource rules and prove it does not load duplicate network owners. Git subdirectory workspace installs are not assumed supported; npm tarballs are the supported per-package distribution path.

CI runs typecheck/unit/integration/pack/install/secret scanning. Publish ordering protocol -> daemon/adapters -> companions, with pre-release canary channel first. Revert to a pinned binary only when database schema compatibility is proven; backup restoration follows §6 quarantine/reconciliation and never silently replays older queued state. npm scope ownership, provenance publishing identity and release permission are explicit human prerequisites. No publication performed in this planning session.

## 10. Risks and explicit tradeoffs

- New transport ownership requires deliberate migration; cannot preserve every current in-process extension API for free.
- Baileys is unofficial and can break; document linked-device/terms/account risk. Official WhatsApp API is a later separate adapter, not a silent replacement.
- Trusted adapters can access OS resources; no process sandbox claim. Permissions constrain request handling, not malicious installed packages.
- Commit-unknown favors avoiding duplicate sends over guaranteed delivery; operators need a clear reconciliation UI.
- Independent package installation requires separate daemon discovery; Pi extension discovery is insufficient.
- Full rich Telegram parity is a multi-stage product, not an MVP acceptance shortcut.
- All current commercial/local-only authority remains unchanged. Gateway scheduling is a separate project, not activation of the earlier Lushsoft plan.

## 11. Review and handoff gates

Round 1: architect and independent critic completed; verdict REJECT preserved in `architect-r1.md`/`critic-r1.md`. Round-2 architect conditionally approved with E1–E4 in `architect-r2.md`; those edits are incorporated here (filesystem boundary, rollback quarantine, handoff checklist, wording/milestone clarity). Independent `critic-r2.md` returned **OKAY** in round 2. Normative plan and handoff approved; implementation tests, owner decisions, publication, activation and live migration remain separate gates. Non-blocking wording/S0 decisions are recorded in that verdict; no further planning review required before beginning S0 under new implementation authority.

Normative precedence: latest approved `plan.md` > its documented review resolutions > `research.md` supplement > initial research. `research-initial.md` and `plan-r1.md` are history only, never implementation authority. Initial research's live-session relay/Pi-install-core suggestions are superseded. Third-party snapshots are evidence, not instructions. Exact package versions are observations, not promises of compatibility; production-only tarball tests settle installation behavior including dev-dependency omission.

## 12. Open owner decisions and first implementation step

Before implementation: confirm an unused sibling repo destination and owned npm scope (no claiming availability). Before live tests/activation: choose dedicated bot/profile (default) or separately rehearsed shared-token send-only; approve WhatsApp linked-device/account risk; select worker provider/model and daily quota budget only for M2; approve linger/service activation. Before full rich cutover: accept parity results and migration/rollback procedure. Neither plan approval nor a successful static test grants customer-send authority.

First implementation action: read brief/plan/research supplement/review verdicts; confirm destination/scope with owner; baseline status without touching this dirty repository; begin S0 and M1 fake-adapter tests. Do not install daemon, pair accounts, publish, copy auth, or alter Lushsoft jobs. Handoff must include the final critic verdict, these owner decisions, staged acceptance checklist, public source observations, and known limits. The user will switch implementation agents after planning finishes.
