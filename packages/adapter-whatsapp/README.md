# pi-hermes-gateway-adapter-whatsapp

Provisional local workspace package. Unpublished. The name does not claim an npm scope.

Send-only WhatsApp adapter for the gateway daemon (`adapterId` `whatsapp`, `send.text` only). Inbound events go to `discardInbound`: no store, no reply, no read-marking. No `pi` manifest and no Pi peers.

## Transport: injected socket factory

`defaultWhatsAppSend(request, deps?)` is the sender the gateway loader injects. It runs over an **injected socket factory**: `deps.socketFactory({ authDir })` returns an object with `sendMessage(jid, { text })` and an optional `close()`. Per send it opens one socket at the profile-owned auth dir, sends the text, maps the returned message `key.id` to `providerMessageId`, and calls `close()` (a routine disconnect; the adapter never logs out or unlinks the device). A send that outlives `timeoutMs` is `timeout`; a socket that opens after the timeout is closed without sending.

Without `deps` the sender is **unconfigured**: it returns `{ kind: "unconfigured" }` synchronously, opens nothing, sends nothing, and the receipt is `commit-unknown` with reason `whatsapp-socket-unconfigured`. `createWhatsAppSend({ socketFactory, profileDir })` binds the deps once into a `WhatsAppSendFn` for `createAdapter(config, { send })`.

## Auth directory

Credentials live only at `whatsAppAuthDir(profileDir)` = `<profileDir>/whatsapp-auth`, a dedicated directory under the gateway profile. The path is derived, never configured: an `authDir` key in the adapter config is rejected. The user's existing WhatsApp session is never read, copied, or taken over. Linking a fresh device for that directory is an owner action outside this package.

## Owner-only pairing preflight (G9a)

Use a separate profile at `$HOME/.config/pi-hermes-gateway/whatsapp-pilot`; do not reuse an existing gateway or WhatsApp profile. Doctor checks that the profile and its `whatsapp-auth` child are real directories rather than symlinks, so the gateway cannot alias another session path. This check only inspects directory metadata; it does not read or create auth/session files.

This package does not implement pairing. The owner must pair a fresh linked device through the selected socket provider's QR or one-time-code flow, directed only to the new profile's `whatsapp-auth` directory. Do not capture or post pairing codes or auth contents. WhatsApp may restrict or ban accounts using unofficial automation or linked-device providers; proceed only after the owner accepts that risk.

Put the owner-provided recipient JID in `routes[0].chatId` in the private profile `config.json`; never put the JID in source, logs, screenshots, or evidence. After the owner has paired the new profile, run:

```sh
pi-hermes-gateway-core --profile "$HOME/.config/pi-hermes-gateway/whatsapp-pilot" doctor
```

## Runtime dependency

The packed tarball's only runtime dependency is `pi-hermes-gateway-protocol`. No WhatsApp socket library (for example Baileys) is declared or bundled; the operator supplies the socket factory from their own gateway plugin prefix. Rationale and rejected alternatives are in the root `DECISIONS.md` under "WhatsApp socket dependency".

## Receipts and tests

Timeout, unknown, missing message id, and thrown socket errors are `commit-unknown` with no auto-retry. Session secrets and the auth dir path are redacted from receipt reasons. Tests use only a fake in-memory socket: no network, no live WhatsApp account, no QR, no pairing, no existing auth directory.
