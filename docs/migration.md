# Migration and rollback (S0 + S1)

No live migration, pairing, or service activation is authorised in S0/S1.

## New profiles

M1 defaults to a dedicated gateway Telegram bot/profile with an explicitly configured owner destination. Shared-token send-only is a separately tested optional mode and does not own polling. WhatsApp (M1b) uses a deliberately paired test profile, not an existing live auth store.

## One receiving owner

From M3, one receiving connection owner per transport account/profile. New gateway credentials live in the gateway private profile store. Do not reuse a live auth directory.

## Existing-account cutover (M5 only)

Maintenance window: stop the existing connector without logout; verify it released polling/socket ownership; pair/configure gateway explicitly; test; then disable the old connector for that profile. Rollback stops gateway before reconnecting the old owner. Never run two pollers/sockets over one credential store.

## Database rollback quarantine

S1 implements: refuse schema newer than the binary; backup before migrate (`node:sqlite`, `PRAGMA user_version`). Explicit restore (`--restore BACKUP` / `startDaemon({ restoreFromBackup })`) copies the backup under the profile lock and quarantines before any tick: missing and non-terminal occurrences in (backup, recovery] become `skipped`/`commit-unknown` and watermarks advance to recovery. Dispatch stays disabled until an explicit operator `--resume-dispatch` / `resumeDispatch()` after reconciliation. Already-sent post-backup deliveries must not return to `queued`. Audit history is not deleted to “repair”. Revert to a pinned binary only when schema compatibility is proven.

## Distribution

Daemon-side packages (protocol, gateway; later adapters) are ordinary npm packages: no `pi` key, no Pi peers, installed in an operator-managed prefix — never `ExecStart` into `~/.pi/agent/npm/`. Companions are the only Pi packages. npm scope, provenance publishing identity, and release permission are owner prerequisites. No publication in S1.
