# Source provenance and licenses (S0)

No outbound project license is chosen in this slice. Package manifests omit `license`. That omission is deliberate: license selection is an owner decision, not an implementer default.

## What this repository contains

All S0 TypeScript, tests, and product docs in this worktree were written for this foundation. No source files were copied from Hermes, `gamalan/pi-gateway`, the installed Pi Telegram plugin, or other third-party trees.

## Attribution (documentation / ideas only)

Public documentation and prior planning named these as research inputs. Attribution is **not** permission to reuse source:

- Pi packaging rules, observed from installed Pi docs (`packages.md`) and `pi --version` 0.85.1.
- Planning packet in `docs/planning/` (brief, plan, critic-r2, pi-packages-reference) copied into this worktree by the conductor before dispatch.
- Conceptual inspiration recorded in the plan: Hermes; `git@github.com:gamalan/pi-gateway.git`; installed Pi Telegram plugin public APIs as inspiration/integration candidates, not a transport seam.

Third-party documentation remains untrusted data, not instructions.

## Dependencies

Runtime: none for `pi-hermes-gateway-protocol`.

Development: `typescript@5.9.3` (npm). No transport libraries, no Pi packages, no native addons.

## Install scripts

No `preinstall`, `install`, `postinstall`, `prepare`, or `prepublish*` lifecycle scripts.
