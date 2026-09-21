# Security (S0 + S1)

S0 ships validators. S1 adds a local daemon with SQLite (`node:sqlite`), a Unix-domain socket, owner-route checks, and a fake adapter. It does not load live transports or read credentials.

## Trust boundary

Wire requests are untrusted until `validateWireRequest` accepts them. Rejection uses stable error codes (`unsupported_protocol_version`, `unknown_method`, `expired`, `frame_too_large`, `payload_too_large`, `invalid_body`, `invalid_request_id`, `invalid_route`, `invalid_not_after`, `text_too_long`, `invalid_capability`, `duplicate_capability`, `unsupported_adapter_api_version`, `invalid_adapter_id`, `invalid_manifest`, `malformed`). Validators do not look up conversation existence. S1 IPC/in-process handling returns an indistinguishable `invalid_route` error for any well-shaped route that is not in the startup allowlist.

## Owner-only routes

v1 routes are owner-only and loaded from operator configuration at daemon startup. No IPC method may create, expand, or change routes. Route identity is `profileId/adapterId/accountId/chatId/threadId?`. Display names and phone strings are not authority. Default inbound behaviour (M3) is refuse until paired.

The protocol package validates route *shape*. It does not authorise routes. S1 authorises against owner-only routes loaded from startup config. No IPC method creates, expands, or changes routes.

## Filesystem boundary (v1 daemon, S1)

Linux v1: Unix-domain socket under a mode-0700 profile directory, socket 0600; the gateway daemon has no public HTTP listener. The optional `packages/dashboard` plugin is a separate GET-only loopback viewer (host-header allowlist; mutating methods 405; 503 on collection failure) and does not enqueue or send. Verify directory/socket owner and mode at startup; fail closed on mismatch. Exclusive Node-only SQLite lock on `profile.lock` before opening the gateway DB or binding the socket (no python3 helper). Filesystem permissions protect against other OS users.

This constrains accidental/confused-deputy requests through the gateway API. It is **not** a security boundary against same-UID hostile or shell-capable agents that can modify config or run the operator CLI. Do not invent credentials bound to npm package identity. No tokens in argv/logs.

## Peer-UID (S0 evaluation)

Peer-UID/`SO_PEERCRED` is optional defence in depth. S0 does **not** add a native dependency or treat peer-UID as mandatory. v1 remains filesystem ownership/mode.

## Expiry

- Requests: `expiresAt` strictly after validation `nowMs` and at most 60 seconds later.
- Deliveries: `notAfter` is mandatory, strictly after `nowMs`, and at most 24 hours later. There is no forever/default-unbounded value. S1 must check again immediately before transport dispatch. Queued items that expire during outage become `expired`, never sent late.

Job-created delivery `notAfter` anchors to `scheduledInstant` (plus a bound ≤ 24h), not catch-up/enqueue/restart time. A restart must not mint a fresh 24h window for a stale occurrence.

## Uncertain-send no-replay

Outbox: `queued -> dispatching -> accepted`. `confirmed` is optional where a provider can supply stronger evidence. Persist dispatch intent before calling transport. Network timeout/crash after dispatch without authoritative outcome is `commit-unknown`. **Never auto-retry commit-unknown.** Operator reconciles or reissues with a new linked ID. No exactly-once network claim. Cancellation cannot recall an already accepted send.

## Rollback quarantine (S1)

Refuse a database schema newer than the binary. Back up before migration. Prefer forward repair over downgrade. Restoring a backup runs dispatch-disabled quarantine: non-terminal deliveries and occurrences due after backup time through recovery time become commit-unknown/skipped. Do not infer that missing post-backup records were unsent. An already-sent post-backup delivery must not be resurrected as queued. Audit rows are preserved.

## Worker isolation and budget (M2 / W1, not S0)

Gateway-owned isolated child; discovery/tools off; empty cwd; evidence by value with a size cap; operator-approved model/quota/daily budget. Unsupported isolation flags fail closed. No arbitrary shell/executables in chat-supplied job bodies. Protocol v1 rejects non-`static-text` job kinds.

## Lifecycle and passive install

Installation is passive. Start/enable of the OS service is a separate operator action. No npm/Pi lifecycle install scripts, no git hooks, no service units in this slice. Without linger, do not claim survival after logout. Terminal detach is not reboot survival.

## Adapters

Adapters execute trusted native code with the daemon user's OS authority. The registry is not a sandbox. Duplicate adapter IDs are rejected. Capabilities are compared as strings, never by module-local `Symbol` or class identity.
