# pi-hermes-gateway

Local unpublished TypeScript workspace for an independently installable Pi messaging gateway. Names here are provisional; they do not claim an npm scope.

S0 ships `packages/protocol` (stateless validators). S1 adds `packages/gateway`: durable `node:sqlite` core, clock-injected scheduler, and a fake adapter as the default send adapter. S2/S3 add `packages/pi-companion` (Pi socket client; unavailable without a daemon) and `packages/adapter-telegram` (send-only `sendMessage`, mock HTTP). S4 adds `packages/adapter-whatsapp` (send-only injected send; inbound discarded). Slack send-only `chat.postMessage` is `packages/adapter-slack` (injected post, mock HTTP). Fake stays default. No live network, tokens/session secrets in logs, `getUpdates`, live WhatsApp socket, live Slack workspace, or systemd.

See `docs/architecture.md`, `docs/security.md`, `docs/parity.md`, `docs/migration.md`, and `docs/provenance.md`.
