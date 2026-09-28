# Slice — S2 remaining: doctor + templates (no enable)

HEAD b56b13e. 168 tests green. Fake adapter default.

## Required (TDD)

1. `pi-hermes-gateway-core doctor` (or equivalent CLI): checks absolute Node path, `node:sqlite`, profile lock/socket dirs. Missing linger → warn and refuse any logout-survival claim. Does not enable linger.
2. Ship a systemd user unit **template** only. Paths must not point into `~/.pi/agent/npm/`. No `systemctl enable`, no linger on.
3. Test: disposable profile, start daemon, restart, once-at still delivers to fake sink. Second daemon fails. Companion without daemon still starts nothing.
4. Keep npm test green. No live send, no QR, no Slack, no publish.

40 minutes. Evidence docs/evidence/s2-lifecycle/. Commit if green. No push.
