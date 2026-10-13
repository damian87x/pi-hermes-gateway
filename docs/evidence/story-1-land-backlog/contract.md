# Story 1 (issue #4, G1) — land or close the unpushed lane backlog

HEAD after integration: `985d331` (fast-forward of `story/4-land-backlog` onto `feat/s6-local-8bbd23db`, base `origin/main` `54da8a9`).

## a) Integration method

`feat/s6-local-8bbd23db`'s merge-base with `origin/main` is `origin/main` itself (`54da8a9`), so no rebase conflicts
existed — the 12 commits applied as a clean fast-forward:

```
430f4f3 fix(gateway): complete local worker CLI delivery
5d93e8c Fix W1 worker result delivery persistence
ddc7405 fix(worker): atomically persist inert result delivery
f52206a Guard worker spawn against delivery races
a7b102f Fix worker spawn guard failure cleanup
6910669 test: verify S6 tarball identities
a9a8583 fix gateway S6 pack install isolation
38c9ab9 fail closed pending S6 execution boundary
549f987 fix S6 symlink resolver callable shape
c565a82 test(gateway): tighten packed adapter and companion coverage
918028b test: scan packed archive metadata for secrets
985d331 test: fix packed metadata canary fixtures
```

The first five commits (`430f4f3`..`a7b102f`) are byte-identical (same SHAs) to the tip of `feat/w1-worker-cli`,
confirming s6 is a strict superset of w1.

## b) Branch disposition

| Branch | `git cherry origin/main <b>` | Disposition |
|---|---|---|
| `feat/w1-worker-cli` (tip `a7b102f`) | all `+` | **Contained** — its 5 commits are identical SHAs inside `feat/s6-local-8bbd23db`, now on this branch. No separate action needed. |
| `feat/l2-cli` (tip `914541e`, 3 commits) | all `+` (not patch-identical to anything on main) | **Superseded, left unmerged.** Forks from `9004c6e` (2026-09-25), a commit that predates the `feat/s1-durable-core` merge (`febdd9e`). Merging it onto current `origin/main` diffs 52 files with 7,347 net deletions — it would regress the current worker CLI/companion code to a pre-S1 shape. The worker-CLI feature it adds (`job create` worker command, budget persistence) is re-implemented and completed by the s6/w1 commits already landed here. |
| `feat/l1-race` (tip `1c8c6e3`, 2 commits) | all `+` (not patch-identical) | **Superseded, left unmerged.** Same stale fork point `9004c6e`, same 54-file/7,360-deletion diff against current `origin/main`. Its duplicate-run guard and env-preservation fixes are superseded by the worker spawn-guard and delivery-persistence fixes in `f52206a`/`a7b102f`/`ddc7405`/`5d93e8c` already on this branch. |

Both `l1-race` and `l2-cli` are kept as-is in the legacy clone; this lane does not mutate them and does not merge them.

## c) Main test preservation

No test file was deleted or had cases removed by this integration (fast-forward only, no edits made in this lane).
`git diff --stat origin/main..HEAD` shows only additions/extensions to `cli-worker.test.ts`, `pack-install.test.ts`,
and a new `s6-verify.mjs` helper, plus `cli.ts`/`worker/run.ts`/`worker/runner.ts` product code.

## d) Validation run (this lane, single run, no concurrency)

Load average at run time: 1.6–4.3 (checked before `npm ci`, before `typecheck`, and before `npm test`; threshold 16 not hit).

```
NODE_OPTIONS=--max-old-space-size=4096 npm ci            # exit 0
NODE_OPTIONS=--max-old-space-size=4096 npm run typecheck # exit 0 (9 workspaces)
NODE_OPTIONS=--max-old-space-size=4096 npm test           # exit 1
```

`npm test` result: 273/274 gateway tests pass. One pre-existing test in the integrated content fails by design:

```
✖ s6 packed tarballs install in a disposable npm home without publish
  Error: UNPROVEN: approved task-owned product execution boundary is unavailable
```

This is not a regression introduced in this lane. The failing assertion comes straight from the s6 commits
(`38c9ab9 fail closed pending S6 execution boundary`, `a9a8583 fix gateway S6 pack install isolation`): the test
helper `requireUnprovenProductBoundary()` (`packages/gateway/test/pack-install.test.ts:69`) intentionally throws
until "an independently reviewed validator for actual owned controls" replaces it (code comment at the same line).
It is a fail-closed security gate the s6 branch itself shipped in this unfinished state, guarding real `npm`/`tar`/
`node` subprocess execution against unvalidated binaries — not a test this lane disabled, skipped, or weakened.
It was not touched in this lane. Implementing a real "approved execution boundary" validator is outside issue #4's
scope (it needs an owner-reviewed security control, not a mechanical rebase), so it is left exactly as the s6
branch committed it, failing closed, and reported here rather than bypassed.

The companion `--test-skip-pattern "s6 packed tarballs"` run (the first `npm test` sub-invocation for
`packages/gateway`) already excludes this one test name from the bulk suite by the project's own test script
(`packages/gateway/package.json`); the second sub-invocation runs `pack-install.test.ts` standalone and is where
the fail-closed canary fires.

The test script (skip pattern plus standalone invocation) is unchanged from `origin/main`. On `origin/main`'s
version of `pack-install.test.ts`, the same test called `npm`/`tar`/`find` directly via `execFileSync` with no
guard, and passed. The s6 branch's own commits replaced those direct calls with the fail-closed
`requireUnprovenProductBoundary()` wrapper as unfinished hardening — so this is a known, intentional regression
that the s6 content itself ships in this state, not something this lane introduced or could silently fix without
writing an unreviewed security control.

## e) Follow-up: real boundary validator implemented

Per a later review instruction, the permanent placeholder was replaced with a genuine, independently testable
validator rather than left untouched:

- `packages/gateway/test/s6-verify.mjs` now exports `requireOwnedTaskHome(resolver, ownerUid, taskHome)` (checks
  the supplied `S6_TASK_HOME` is absolute, canonical — no symlink ancestry — a real directory, and owned by the
  current uid) and `requireApprovedProductBoundary({ allowedExecutables, command, args, env, taskHome, realHome,
  registry })` (checks the command is in the pinned executable allow-list; denies `publish`/`systemctl`/
  `enable-linger`/`--enable` in any argument; denies any env key shaped like a token/secret/password; requires
  `HOME` to resolve strictly inside the owned disposable task home and never equal the real `HOME`; requires the
  npm registry to be the isolated offline sink). Both functions are pure and dependency-injected, following the
  file's existing `assertCanonicalPath`/`workspaceStageMap` convention.
- `runSelfTest()` in the same file gained synthetic-resolver assertions for every pass/fail branch of both
  functions; `node packages/gateway/test/s6-verify.mjs --self-test` prints `S6 pure synthetic checks passed`.
- New `packages/gateway/test/product-boundary.test.ts` exercises the same two functions through `node:test`
  (2 tests, all pass/fail branches), so the gate is proven inside the automated `npm test` run, not just a
  manually invoked script.
- `packages/gateway/test/pack-install.test.ts` now calls `requireOwnedTaskHome` once per test run and binds
  `requireApprovedProductBoundary` to every real `execFileSync` call via `runProductSubprocess`; the unconditional
  `requireUnprovenProductBoundary()` placeholder is gone.

### What this does and does not fix

With the real gate in place, `npm test` (no `S6_TASK_HOME` set, matching this repo's `.github/workflows/ci.yml`
and the local default) now fails at `requireOwnedTaskHome`: `UNPROVEN: S6_TASK_HOME is not an explicitly supplied
owned task home` — a genuine, correctly-reasoned fail-closed result, not a permanent placeholder.

Setting `S6_TASK_HOME` to an owned disposable directory and re-running `pack-install.test.ts` directly shows the
gate itself now passes cleanly and execution proceeds into `bootstrapStaging` → `verifyCompiler` →
`verifyExecutableInputs`, which throws on a **separate, pre-existing** defect: `executable input changed:
/usr/bin/node`. The SHA-256 pinned for `/usr/bin/node` in this file (captured 2026-09-30 per commit `a9a8583`)
no longer matches the binary actually installed on this machine today. This is unrelated to the boundary gate
and was not introduced by this lane.

Two separate, pre-existing, unresolved facts block a fully green run of this one test, neither fixable by test‑
fixture or gate-logic changes:

1. **CI cannot supply the required owned task home.** `.github/workflows/ci.yml` runs `npm test` with no
   `S6_TASK_HOME` set, so this test fails closed by design on every GitHub Actions run (confirmed against the
   actual failing runs on this head via `gh run view`, which show the identical error at the identical line,
   from `/home/runner/work/...`). Separately, `TYPESCRIPT` in `pack-install.test.ts` is hardcoded to
   `/home/damian-linux/workspace/billioner-coder/apps/oh-my-agents/node_modules/typescript`, an absolute path on
   one engineer's workstation that does not exist on a hosted runner.
2. **The pinned executable hashes are stale even on the reference machine.** `/usr/bin/node`'s SHA-256 no longer
   matches `EXECUTABLE_HASHES` as pinned in the s6 commits, so `verifyExecutableInputs()` fails honestly even when
   `S6_TASK_HOME` is supplied locally.

Both require an owner-authorized action this lane will not take unilaterally: re-pinning the trusted toolchain
hashes after genuinely verifying the new binaries, and deciding how (or whether) this test's toolchain should be
made CI-portable (vendor a manifest, parameterize the path, or keep this check as a local-only verification step
run outside `npm test`). Re-pinning hashes or relocating the path without that review would silently weaken a
supply-chain integrity control — exactly what `requireUnprovenProductBoundary`'s original comment warned against
— so this lane implemented the real gate and left the deeper pin data untouched.

### Validation after the fix

```
NODE_OPTIONS=--max-old-space-size=4096 npm ci            # exit 0
NODE_OPTIONS=--max-old-space-size=4096 npm run typecheck  # exit 0
NODE_OPTIONS=--max-old-space-size=4096 npm test           # exit 1 (275/276 pass; same one test, new honest cause)
node packages/gateway/test/s6-verify.mjs --self-test      # "S6 pure synthetic checks passed"
S6_TASK_HOME=<owned dir> node --experimental-strip-types --test packages/gateway/test/pack-install.test.ts
  # fails at verifyExecutableInputs (stale /usr/bin/node pin), proving the gate itself is no longer the blocker
```
