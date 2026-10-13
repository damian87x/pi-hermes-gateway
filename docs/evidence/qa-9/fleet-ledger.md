# Story #9 QA fleet ledger

Target checkout: `qa/story-9-r2`, exact PR head `fbf64f4a951ceef32834480b32b72f59d9c3d9e3`.

| Mutation | planned | applied | provenance-verified | reverted | post-revert-verified |
|---|---|---|---|---|---|
| Exact user template instance `pi-hermes-gateway@pilot.service` only | Preflight recorded `LoadState=not-found`, `ActiveState=inactive`; unit path, symlink, and wants link all absent | Installer enabled/started it via owned symlink to throwaway unit/profile; restart tested | `FragmentPath` and `ExecStart` named only the temp unit/profile; captured raw `systemctl`, `journalctl`, one kill target; fake sink/config paths are under `/tmp/g9-systemd.NrfuxN` | Stopped/disabled the same template instance; removed owned links and temp tree | `systemctl show`: `LoadState=not-found`, `ActiveState=inactive`, empty FragmentPath; exact path and wants link absent; temp tree absent |
| One authorized mid-window KILL | Harness schedules one `systemctl --user kill -s KILL pi-hermes-gateway@pilot` after fake send has appended once and delivery is dispatching | Executed exactly once against the owned pilot unit | Journal states SIGKILL to the owned pilot MainPID; `NRestarts=1`; ledger shows crash send count 1, `commit-unknown`, never 2 | systemd restarted pilot successfully; cleanup then stopped/disabled it | Same exact template preflight state restored (`not-found`/`inactive`); no second KILL and no other service named |
| Browser artifact capture | Confirmed `playwright-cli list` empty and load <12 | Opened one browser to the Lavish artifact, captured `screenshot.png` | Screenshot is in repo; title/head visible; console only reported missing `/favicon.ico` | `playwright-cli close` | `playwright-cli list` reports `(no browsers)` |

No unrelated pi/claude process was killed. `pgrep -fa 'pi |claude'` was UID-scoped and raw output included unrelated Claude processes; proxy ruling limits criterion (c) to PILOT attachment, proven zero connected pilot socket clients on both sides of restart and Pi-session exit before due. No Hermes/OpenClaw unit, other service, real socket/provider/secret, or `.env` was touched.
