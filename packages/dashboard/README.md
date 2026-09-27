# pi-hermes-gateway-dashboard

Provisional local workspace package. Unpublished. The name does not claim an npm scope.

GET-only HTTP viewer for a gateway profile SQLite database (`jobs`, `occurrences`, `deliveries`). Not a Pi package. No POST/PUT that enqueue, approve, or send. May list `pending-approval` rows. Collection failures return 503. Tests use a temp profile DB fixture, not a live daemon send.

Library only: there is no dashboard CLI or `bin`. A caller starts it with `createDashboard({ profileDir }).listen()`.

## Access control

- **Bind:** only a numeric loopback address, either `127.x.x.x` (dotted quad) or `::1`. Anything else, including `0.0.0.0`, `::`, LAN addresses and hostnames such as `localhost`, makes `createDashboard` throw before a server is created.
- **Host header:** unexpected `Host` values get 403 before anything else runs. This is defence in depth, not the credential.
- **Owner token:** `GET /api/status` needs `Authorization: Bearer <token>`. The dashboard checks the token before it reads the database. A missing or wrong token gets 401 and no database read. Tokens are compared as SHA-256 digests with `crypto.timingSafeEqual`. Tokens in query strings are not accepted.
- **Page:** `GET /` has no data and no token. It shows a password field. Each Load reads the token from that field, clears the field, and sends the token only as the `Authorization` header. Nothing is stored in the URL, cookies or web storage.
- **Methods:** anything other than GET gets 405.

## Provisioning the token

The token lives in `<profileDir>/dashboard.token`. It is read once when `createDashboard` runs. The dashboard refuses to start (throws) unless the file:

- exists and is a regular file (no symlink),
- is owned by the current user,
- has no group or other permission bits (for example mode `0600`),
- contains at least 43 base64url or 64 hex characters after trimming whitespace.

To generate it as the profile owner:

```sh
(umask 077 && openssl rand -hex 32 > "$PROFILE/dashboard.token")
```

The token is never passed on the command line or through the environment, and never logged. Error messages name the file, not its contents. To rotate it, rewrite the file and restart the dashboard.
