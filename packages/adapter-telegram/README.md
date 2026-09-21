# pi-hermes-gateway-adapter-telegram

Provisional local workspace package. Unpublished. The name does not claim an npm scope.

Send-only Telegram Bot API `sendMessage` adapter for the gateway daemon. No `getUpdates`, no webhook mutation, no Pi manifest, no Pi peers. Default `post` uses `fetch` + AbortSignal timeout; the gateway loader injects it. Tests use a local mock HTTP server, not api.telegram.org. Tokens are never logged.
