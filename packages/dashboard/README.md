# pi-hermes-gateway-dashboard

Provisional local workspace package. Unpublished. The name does not claim an npm scope.

GET-only HTTP viewer for a gateway profile SQLite database (`jobs`, `occurrences`, `deliveries`). Not a Pi package. No POST/PUT that enqueue, approve, or send. May list `pending-approval` rows. Binds to loopback by default. Unexpected `Host` headers are rejected. Collection failures return 503. Tests use a temp profile DB fixture, not a live daemon send.
