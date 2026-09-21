# pi-hermes-gateway-adapter-slack

Provisional local workspace package. Unpublished. The name does not claim an npm scope.

Send-only Slack `chat.postMessage` adapter for the gateway daemon. No Events API, no Socket Mode, no Pi manifest, no Pi peers. Default `post` uses `fetch` + AbortSignal timeout; the gateway loader injects it. Tests use a local mock HTTP server, not slack.com. Tokens are never logged.
