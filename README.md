# pi-hermes-gateway

Local unpublished TypeScript workspace for an independently installable Pi messaging gateway. Names here are provisional; they do not claim an npm scope.

## Owner steps: first live sends

Nothing is sent until you reply `go`.

### Telegram — [issue #10](https://github.com/damian87x/pi-hermes-gateway/issues/10)

1. Use `$HOME/.config/pi-hermes-gateway/pilot` as the profile directory.
2. In its `config.json`, fill `adapter.config.token` and
   `routes[0].chatId` with your private values.
3. Set the config file permissions:
   `chmod 600 "$HOME/.config/pi-hermes-gateway/pilot/config.json"`.
4. Check the profile:
   ```sh
   pi-hermes-gateway-core \\
     --profile "$HOME/.config/pi-hermes-gateway/pilot" doctor
   ```
5. Reply `go` when ready. Keep the token and chat ID private.

### WhatsApp — [issue #12](https://github.com/damian87x/pi-hermes-gateway/issues/12), after Telegram

1. Use the separate profile `$HOME/.config/pi-hermes-gateway/whatsapp-pilot`.
2. As owner, pair a fresh linked device into its `whatsapp-auth`
   folder using the provider's QR or one-time-code flow.
3. Put your recipient JID in `routes[0].chatId` in that profile's
   private `config.json`.
4. Unofficial automation or linked devices can risk account restriction
   or a ban; proceed only if you accept that risk.
5. Check the profile:
   ```sh
   pi-hermes-gateway-core \\
     --profile "$HOME/.config/pi-hermes-gateway/whatsapp-pilot" doctor
   ```
6. Reply `go` when ready. Keep the JID private.

S0 ships `packages/protocol` (stateless validators). S1 adds `packages/gateway`: durable `node:sqlite` core, clock-injected scheduler, and a fake adapter as the default send adapter. S2/S3 add `packages/pi-companion` (Pi socket client; unavailable without a daemon) and `packages/adapter-telegram` (send-only `sendMessage`, mock HTTP). Gateway also ships `pi-hermes-gateway-core --profile DIR doctor` (absolute Node, CLI realpath, `node:sqlite`, profile lock/socket dirs; linger is a precondition only; `logoutSurvivalClaim` requires linger **and** user-unit evidence; does not enable linger) plus a systemd user unit **template** only (`packages/gateway/systemd/`; never `systemctl enable`). S6 pack tests install production tarballs in a disposable npm home (no `npm publish`). S4 adds `packages/adapter-whatsapp` (send-only injected send; inbound discarded). Slack send-only `chat.postMessage` is `packages/adapter-slack` (injected post, mock HTTP). `packages/dashboard` is a GET-only loopback HTTP viewer over profile SQLite jobs (host allowlist; no mutating HTTP). Jobs/deliveries may be created with `requireApproval` and stay `pending-approval` until owner-local `pi-hermes-gateway-core --profile DIR approve <id>`. `packages/wiki` compiles local `notes/*.md` into `wiki/articles/` and `wiki/concepts/` (deterministic; not a CMS or RAG). Fake stays default. No live network, tokens/session secrets in logs, `getUpdates`, live WhatsApp socket, live Slack workspace, or service enablement.

See `docs/architecture.md`, `docs/security.md`, `docs/parity.md`, `docs/migration.md`, and `docs/provenance.md`.
