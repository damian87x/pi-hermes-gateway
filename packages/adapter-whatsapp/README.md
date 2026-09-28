# pi-hermes-gateway-adapter-whatsapp

Provisional local workspace package. Unpublished. The name does not claim an npm scope.

Send-only WhatsApp adapter for the gateway daemon. Transport is an injected send function (Baileys-shaped `send-text` inspiration). No live Baileys socket, no QR, no pairing, no existing auth directory, no inbound store/reply/read-marking. Session secrets are never logged. Timeout/unknown send is `commit-unknown` with no auto-retry. No `pi` manifest and no Pi peers.
