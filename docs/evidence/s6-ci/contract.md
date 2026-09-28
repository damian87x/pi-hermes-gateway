# Slice — S6 CI + local release script

HEAD 0025a43. Delegated verify REJECT. Only these two gaps:

1. `.github/workflows/ci.yml`: `npm ci`, `npm run typecheck`, `npm test`. Node >= 24.20. No deploy, no publish, no secrets.
2. `scripts/release`: packs each private package into a local directory. Must refuse `npm publish`. No registry write.

Keep existing tests green. Add one test that the release script refuses publish and writes tarballs locally.

40 minutes. Evidence docs/evidence/s6-ci/. Commit if green. No push, no publish, no enable, no live send.
