# pi-hermes-gateway-core

Provisional local workspace package. Unpublished. The name does not claim an npm scope.

S1 durable gateway core: SQLite jobs/occurrences/outbox/audit, clock-injected scheduler, structural send adapter (fake default). Telegram may be loaded via explicit module path. `requireApproval` jobs/deliveries stay `pending-approval` until `pi-hermes-gateway-core --profile DIR approve <id>`. Tick/dispatch do not send pending-approval rows. No live transports in-tree, no Pi manifest, no credentials.
