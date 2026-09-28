# S2+S3 — Pi companion + Telegram send-only adapter

Owner: continue, create those plugins. Independent S1 ladder waived; product HEAD d9bb734 (critic self-fix). Conductor: Grok 4.6 implement, then critic may check+fix. No push, no live bot/token/pairing, no WhatsApp, no systemd enable.

## Scope

1. **Adapter seam (minimal):** Gateway talks a structural `send` adapter (plain objects), not `FakeAdapter` only. Fake remains default. No class/Symbol identity.
2. **`packages/adapter-telegram`:** npm-only, private, no `pi` key, no Pi peers. Send-only Bot API `sendMessage`. Zero `getUpdates`, no webhook changes. Mock HTTP tests. Commit-unknown on timeout. `notAfter`/size still enforced by gateway. Dedicated-bot config shape only (token never logged).
3. **`packages/pi-companion`:** Pi package (`pi-package` keyword + `pi.extensions`). Socket client for status, owner-route enqueue/job tools. No bot token, no poller. Without a daemon: report unavailable and start nothing.

Do not create telegram-companion (M4) or adapter-whatsapp (M1b). No install lifecycle scripts. No live Telegram rehearsal.

## AC

AC1. Both new packages private, independently packable. Telegram adapter installs in a home without Pi.
AC2. Gateway loads fake by default; can load telegram adapter via explicit config/module path without forking core types.
AC3. Telegram adapter never calls getUpdates/setWebhook; mock sendMessage success vs timeout unknown.
AC4. Companion import/session_start does not start a daemon or open Telegram.
AC5. Tests local only. npm test/typecheck/build green including existing 91 S1 tests.
AC6. Local commit on feat/s1-durable-core. Evidence docs/evidence/s2s3/. No push.

40 minutes. If both plugins cannot land honestly, land telegram adapter + seam first and BLOCKED remaining companion. TDD for send/unknown and companion-unavailable.
