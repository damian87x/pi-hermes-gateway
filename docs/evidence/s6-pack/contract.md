# Slice — S2 lows + S6 pack tests

HEAD 3b396cb. Code-safety PASS. 173 tests.

## A. Patch S2 lows (TDD)

1. `logoutSurvivalClaim` only if linger **and** unit evidence, else lingerPrecondition-only / false.
2. Doctor path check uses `resolve(profileDir)` so `./p` is not a false escape.
3. Doctor also checks `realpath` of this CLI against `~/.pi/agent/npm` (fail/warn, do not enable).
4. Linger username from `os.userInfo().username`; reject `/` in the name.
5. Optional: StartLimitBurst on unit; post-send restart asserts no second fake send.

## B. S6 pack tests (TDD, no publish)

Packed tarballs in a disposable npm home: protocol/gateway/adapters/companion/dashboard/wiki independently importable. Core works without adapters. Companion without daemon stays unavailable. No Pi pulled into daemon tarball. No `npm publish`.

Keep npm test green. 40 minutes. Evidence docs/evidence/s6-pack/. Commit if green. No push, no systemctl, no linger.
