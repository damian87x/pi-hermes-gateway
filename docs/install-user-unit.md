# Render and install a gateway user unit

Run the repository's `scripts/install-user-unit.mjs` with a trusted Node (24.20.0 or newer), outside the Pi agent npm prefix. This is an explicit operator tool, never an npm postinstall hook. No host services were installed or activated during implementation/tests.

`--profile NAME` accepts 1–64 letters, digits, underscores or hyphens, starting with a letter or digit. The profile directory is `$HOME/.config/pi-hermes-gateway/NAME`; the unit is `$HOME/.config/systemd/user/pi-hermes-gateway@NAME.service`, not `hermes-gateway.service` or `openclaw-gateway.service`.

`--prefix DIR` identifies a built checkout (`packages/gateway/dist/cli.js`), a gateway package directory (`dist/cli.js`), or an npm install prefix (`lib/node_modules/pi-hermes-gateway-core/dist/cli.js`), in that order. Paths are resolved absolutely and quoted for systemd. Node is pinned to the rendering process's absolute executable path. Missing builds and paths under a literal or symlinked Pi agent npm prefix are rejected.

## Inspect first (no writes or service commands)

After building the gateway and its protocol dependency:

```sh
node scripts/install-user-unit.mjs --profile pilot --prefix "$PWD"
```

The default (also explicit `--dry-run`) prints the rendered template and does not create directories, write a unit, or invoke systemctl. Inspect `ExecStart` before installing. Rerender after moving the prefix or replacing Node.

## Passive installation

Only after operator approval, add `--install` to write the unit. This does not reload, enable, or start anything. It replaces the same profile's existing unit; save that file first if it contains manual changes. Create the profile directory with mode 0700 and provide its `config.json` separately; the installer does not create profile configuration or credentials.

### Token-bearing adapter configuration

The operator owns the external `<PROFILE>/config.json`; never put it in the checkout or include its values in logs, screenshots, or evidence. When `adapter.config.token` is present, `doctor` requires the file to be owned by the current user with mode 0600 and reports no configuration contents. Route values such as `routes[0].chatId` must be supplied by the owner; do not infer them. Fake-adapter checks do not require a real token or chat id and do not authorize a live send.

After the owner has filled the required values in the external profile, run:

```sh
pi-hermes-gateway-core --profile <PROFILE> doctor
```

Doctor only reports checks; it does not load an adapter, send a message, or enable a user unit.

For a safe installation rehearsal, use a temporary HOME and **only** passive installation:

```sh
sandbox=$(mktemp -d)
HOME="$sandbox" node scripts/install-user-unit.mjs --profile pilot --prefix "$PWD" --install
cat "$sandbox/.config/systemd/user/pi-hermes-gateway@pilot.service"
rm -rf "$sandbox"
```

## Enable is a separate explicit decision

`--enable` writes the unit, then runs `systemctl --user daemon-reload` and `systemctl --user enable pi-hermes-gateway@NAME.service`. It never starts the service (`--now` is not used). A service-command failure exits nonzero; the written unit remains for inspection. **Changing HOME does not isolate a real systemctl from the host user manager.** Do not rehearse `--enable` without a mocked systemctl; the automated tests use a sandbox-local shim.

Starting the service is a separate operator action, outside this installer. Neither rendering nor installation enables linger. Linger requires separate owner approval; do not claim logout survival without it.

## Doctor evidence

Run the built CLI with `--profile "$HOME/.config/pi-hermes-gateway/pilot" doctor`. Doctor automatically looks for `pi-hermes-gateway@pilot.service` in the user-unit directory. With that file, enabled linger, and passing hard checks, its JSON reports `unitEvidence: true` and `logoutSurvivalClaim: true`. Linger alone or the unit alone is insufficient. This is file/precondition evidence, not proof that systemd has enabled or started the unit; doctor makes no service changes and opens no gateway socket.

For rollback, remove only this profile's rendered unit after separately arranging any necessary service shutdown/disable with operator approval. Do not alter the existing Hermes or OpenClaw units.
