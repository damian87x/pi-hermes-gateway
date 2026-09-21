# pi-hermes-gateway

Local unpublished TypeScript workspace for an independently installable Pi messaging gateway. Names here are provisional; they do not claim an npm scope.

S0 ships `packages/protocol` (stateless validators). S1 adds `packages/gateway`: durable `node:sqlite` core, clock-injected scheduler (skip / one latest catch-up, scheduledInstant-anchored `notAfter`, restore quarantine), and a fake adapter only. No live transports or companions.

See `docs/architecture.md`, `docs/security.md`, `docs/parity.md`, `docs/migration.md`, and `docs/provenance.md`.
