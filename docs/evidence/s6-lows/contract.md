# Follow-up — S6 code-safety lows

HEAD 256ac32. Code-safety PASS. Patch these only (TDD):

1. `pack-install.test.ts`: disposable npmrc/globalconfig inside tmp home; `--offline` or dead registry; same env for `npm pack`. Do not load real `~/.npmrc`.
2. `doctor.ts` linger username: reject `''`, `'.'`, `'..'` (not only `/`).
3. `checkCliPath`: compare `realpath(cli)` to `realpath(~/.pi/agent/npm)` prefix with separator boundary.
4. Do not `npm run build` of all dist during parallel `node --test` (build before test, or serial pack-install).

Keep npm test green. 40 minutes. Evidence docs/evidence/s6-lows/. Commit if green. No push, enable, linger, live send, publish.
