# G6 / story #9: fake adapter under real user systemd

Captured 2026-10-13 on this machine from `story/9-g6-systemd-proof`, starting at
`9e5170f18a7d23c4789cec2fb50e882b857e0812`. Live issue #9 was read; #7 and #8 were closed.
No planning lock was consulted. This is an actual user-manager run, not mocked systemctl.

## Acceptance observations

- (a) `install-user-unit --enable --profile pilot` exited 0; unit enabled and active.
  Config selected only the built fake adapter. HOME, profile, config, sink, ledger,
  and built CLI/protocol prefix were under `/tmp/g9-systemd.95GS7D`.
- (b) `job create` scheduled `g9-restart-once` for now+60s (11:04:53.575Z).
- (c) `pgrep -fa 'pi |claude' --uid 1000` is pasted raw below. Unrelated Claude
  TUIs/bridges were present and **left untouched**, per the user's explicit safety
  override; this is not a claim that every TUI on the machine was closed. No TUI
  participated in the test. The only IPC client exited before restart. The daemon
  restarted before due; read-only observation showed count 0 and `beforeDue: true`.
  The initial unscoped regex also matched another user's unrelated container command
  with embedded credentials; that line is not persisted. UID scoping avoids publishing
  credentials while retaining the requested regex and the relevant raw process list.
- (d) Sink count for `g9-restart-once` was exactly 1 after due and remained 1 after
  the second restart; ledger had one accepted delivery with the same delivery ID.
- (e) A local wrapper around **only the fake adapter** appended the second message
  then stalled its receipt. The ledger was `dispatching` when the single
  `systemctl --user kill -s KILL pi-hermes-gateway@pilot` ran. Real systemd restarted
  it (`NRestarts=1`); count for `g9-crash-once` stayed 1, not 2, and ledger/audit
  showed `commit-unknown` / `crash.recover`. Two distinct jobs mean two total entries,
  not a duplicate. The automated twin exercises both 0 and 1 observed crash outcomes.
- (f) Actual CLI doctor printed `"logoutSurvivalClaim":true`, with existing host linger.
  No linger setting was changed. This is doctor/unit evidence, not an actual logout test.

## Safety and cleanup

Preflight checked the exact instance's LoadState, fragment, unit path and enablement
link, including dangling links; none existed. The installer wrote under temporary
HOME. An owned exact-instance symlink exposed that file to the normal user manager;
`XDG_CONFIG_HOME` kept enablement discoverable without redirecting the manager.
Only `pi-hermes-gateway@pilot.service` was enabled, started, restarted, killed,
stopped and disabled. No other service was inspected or modified; specifically no
`hermes-gateway.service` or `openclaw-gateway.service` operations. No unrelated Pi/Claude
process was killed. No real provider, credential file, `.env`, or real provider socket
was used. All IPC used the throwaway profile's local socket. No other worktree changed.
Cleanup removed only owned exact unit/enablement links and the owned temporary root;
final raw output confirms `LoadState=not-found`, `ActiveState=inactive`, no fragment,
no remaining symlink and no temporary data. Earlier failed attempts were also cleaned.

## Actual commands and raw output (successful flow, exit 0)

The runner logs shell-escaped argv (`pi\ \|claude` is the literal `'pi |claude'`
argument), raw stdout/stderr, and each exit status. Output is unabridged for this run.

```text

$ date -u --iso-8601=seconds
2026-10-13T11:03:51+00:00
[exit=0]

$ git rev-parse HEAD
9e5170f18a7d23c4789cec2fb50e882b857e0812
[exit=0]

$ node --version
v24.21.0
[exit=0]

$ loginctl show-user damian-linux -p Linger
Linger=yes
[exit=0]

$ systemctl --user show pi-hermes-gateway@pilot.service -p LoadState -p ActiveState -p FragmentPath
LoadState=not-found
ActiveState=inactive
FragmentPath=
[exit=0]

$ test not-found = not-found
[exit=0]

$ test \! -e /home/damian-linux/.config/systemd/user/pi-hermes-gateway@pilot.service
[exit=0]

$ test \! -L /home/damian-linux/.config/systemd/user/pi-hermes-gateway@pilot.service
[exit=0]

$ test \! -e /home/damian-linux/.config/systemd/user/default.target.wants/pi-hermes-gateway@pilot.service
[exit=0]

$ test \! -L /home/damian-linux/.config/systemd/user/default.target.wants/pi-hermes-gateway@pilot.service
[exit=0]

$ test \! -e /home/damian-linux/.config/systemd/user/pi-hermes-gateway@pilot.service
[exit=0]

$ test \! -L /home/damian-linux/.config/systemd/user/pi-hermes-gateway@pilot.service
[exit=0]

$ mkdir -p /tmp/g9-systemd.95GS7D/home/.config/pi-hermes-gateway/pilot /tmp/g9-systemd.95GS7D/home/.config/systemd/user /tmp/g9-systemd.95GS7D/prefix\ space%\$/packages/gateway /tmp/g9-systemd.95GS7D/prefix\ space%\$/packages/protocol /tmp/g9-systemd.95GS7D/prefix\ space%\$/node_modules
[exit=0]

$ chmod 700 /tmp/g9-systemd.95GS7D/home/.config/pi-hermes-gateway/pilot
[exit=0]

$ cp -r packages/gateway/dist /tmp/g9-systemd.95GS7D/prefix\ space%\$/packages/gateway/dist
[exit=0]

$ cp -r packages/protocol/dist /tmp/g9-systemd.95GS7D/prefix\ space%\$/packages/protocol/dist
[exit=0]

$ cp packages/protocol/package.json /tmp/g9-systemd.95GS7D/prefix\ space%\$/packages/protocol/package.json
[exit=0]

$ ln -s ../packages/protocol /tmp/g9-systemd.95GS7D/prefix\ space%\$/node_modules/pi-hermes-gateway-protocol
[exit=0]

$ node /tmp/g9-validation/observe.mjs configure
{"routes":[{"profileId":"pilot","adapterId":"fake","accountId":"throwaway","chatId":"sink-only"}],"tickIntervalMs":100,"adapter":{"module":"/tmp/g9-systemd.95GS7D/prefix space%$/packages/gateway/dist/fake-adapter.js","config":{"sinkPath":"/tmp/g9-systemd.95GS7D/sink.json"}}}
[exit=0]

$ ln -s /tmp/g9-systemd.95GS7D/home/.config/systemd/user/pi-hermes-gateway@pilot.service /home/damian-linux/.config/systemd/user/pi-hermes-gateway@pilot.service
[exit=0]

$ env HOME=/tmp/g9-systemd.95GS7D/home XDG_CONFIG_HOME=/home/damian-linux/.config /usr/bin/node scripts/install-user-unit.mjs --enable --profile pilot --prefix /tmp/g9-systemd.95GS7D/prefix\ space%\$
[Unit]
Description=pi-hermes-gateway profile pilot
After=default.target
StartLimitIntervalSec=60
StartLimitBurst=3

[Service]
Type=simple
ExecStart="/usr/bin/node" "/tmp/g9-systemd.95GS7D/prefix space%%$/packages/gateway/dist/cli.js" --profile "/tmp/g9-systemd.95GS7D/home/.config/pi-hermes-gateway/pilot"
WorkingDirectory=/tmp/g9-systemd.95GS7D/prefix space%%$
Restart=on-failure
RestartSec=5
NoNewPrivileges=true

[Install]
WantedBy=default.target
[exit=0]

$ systemctl --user is-enabled pi-hermes-gateway@pilot.service
enabled
[exit=0]

$ systemctl --user start pi-hermes-gateway@pilot.service
[exit=0]

$ sleep 1
[exit=0]

$ systemctl --user show pi-hermes-gateway@pilot.service -p ActiveState -p MainPID -p FragmentPath -p ExecStart
ActiveState=active
FragmentPath=/home/damian-linux/.config/systemd/user/pi-hermes-gateway@pilot.service
MainPID=2319368
ExecStart={ path=/usr/bin/node ; argv[]=/usr/bin/node /tmp/g9-systemd.95GS7D/prefix space%$/packages/gateway/dist/cli.js --profile /tmp/g9-systemd.95GS7D/home/.config/pi-hermes-gateway/pilot ; ignore_errors=no ; start_time=[Tue 2026-10-13 12:03:52 BST] ; stop_time=[n/a] ; pid=2319368 ; code=(null) ; status=0/0 }
[exit=0]

$ /usr/bin/node /tmp/g9-systemd.95GS7D/prefix\ space%\$/packages/gateway/dist/cli.js --profile /tmp/g9-systemd.95GS7D/home/.config/pi-hermes-gateway/pilot job create --text g9-restart-once --at 2026-10-13T11:04:53.575Z
job_a7335e4c7247e46b9816c73c
[exit=0]

$ pgrep -fa pi\ \|claude --uid 1000
38542 claude --resume e6baad90-b189-4833-91d3-5fbda901b20f
39617 claude --resume 174802bb-e093-43cd-b71c-266f70aa59ba
41011 claude --resume f4bfba75-f21a-4499-b789-82c3d6a0e7de
42033 claude --resume 04bd27fd-d704-4dfe-8b54-d31e7cb694be
43563 claude --resume 3fc7b130-1a63-4833-b73e-3bf82a9dc384
44687 claude --resume 85e2cbdf-a66c-4502-9079-0e60c6a524d0
45670 claude --resume 2f142374-c80c-4136-8d28-b8c9688798d9
51187 node /home/damian-linux/.claude/plugins/cache/omc/oh-my-claudecode/4.12.0/bridge/mcp-server.cjs
51347 node /home/damian-linux/.claude/plugins/cache/omc/oh-my-claudecode/4.12.0/bridge/mcp-server.cjs
51736 node /home/damian-linux/.claude/plugins/cache/omc/oh-my-claudecode/4.12.0/bridge/mcp-server.cjs
52514 node /home/damian-linux/.claude/plugins/cache/omc/oh-my-claudecode/4.12.0/bridge/mcp-server.cjs
52678 claude --resume 8c587b89-c574-421f-902e-71560f6c739f
52830 node /home/damian-linux/.claude/plugins/cache/omc/oh-my-claudecode/4.12.0/bridge/mcp-server.cjs
53003 node /home/damian-linux/.claude/plugins/cache/omc/oh-my-claudecode/4.12.0/bridge/mcp-server.cjs
54036 node /home/damian-linux/.claude/plugins/cache/omc/oh-my-claudecode/4.12.0/bridge/mcp-server.cjs
55620 claude --resume 6cfc8df3-2483-4d4a-a064-ddceb2d63884
58210 node /home/damian-linux/.claude/plugins/cache/omc/oh-my-claudecode/4.12.0/bridge/mcp-server.cjs
60129 claude --resume ff98a474-b3f8-4be0-80b2-f5bd5d02951a
60816 node /home/damian-linux/.claude/plugins/cache/omc/oh-my-claudecode/4.12.0/bridge/mcp-server.cjs
61919 claude --resume b6824cd8-9c0e-4dea-8938-df5ef747aef3
62525 claude --resume 41d6d5b3-e33b-4d6a-b302-bd2bbd6dad2c
63551 node /home/damian-linux/.claude/plugins/cache/omc/oh-my-claudecode/4.12.0/bridge/mcp-server.cjs
64122 node /home/damian-linux/.claude/plugins/cache/omc/oh-my-claudecode/4.12.0/bridge/mcp-server.cjs
64479 node /home/damian-linux/.claude/plugins/cache/omc/oh-my-claudecode/4.12.0/bridge/mcp-server.cjs
86515 /home/damian-linux/.local/bin/claude --chrome-native-host
170652 claude --permission-mode bypassPermissions --resume 4182fbae-3e23-4d3c-9ce5-cb734718de10
170843 node /home/damian-linux/.claude/plugins/cache/omc/oh-my-claudecode/4.12.0/bridge/mcp-server.cjs
172699 claude --permission-mode bypassPermissions --model opus
173099 node /home/damian-linux/.claude/plugins/cache/omc/oh-my-claudecode/4.12.0/bridge/mcp-server.cjs
450207 /usr/bin/zsh -c source /home/damian-linux/.claude/shell-snapshots/snapshot-zsh-1791873893306-u9dknr.sh 2>/dev/null || true && export CODEX_COMPANION_SESSION_ID='44a0eb86-a9ff-49ba-b8f2-a686a38a539f' export CLAUDE_PLUGIN_DATA='/home/damian-linux/.claude/plugins/data/codex-openai-codex' : && setopt NO_EXTENDED_GLOB NO_BARE_GLOB_QUAL 2>/dev/null || true && { \builtin unalias -- 'unsetenv'; \builtin unset -f -- 'unsetenv'; } >/dev/null 2>&1 || true && eval 'cd /tmp/claude-1000/-home-damian-linux-workspace-billioner-coder/44a0eb86-a9ff-49ba-b8f2-a686a38a539f/scratchpad && while pgrep -f '"'"'launch-sv-grok-484-5b20b9b'"'"' >/dev/null; do sleep 20; done; echo "484: $(cat rev/sv484-grok/status.txt 2>&1 | cut -c1-80) | $(grep -m1 -E '"'"'^Verdict:'"'"' rev/sv484-grok/out.txt | cut -c1-80)"; tail -2 rev/grok-484.log | cut -c1-160' < /dev/null && pwd -P >| /tmp/claude-bd46-cwd
499462 /usr/bin/zsh -c source /home/damian-linux/.claude/shell-snapshots/snapshot-zsh-1791873893306-u9dknr.sh 2>/dev/null || true && export CODEX_COMPANION_SESSION_ID='44a0eb86-a9ff-49ba-b8f2-a686a38a539f' export CLAUDE_PLUGIN_DATA='/home/damian-linux/.claude/plugins/data/codex-openai-codex' : && setopt NO_EXTENDED_GLOB NO_BARE_GLOB_QUAL 2>/dev/null || true && { \builtin unalias -- 'unsetenv'; \builtin unset -f -- 'unsetenv'; } >/dev/null 2>&1 || true && eval 'cd /tmp/claude-1000/-home-damian-linux-workspace-billioner-coder/44a0eb86-a9ff-49ba-b8f2-a686a38a539f/scratchpad && while pgrep -f '"'"'launch-sv-grok-484-bfb9d76'"'"' >/dev/null; do sleep 20; done; echo "484: $(cat rev/sv484-grok/status.txt 2>&1 | cut -c1-80) | $(grep -m1 -E '"'"'^Verdict:'"'"' rev/sv484-grok/out.txt | cut -c1-80)"; tail -2 rev/grok-484.log | cut -c1-160; grep -i -E '"'"'blocking|unmet'"'"' rev/sv484-grok/out.txt | cut -c1-300 | head -4' < /dev/null && pwd -P >| /tmp/claude-5c8f-cwd
1212630 /usr/bin/zsh -c source /home/damian-linux/.claude/shell-snapshots/snapshot-zsh-1791873893306-u9dknr.sh 2>/dev/null || true && export CODEX_COMPANION_SESSION_ID='44a0eb86-a9ff-49ba-b8f2-a686a38a539f' export CLAUDE_PLUGIN_DATA='/home/damian-linux/.claude/plugins/data/codex-openai-codex' : && setopt NO_EXTENDED_GLOB NO_BARE_GLOB_QUAL 2>/dev/null || true && { \builtin unalias -- 'unsetenv'; \builtin unset -f -- 'unsetenv'; } >/dev/null 2>&1 || true && eval 'cd /tmp/claude-1000/-home-damian-linux-workspace-billioner-coder/44a0eb86-a9ff-49ba-b8f2-a686a38a539f/scratchpad && while pgrep -f '"'"'launch-gw-15-bcc65da'"'"' >/dev/null; do sleep 20; done; tail -4 rev/post-gw15-bcc65da.log | cut -c1-140; for f in sonnet sol grok; do grep -i -E '"'"'blocking|unmet'"'"' rev/gw15-$f/out.txt | cut -c1-280 | head -2; done; echo ---; for n in 487 488; do echo "sv$n: $(grep -m1 '"'"'^Verdict:'"'"' rev/sv$n-grok/out.txt 2>/dev/null)"; grep -i -E '"'"'blocking|unmet'"'"' rev/sv$n-grok/out.txt 2>/dev/null | cut -c1-260 | head -2; done' < /dev/null && pwd -P >| /tmp/claude-ab2e-cwd
1386460 /usr/bin/zsh -c source /home/damian-linux/.claude/shell-snapshots/snapshot-zsh-1791873893306-u9dknr.sh 2>/dev/null || true && export CODEX_COMPANION_SESSION_ID='44a0eb86-a9ff-49ba-b8f2-a686a38a539f' export CLAUDE_PLUGIN_DATA='/home/damian-linux/.claude/plugins/data/codex-openai-codex' : && setopt NO_EXTENDED_GLOB NO_BARE_GLOB_QUAL 2>/dev/null || true && { \builtin unalias -- 'unsetenv'; \builtin unset -f -- 'unsetenv'; } >/dev/null 2>&1 || true && eval 'cd /tmp/claude-1000/-home-damian-linux-workspace-billioner-coder/44a0eb86-a9ff-49ba-b8f2-a686a38a539f/scratchpad && while pgrep -f '"'"'launch-gw-15-2c4a858'"'"' >/dev/null; do sleep 20; done; tail -4 rev/post-gw15-2c4a858.log | cut -c1-140; for f in sonnet sol grok; do grep -i -E '"'"'blocking|unmet'"'"' rev/gw15-$f/out.txt | cut -c1-280 | head -2; done' < /dev/null && pwd -P >| /tmp/claude-1eee-cwd
1410439 /usr/bin/zsh -c source /home/damian-linux/.claude/shell-snapshots/snapshot-zsh-1791873893306-u9dknr.sh 2>/dev/null || true && export CODEX_COMPANION_SESSION_ID='44a0eb86-a9ff-49ba-b8f2-a686a38a539f' export CLAUDE_PLUGIN_DATA='/home/damian-linux/.claude/plugins/data/codex-openai-codex' : && setopt NO_EXTENDED_GLOB NO_BARE_GLOB_QUAL 2>/dev/null || true && { \builtin unalias -- 'unsetenv'; \builtin unset -f -- 'unsetenv'; } >/dev/null 2>&1 || true && eval 'cd /tmp/claude-1000/-home-damian-linux-workspace-billioner-coder/44a0eb86-a9ff-49ba-b8f2-a686a38a539f/scratchpad && while pgrep -f '"'"'launch-sv-grok-487-3f36989|launch-gw-15-2c4a858'"'"' >/dev/null; do sleep 20; done; echo "487: $(grep -m1 -E '"'"'^Verdict:'"'"' rev/sv487-grok/out.txt | cut -c1-60)"; tail -1 rev/grok-487.log | cut -c1-120; grep -i -E '"'"'blocking|unmet'"'"' rev/sv487-grok/out.txt | cut -c1-280 | head -2; echo --- gw15; tail -4 rev/post-gw15-2c4a858.log | cut -c1-120; for f in sonnet sol grok; do grep -i -E '"'"'blocking|unmet'"'"' rev/gw15-$f/out.txt | cut -c1-260 | head -2; done' < /dev/null && pwd -P >| /tmp/claude-b30f-cwd
1480033 /usr/bin/zsh -c source /home/damian-linux/.claude/shell-snapshots/snapshot-zsh-1791873893306-u9dknr.sh 2>/dev/null || true && export CODEX_COMPANION_SESSION_ID='44a0eb86-a9ff-49ba-b8f2-a686a38a539f' export CLAUDE_PLUGIN_DATA='/home/damian-linux/.claude/plugins/data/codex-openai-codex' : && setopt NO_EXTENDED_GLOB NO_BARE_GLOB_QUAL 2>/dev/null || true && { \builtin unalias -- 'unsetenv'; \builtin unset -f -- 'unsetenv'; } >/dev/null 2>&1 || true && eval 'cd /tmp/claude-1000/-home-damian-linux-workspace-billioner-coder/44a0eb86-a9ff-49ba-b8f2-a686a38a539f/scratchpad && while pgrep -f '"'"'launch-gw-16-5a0b6ef'"'"' >/dev/null; do sleep 20; done; tail -4 rev/post-gw16-5a0b6ef.log | cut -c1-140; for f in sonnet sol grok; do grep -i -E '"'"'blocking|unmet'"'"' rev/gw16-$f/out.txt | cut -c1-280 | head -2; done' < /dev/null && pwd -P >| /tmp/claude-db15-cwd
1486964 /usr/bin/zsh -c source /home/damian-linux/.claude/shell-snapshots/snapshot-zsh-1791873893306-u9dknr.sh 2>/dev/null || true && export CODEX_COMPANION_SESSION_ID='44a0eb86-a9ff-49ba-b8f2-a686a38a539f' export CLAUDE_PLUGIN_DATA='/home/damian-linux/.claude/plugins/data/codex-openai-codex' : && setopt NO_EXTENDED_GLOB NO_BARE_GLOB_QUAL 2>/dev/null || true && { \builtin unalias -- 'unsetenv'; \builtin unset -f -- 'unsetenv'; } >/dev/null 2>&1 || true && eval 'cd /tmp/claude-1000/-home-damian-linux-workspace-billioner-coder/44a0eb86-a9ff-49ba-b8f2-a686a38a539f/scratchpad && while pgrep -f '"'"'launch-sv-grok-487-0111752|launch-sv-grok-489-b642984'"'"' >/dev/null; do sleep 20; done; for n in 487 489; do echo "$n: $(grep -m1 -E '"'"'^Verdict:'"'"' rev/sv$n-grok/out.txt | cut -c1-60)"; tail -1 rev/grok-$n.log | cut -c1-120; grep -i -E '"'"'blocking|unmet|before or after|full'"'"' rev/sv$n-grok/out.txt | cut -c1-280 | head -3; done' < /dev/null && pwd -P >| /tmp/claude-6c95-cwd
1638559 /usr/bin/zsh -c source /home/damian-linux/.claude/shell-snapshots/snapshot-zsh-1791873893306-u9dknr.sh 2>/dev/null || true && export CODEX_COMPANION_SESSION_ID='44a0eb86-a9ff-49ba-b8f2-a686a38a539f' export CLAUDE_PLUGIN_DATA='/home/damian-linux/.claude/plugins/data/codex-openai-codex' : && setopt NO_EXTENDED_GLOB NO_BARE_GLOB_QUAL 2>/dev/null || true && { \builtin unalias -- 'unsetenv'; \builtin unset -f -- 'unsetenv'; } >/dev/null 2>&1 || true && eval 'cd /tmp/claude-1000/-home-damian-linux-workspace-billioner-coder/44a0eb86-a9ff-49ba-b8f2-a686a38a539f/scratchpad && while pgrep -f '"'"'launch-gw-17-67ba7b0'"'"' >/dev/null; do sleep 20; done; tail -4 rev/post-gw17-67ba7b0.log | cut -c1-140; for f in sonnet sol grok; do grep -i -E '"'"'blocking|unmet'"'"' rev/gw17-$f/out.txt | cut -c1-280 | head -2; done' < /dev/null && pwd -P >| /tmp/claude-728c-cwd
1868099 /usr/bin/zsh -c source /home/damian-linux/.claude/shell-snapshots/snapshot-zsh-1791873893306-u9dknr.sh 2>/dev/null || true && export CODEX_COMPANION_SESSION_ID='44a0eb86-a9ff-49ba-b8f2-a686a38a539f' export CLAUDE_PLUGIN_DATA='/home/damian-linux/.claude/plugins/data/codex-openai-codex' : && setopt NO_EXTENDED_GLOB NO_BARE_GLOB_QUAL 2>/dev/null || true && { \builtin unalias -- 'unsetenv'; \builtin unset -f -- 'unsetenv'; } >/dev/null 2>&1 || true && eval 'cd /tmp/claude-1000/-home-damian-linux-workspace-billioner-coder/44a0eb86-a9ff-49ba-b8f2-a686a38a539f/scratchpad && while pgrep -f '"'"'launch-sv-grok-489-b7596ff'"'"' >/dev/null; do sleep 20; done; echo "489: $(grep -m1 -E '"'"'^Verdict:'"'"' rev/sv489-grok/out.txt | cut -c1-60)"; tail -1 rev/grok-489.log | cut -c1-120; grep -i -E '"'"'blocking|unmet'"'"' rev/sv489-grok/out.txt | cut -c1-300 | head -4' < /dev/null && pwd -P >| /tmp/claude-59e6-cwd
1998358 /usr/bin/zsh -c source /home/damian-linux/.claude/shell-snapshots/snapshot-zsh-1791873893306-u9dknr.sh 2>/dev/null || true && export CODEX_COMPANION_SESSION_ID='44a0eb86-a9ff-49ba-b8f2-a686a38a539f' export CLAUDE_PLUGIN_DATA='/home/damian-linux/.claude/plugins/data/codex-openai-codex' : && setopt NO_EXTENDED_GLOB NO_BARE_GLOB_QUAL 2>/dev/null || true && { \builtin unalias -- 'unsetenv'; \builtin unset -f -- 'unsetenv'; } >/dev/null 2>&1 || true && eval 'cd /tmp/claude-1000/-home-damian-linux-workspace-billioner-coder/44a0eb86-a9ff-49ba-b8f2-a686a38a539f/scratchpad && while pgrep -f '"'"'launch-gw-19-bb65e0a'"'"' >/dev/null; do sleep 20; done; tail -4 rev/post-gw19-bb65e0a.log | cut -c1-140; for f in sonnet sol grok; do grep -i -E '"'"'blocking|unmet'"'"' rev/gw19-$f/out.txt | cut -c1-280 | head -2; done' < /dev/null && pwd -P >| /tmp/claude-829c-cwd
2019958 claude --permission-mode bypassPermissions --model sonnet
2020111 node /home/damian-linux/.claude/plugins/cache/omc/oh-my-claudecode/4.12.0/bridge/mcp-server.cjs
2094726 claude --permission-mode bypassPermissions --model opus
2095325 node /home/damian-linux/.claude/plugins/cache/omc/oh-my-claudecode/4.12.0/bridge/mcp-server.cjs
2279561 /usr/bin/zsh -c source /home/damian-linux/.claude/shell-snapshots/snapshot-zsh-1791887302274-j0aju4.sh 2>/dev/null || true && export CODEX_COMPANION_SESSION_ID='4043a21a-585b-4720-bcb5-f1e115038701' export CLAUDE_PLUGIN_DATA='/home/damian-linux/.claude/plugins/data/codex-openai-codex' : && setopt NO_EXTENDED_GLOB NO_BARE_GLOB_QUAL 2>/dev/null || true && { \builtin unalias -- 'unsetenv'; \builtin unset -f -- 'unsetenv'; } >/dev/null 2>&1 || true && eval 'for i in $(seq 1 58); do n=$(gh pr list -R damian87x/solvie-desktop --head story/491-phone-undo-window --state open --json number -q '"'"'.[0].number'"'"'); [ -n "$n" ] && { echo "PR $n"; exit 0; }; sleep 10; done; echo none yet' < /dev/null && pwd -P >| /tmp/claude-5adf-cwd
2301494 /usr/bin/zsh -c source /home/damian-linux/.claude/shell-snapshots/snapshot-zsh-1791887302274-j0aju4.sh 2>/dev/null || true && export CODEX_COMPANION_SESSION_ID='4043a21a-585b-4720-bcb5-f1e115038701' export CLAUDE_PLUGIN_DATA='/home/damian-linux/.claude/plugins/data/codex-openai-codex' : && setopt NO_EXTENDED_GLOB NO_BARE_GLOB_QUAL 2>/dev/null || true && { \builtin unalias -- 'unsetenv'; \builtin unset -f -- 'unsetenv'; } >/dev/null 2>&1 || true && eval 'cd /home/damian-linux/workspace/solvie-desktop-app-lane-491 && git add apps/mobile && git commit -qm "BU2: Phone undo window for a single decision (#491)  Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>" && git rev-parse HEAD; cat /proc/loadavg; (pnpm test:e2e --workers=2 >/tmp/e2e491.out 2>&1; echo e2e=$? >>/tmp/e2e491.out) ; tail -8 /tmp/e2e491.out' && pwd -P >| /tmp/claude-54c3-cwd
2301575 /usr/bin/zsh -c source /home/damian-linux/.claude/shell-snapshots/snapshot-zsh-1791887302274-j0aju4.sh 2>/dev/null || true && export CODEX_COMPANION_SESSION_ID='4043a21a-585b-4720-bcb5-f1e115038701' export CLAUDE_PLUGIN_DATA='/home/damian-linux/.claude/plugins/data/codex-openai-codex' : && setopt NO_EXTENDED_GLOB NO_BARE_GLOB_QUAL 2>/dev/null || true && { \builtin unalias -- 'unsetenv'; \builtin unset -f -- 'unsetenv'; } >/dev/null 2>&1 || true && eval 'cd /home/damian-linux/workspace/solvie-desktop-app-lane-491 && git add apps/mobile && git commit -qm "BU2: Phone undo window for a single decision (#491)  Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>" && git rev-parse HEAD; cat /proc/loadavg; (pnpm test:e2e --workers=2 >/tmp/e2e491.out 2>&1; echo e2e=$? >>/tmp/e2e491.out) ; tail -8 /tmp/e2e491.out' && pwd -P >| /tmp/claude-54c3-cwd
2302888 /usr/bin/zsh -c source /home/damian-linux/.claude/shell-snapshots/snapshot-zsh-1791887302274-j0aju4.sh 2>/dev/null || true && export CODEX_COMPANION_SESSION_ID='4043a21a-585b-4720-bcb5-f1e115038701' export CLAUDE_PLUGIN_DATA='/home/damian-linux/.claude/plugins/data/codex-openai-codex' : && setopt NO_EXTENDED_GLOB NO_BARE_GLOB_QUAL 2>/dev/null || true && { \builtin unalias -- 'unsetenv'; \builtin unset -f -- 'unsetenv'; } >/dev/null 2>&1 || true && eval 'until grep -q '"'"'^e2e='"'"' /tmp/e2e491.out 2>/dev/null; do sleep 20; done; tail -8 /tmp/e2e491.out' < /dev/null && pwd -P >| /tmp/claude-0ad4-cwd
[exit=0]

$ systemctl --user restart pi-hermes-gateway@pilot
[exit=0]

$ sleep 1
[exit=0]

$ systemctl --user show pi-hermes-gateway@pilot.service -p ActiveState -p MainPID
ActiveState=active
MainPID=2319570
[exit=0]

$ node /tmp/g9-validation/observe.mjs before-due 1791889493575
{"now":"2026-10-13T11:03:54.776Z","due":"2026-10-13T11:04:53.575Z","count":0,"beforeDue":true}
[exit=0]

$ node /tmp/g9-validation/observe.mjs wait-send 1791889493575
{"observation":"wait-send","now":"2026-10-13T11:04:53.623Z","sink":[{"deliveryId":"dlv_0d62cf1f3e345928486e46c8","route":{"profileId":"pilot","adapterId":"fake","accountId":"throwaway","chatId":"sink-only"},"text":"g9-restart-once"}]}
[exit=0]

$ sleep 1
[exit=0]

$ node /tmp/g9-validation/observe.mjs ledger
{
  "now": "2026-10-13T11:04:54.682Z",
  "sink": [
    {
      "deliveryId": "dlv_0d62cf1f3e345928486e46c8",
      "route": {
        "profileId": "pilot",
        "adapterId": "fake",
        "accountId": "throwaway",
        "chatId": "sink-only"
      },
      "text": "g9-restart-once"
    }
  ],
  "deliveries": [
    {
      "delivery_id": "dlv_0d62cf1f3e345928486e46c8",
      "job_id": "job_a7335e4c7247e46b9816c73c",
      "status": "accepted"
    }
  ],
  "audit": []
}
[exit=0]

$ systemctl --user restart pi-hermes-gateway@pilot
[exit=0]

$ sleep 1
[exit=0]

$ systemctl --user show pi-hermes-gateway@pilot.service -p ActiveState -p MainPID
ActiveState=active
MainPID=2330398
[exit=0]

$ node /tmp/g9-validation/observe.mjs ledger
{
  "now": "2026-10-13T11:04:55.759Z",
  "sink": [
    {
      "deliveryId": "dlv_0d62cf1f3e345928486e46c8",
      "route": {
        "profileId": "pilot",
        "adapterId": "fake",
        "accountId": "throwaway",
        "chatId": "sink-only"
      },
      "text": "g9-restart-once"
    }
  ],
  "deliveries": [
    {
      "delivery_id": "dlv_0d62cf1f3e345928486e46c8",
      "job_id": "job_a7335e4c7247e46b9816c73c",
      "status": "accepted"
    }
  ],
  "audit": []
}
[exit=0]

$ node /tmp/g9-validation/observe.mjs stall
{"routes":[{"profileId":"pilot","adapterId":"fake","accountId":"throwaway","chatId":"sink-only"}],"tickIntervalMs":100,"adapter":{"module":"/tmp/g9-systemd.95GS7D/stalled-fake.mjs","config":{"sinkPath":"/tmp/g9-systemd.95GS7D/sink.json"}}}

import { createAdapter as createFake } from "file:///tmp/g9-systemd.95GS7D/prefix%20space%25$/packages/gateway/dist/fake-adapter.js";
import { writeFileSync } from 'node:fs';
export function createAdapter(config) {
  const adapter = createFake(config);
  const send = adapter.send.bind(adapter);
  adapter.send = (envelope) => {
    send(envelope);
    writeFileSync("/tmp/g9-systemd.95GS7D/dispatch-stalled", envelope.deliveryId);
    return new Promise(() => {});
  };
  return adapter;
}

[exit=0]

$ systemctl --user restart pi-hermes-gateway@pilot
[exit=0]

$ sleep 1
[exit=0]

$ /usr/bin/node /tmp/g9-systemd.95GS7D/prefix\ space%\$/packages/gateway/dist/cli.js --profile /tmp/g9-systemd.95GS7D/home/.config/pi-hermes-gateway/pilot job create --text g9-crash-once --at 2026-10-13T11:05:06.837Z
job_cd4192b8e0dee1db24f06f2f
[exit=0]

$ node /tmp/g9-validation/observe.mjs wait-stall
{"observation":"wait-stall","now":"2026-10-13T11:05:06.962Z","sink":[{"deliveryId":"dlv_0d62cf1f3e345928486e46c8","route":{"profileId":"pilot","adapterId":"fake","accountId":"throwaway","chatId":"sink-only"},"text":"g9-restart-once"},{"deliveryId":"dlv_a7d8356b96d34a5cedaee30d","route":{"profileId":"pilot","adapterId":"fake","accountId":"throwaway","chatId":"sink-only"},"text":"g9-crash-once"}]}
[exit=0]

$ node /tmp/g9-validation/observe.mjs ledger dispatching
{
  "now": "2026-10-13T11:05:06.989Z",
  "sink": [
    {
      "deliveryId": "dlv_0d62cf1f3e345928486e46c8",
      "route": {
        "profileId": "pilot",
        "adapterId": "fake",
        "accountId": "throwaway",
        "chatId": "sink-only"
      },
      "text": "g9-restart-once"
    },
    {
      "deliveryId": "dlv_a7d8356b96d34a5cedaee30d",
      "route": {
        "profileId": "pilot",
        "adapterId": "fake",
        "accountId": "throwaway",
        "chatId": "sink-only"
      },
      "text": "g9-crash-once"
    }
  ],
  "deliveries": [
    {
      "delivery_id": "dlv_0d62cf1f3e345928486e46c8",
      "job_id": "job_a7335e4c7247e46b9816c73c",
      "status": "accepted"
    },
    {
      "delivery_id": "dlv_a7d8356b96d34a5cedaee30d",
      "job_id": "job_cd4192b8e0dee1db24f06f2f",
      "status": "dispatching"
    }
  ],
  "audit": []
}
crash message count=1; never 2; status=dispatching
[exit=0]

$ systemctl --user kill -s KILL pi-hermes-gateway@pilot
[exit=0]

$ sleep 7
[exit=0]

$ systemctl --user show pi-hermes-gateway@pilot.service -p ActiveState -p MainPID -p NRestarts
ActiveState=active
MainPID=2332783
NRestarts=1
[exit=0]

$ node /tmp/g9-validation/observe.mjs ledger commit-unknown
{
  "now": "2026-10-13T11:05:14.037Z",
  "sink": [
    {
      "deliveryId": "dlv_0d62cf1f3e345928486e46c8",
      "route": {
        "profileId": "pilot",
        "adapterId": "fake",
        "accountId": "throwaway",
        "chatId": "sink-only"
      },
      "text": "g9-restart-once"
    },
    {
      "deliveryId": "dlv_a7d8356b96d34a5cedaee30d",
      "route": {
        "profileId": "pilot",
        "adapterId": "fake",
        "accountId": "throwaway",
        "chatId": "sink-only"
      },
      "text": "g9-crash-once"
    }
  ],
  "deliveries": [
    {
      "delivery_id": "dlv_0d62cf1f3e345928486e46c8",
      "job_id": "job_a7335e4c7247e46b9816c73c",
      "status": "accepted"
    },
    {
      "delivery_id": "dlv_a7d8356b96d34a5cedaee30d",
      "job_id": "job_cd4192b8e0dee1db24f06f2f",
      "status": "commit-unknown"
    }
  ],
  "audit": [
    {
      "kind": "crash.recover",
      "payload_json": "{\"deliveryId\":\"dlv_a7d8356b96d34a5cedaee30d\",\"previousStatus\":\"dispatching\"}"
    }
  ]
}
crash message count=1; never 2; status=commit-unknown
[exit=0]

$ env HOME=/tmp/g9-systemd.95GS7D/home /usr/bin/node /tmp/g9-systemd.95GS7D/prefix\ space%\$/packages/gateway/dist/cli.js --profile /tmp/g9-systemd.95GS7D/home/.config/pi-hermes-gateway/pilot doctor
{"ok":true,"lingerEnabled":true,"lingerPrecondition":true,"unitEvidence":true,"logoutSurvivalClaim":true,"checks":[{"id":"node-path","ok":true,"severity":"info","message":"absolute Node path /usr/bin/node"},{"id":"cli-path","ok":true,"severity":"info","message":"CLI path /tmp/g9-systemd.95GS7D/prefix space%$/packages/gateway/dist/cli.js"},{"id":"node-sqlite","ok":true,"severity":"info","message":"node:sqlite 3.53.4"},{"id":"profile-dirs","ok":true,"severity":"info","message":"lock /tmp/g9-systemd.95GS7D/home/.config/pi-hermes-gateway/pilot/profile.lock; socket /tmp/g9-systemd.95GS7D/home/.config/pi-hermes-gateway/pilot/gateway.sock"},{"id":"linger","ok":true,"severity":"info","message":"user linger is enabled"},{"id":"unit","ok":true,"severity":"info","message":"user unit evidence present"}]}
[exit=0]

$ journalctl --user -u pi-hermes-gateway@pilot.service --since 2026-10-13T12:03:51+01:00 --no-pager -o short-iso
2026-10-13T12:03:52+01:00 damian-linux-MS-7C37 systemd[7104]: Started pi-hermes-gateway@pilot.service - pi-hermes-gateway profile pilot.
2026-10-13T12:03:52+01:00 damian-linux-MS-7C37 node[2319368]: gateway listening
2026-10-13T12:03:53+01:00 damian-linux-MS-7C37 systemd[7104]: Stopping pi-hermes-gateway@pilot.service - pi-hermes-gateway profile pilot...
2026-10-13T12:03:53+01:00 damian-linux-MS-7C37 systemd[7104]: Stopped pi-hermes-gateway@pilot.service - pi-hermes-gateway profile pilot.
2026-10-13T12:03:53+01:00 damian-linux-MS-7C37 systemd[7104]: Started pi-hermes-gateway@pilot.service - pi-hermes-gateway profile pilot.
2026-10-13T12:03:53+01:00 damian-linux-MS-7C37 node[2319570]: gateway listening
2026-10-13T12:04:54+01:00 damian-linux-MS-7C37 systemd[7104]: Stopping pi-hermes-gateway@pilot.service - pi-hermes-gateway profile pilot...
2026-10-13T12:04:54+01:00 damian-linux-MS-7C37 systemd[7104]: Stopped pi-hermes-gateway@pilot.service - pi-hermes-gateway profile pilot.
2026-10-13T12:04:54+01:00 damian-linux-MS-7C37 systemd[7104]: Started pi-hermes-gateway@pilot.service - pi-hermes-gateway profile pilot.
2026-10-13T12:04:54+01:00 damian-linux-MS-7C37 node[2330398]: gateway listening
2026-10-13T12:04:55+01:00 damian-linux-MS-7C37 systemd[7104]: Stopping pi-hermes-gateway@pilot.service - pi-hermes-gateway profile pilot...
2026-10-13T12:04:55+01:00 damian-linux-MS-7C37 systemd[7104]: Stopped pi-hermes-gateway@pilot.service - pi-hermes-gateway profile pilot.
2026-10-13T12:04:55+01:00 damian-linux-MS-7C37 systemd[7104]: Started pi-hermes-gateway@pilot.service - pi-hermes-gateway profile pilot.
2026-10-13T12:04:55+01:00 damian-linux-MS-7C37 node[2330514]: gateway listening
2026-10-13T12:05:06+01:00 damian-linux-MS-7C37 systemd[7104]: pi-hermes-gateway@pilot.service: Sent signal SIGKILL to main process 2330514 (MainThread) on client request.
2026-10-13T12:05:06+01:00 damian-linux-MS-7C37 systemd[7104]: pi-hermes-gateway@pilot.service: Killed unit cgroup '/user.slice/user-1000.slice/user@1000.service/app.slice/app-pi\x2dhermes\x2dgateway.slice/pi-hermes-gateway@pilot.service' with SIGKILL on client request.
2026-10-13T12:05:06+01:00 damian-linux-MS-7C37 systemd[7104]: pi-hermes-gateway@pilot.service: Main process exited, code=killed, status=9/KILL
2026-10-13T12:05:06+01:00 damian-linux-MS-7C37 systemd[7104]: pi-hermes-gateway@pilot.service: Failed with result 'signal'.
2026-10-13T12:05:12+01:00 damian-linux-MS-7C37 systemd[7104]: pi-hermes-gateway@pilot.service: Scheduled restart job, restart counter is at 1.
2026-10-13T12:05:12+01:00 damian-linux-MS-7C37 systemd[7104]: Started pi-hermes-gateway@pilot.service - pi-hermes-gateway profile pilot.
2026-10-13T12:05:12+01:00 damian-linux-MS-7C37 node[2332783]: gateway listening
[exit=0]

CLEANUP (proof exit=0)

$ systemctl --user stop pi-hermes-gateway@pilot.service
[exit=0]

$ systemctl --user disable pi-hermes-gateway@pilot.service
Removed '/home/damian-linux/.config/systemd/user/pi-hermes-gateway@pilot.service'.
Removed '/home/damian-linux/.config/systemd/user/default.target.wants/pi-hermes-gateway@pilot.service'.
[exit=0]

$ systemctl --user daemon-reload
[exit=0]

$ systemctl --user show pi-hermes-gateway@pilot.service -p LoadState -p ActiveState -p FragmentPath
LoadState=not-found
ActiveState=inactive
FragmentPath=
[exit=0]

$ test \! -e /home/damian-linux/.config/systemd/user/pi-hermes-gateway@pilot.service
[exit=0]

$ test \! -L /home/damian-linux/.config/systemd/user/pi-hermes-gateway@pilot.service
[exit=0]

$ test \! -e /home/damian-linux/.config/systemd/user/default.target.wants/pi-hermes-gateway@pilot.service
[exit=0]

$ test \! -L /home/damian-linux/.config/systemd/user/default.target.wants/pi-hermes-gateway@pilot.service
[exit=0]

$ rm -rf /tmp/g9-systemd.95GS7D
[exit=0]

$ test \! -e /tmp/g9-systemd.95GS7D
[exit=0]
proof final exit=0
```

## Reproduce the scoped flow

These are the exact successful runner and observer sources. Save them to
`/tmp/g9-validation/systemd-proof.sh` and `/tmp/g9-validation/observe.mjs` after
creating that directory; build first, then run from this lane with
`bash /tmp/g9-validation/systemd-proof.sh`. They refuse an existing pilot unit.
Do not run against a non-throwaway configuration. No automatic retry is present.

```bash
#!/bin/bash
set -eu
REPO=$PWD
REAL_HOME=$HOME
REAL_CONFIG=${XDG_CONFIG_HOME:-$HOME/.config}
UNIT=pi-hermes-gateway@pilot.service
VISIBLE=$REAL_CONFIG/systemd/user/$UNIT
WANTS=$REAL_CONFIG/systemd/user/default.target.wants/$UNIT
PROOF_ROOT=$(mktemp -d /tmp/g9-systemd.XXXXXX)
export PROOF_ROOT
TEMP_HOME=$PROOF_ROOT/home
PROFILE=$TEMP_HOME/.config/pi-hermes-gateway/pilot
PREFIX=$PROOF_ROOT/'prefix space%$'
export PREFIX
TEMP_UNIT=$TEMP_HOME/.config/systemd/user/$UNIT
CLI=$PREFIX/packages/gateway/dist/cli.js
NODE=$(command -v node)
OWNED=0
run() {
  printf '\n$'; printf ' %q' "$@"; printf '\n'
  set +e
  "$@"
  code=$?
  set -e
  printf '[exit=%s]\n' "$code"
  return "$code"
}
cleanup() {
  status=$?
  trap - EXIT
  printf '\nCLEANUP (proof exit=%s)\n' "$status"
  if [ "$OWNED" = 1 ] && [ -L "$VISIBLE" ] && [ "$(readlink "$VISIBLE")" = "$TEMP_UNIT" ]; then
    run systemctl --user stop "$UNIT" || true
    # Disable only this owned unit; no other service is named or modified.
    run systemctl --user disable "$UNIT"
    if [ -L "$VISIBLE" ] && [ "$(readlink "$VISIBLE")" = "$TEMP_UNIT" ]; then run rm "$VISIBLE"; fi
    run systemctl --user daemon-reload
    run systemctl --user show "$UNIT" -p LoadState -p ActiveState -p FragmentPath
    run test ! -e "$VISIBLE"
    run test ! -L "$VISIBLE"
    run test ! -e "$WANTS"
    run test ! -L "$WANTS"
  fi
  run rm -rf "$PROOF_ROOT"
  run test ! -e "$PROOF_ROOT"
  printf 'proof final exit=%s\n' "$status"
  exit "$status"
}
trap cleanup EXIT
STARTED=$(date --iso-8601=seconds)
run date -u --iso-8601=seconds
run git rev-parse HEAD
run node --version
run loginctl show-user "$(id -un)" -p Linger
run systemctl --user show "$UNIT" -p LoadState -p ActiveState -p FragmentPath
run test "$(systemctl --user show "$UNIT" -p LoadState --value)" = not-found
# Reject existing files, dangling links, and prior enablement before any write/enable.
run test ! -e "$VISIBLE"
run test ! -L "$VISIBLE"
run test ! -e "$WANTS"
run test ! -L "$WANTS"
run test ! -e "$REAL_HOME/.config/systemd/user/$UNIT"
run test ! -L "$REAL_HOME/.config/systemd/user/$UNIT"
run mkdir -p "$PROFILE" "$TEMP_HOME/.config/systemd/user" "$PREFIX/packages/gateway" "$PREFIX/packages/protocol" "$PREFIX/node_modules"
run chmod 700 "$PROFILE"
run cp -r packages/gateway/dist "$PREFIX/packages/gateway/dist"
run cp -r packages/protocol/dist "$PREFIX/packages/protocol/dist"
run cp packages/protocol/package.json "$PREFIX/packages/protocol/package.json"
run ln -s ../packages/protocol "$PREFIX/node_modules/pi-hermes-gateway-protocol"
run node /tmp/g9-validation/observe.mjs configure
# The installer writes its conventional path under throwaway HOME. Only the exact
# preflight-absent instance is exposed to the real user manager by an owned symlink.
run ln -s "$TEMP_UNIT" "$VISIBLE"
OWNED=1
run env HOME="$TEMP_HOME" XDG_CONFIG_HOME="$REAL_CONFIG" "$NODE" scripts/install-user-unit.mjs --enable --profile pilot --prefix "$PREFIX"
run systemctl --user is-enabled "$UNIT"
run systemctl --user start "$UNIT"
run sleep 1
run systemctl --user show "$UNIT" -p ActiveState -p MainPID -p FragmentPath -p ExecStart
DUE_MS=$(node -e 'console.log(Date.now()+60000)')
DUE=$(node -e 'console.log(new Date(Number(process.argv[1])).toISOString())' "$DUE_MS")
run "$NODE" "$CLI" --profile "$PROFILE" job create --text g9-restart-once --at "$DUE"
# Limit to this uid: the literal regex also matches unrelated container commands
# belonging to other users which can embed credentials. No process is killed.
run pgrep -fa 'pi |claude' --uid "$(id -u)"
run systemctl --user restart pi-hermes-gateway@pilot
run sleep 1
run systemctl --user show "$UNIT" -p ActiveState -p MainPID
run node /tmp/g9-validation/observe.mjs before-due "$DUE_MS"
run node /tmp/g9-validation/observe.mjs wait-send "$DUE_MS"
run sleep 1
run node /tmp/g9-validation/observe.mjs ledger
run systemctl --user restart pi-hermes-gateway@pilot
run sleep 1
run systemctl --user show "$UNIT" -p ActiveState -p MainPID
run node /tmp/g9-validation/observe.mjs ledger
# Deterministic mid-send window: fake sink append precedes a never-resolved receipt.
run node /tmp/g9-validation/observe.mjs stall
run systemctl --user restart pi-hermes-gateway@pilot
run sleep 1
CRASH_DUE=$(node -e 'console.log(new Date(Date.now()+10000).toISOString())')
run "$NODE" "$CLI" --profile "$PROFILE" job create --text g9-crash-once --at "$CRASH_DUE"
run node /tmp/g9-validation/observe.mjs wait-stall
run node /tmp/g9-validation/observe.mjs ledger dispatching
run systemctl --user kill -s KILL pi-hermes-gateway@pilot
run sleep 7
run systemctl --user show "$UNIT" -p ActiveState -p MainPID -p NRestarts
run node /tmp/g9-validation/observe.mjs ledger commit-unknown
run env HOME="$TEMP_HOME" "$NODE" "$CLI" --profile "$PROFILE" doctor
run journalctl --user -u "$UNIT" --since "$STARTED" --no-pager -o short-iso
```

```js
import assert from 'node:assert/strict';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { pathToFileURL } from 'node:url';
import { setTimeout as sleep } from 'node:timers/promises';
const root = process.env.PROOF_ROOT;
const profile = join(root, 'home/.config/pi-hermes-gateway/pilot');
const sinkPath = join(root, 'sink.json');
const configPath = join(profile, 'config.json');
const fake = join(process.env.PREFIX, 'packages/gateway/dist/fake-adapter.js');
const marker = join(root, 'dispatch-stalled');
const sink = () => existsSync(sinkPath) ? JSON.parse(readFileSync(sinkPath, 'utf8')) : [];
const mode = process.argv[2];
if (mode === 'configure' || mode === 'stall') {
  const module = mode === 'configure' ? fake : join(root, 'stalled-fake.mjs');
  if (mode === 'stall') writeFileSync(module, `
import { createAdapter as createFake } from ${JSON.stringify(pathToFileURL(fake).href)};
import { writeFileSync } from 'node:fs';
export function createAdapter(config) {
  const adapter = createFake(config);
  const send = adapter.send.bind(adapter);
  adapter.send = (envelope) => {
    send(envelope);
    writeFileSync(${JSON.stringify(marker)}, envelope.deliveryId);
    return new Promise(() => {});
  };
  return adapter;
}
`, { mode: 0o600 });
  writeFileSync(configPath, JSON.stringify({ routes: [{ profileId: 'pilot', adapterId: 'fake', accountId: 'throwaway', chatId: 'sink-only' }], tickIntervalMs: 100, adapter: { module, config: { sinkPath } } }) + '\n', { mode: 0o600 });
  console.log(readFileSync(configPath, 'utf8').trim());
  if (mode === 'stall') console.log(readFileSync(module, 'utf8'));
} else if (mode === 'before-due') {
  assert.ok(Date.now() < Number(process.argv[3]));
  assert.equal(sink().length, 0);
  console.log(JSON.stringify({ now: new Date().toISOString(), due: new Date(Number(process.argv[3])).toISOString(), count: 0, beforeDue: true }));
} else if (mode === 'wait-send' || mode === 'wait-stall') {
  const deadline = Date.now() + 75_000;
  while (!(mode === 'wait-send' ? sink().some(x => x.text === 'g9-restart-once') : existsSync(marker))) {
    assert.ok(Date.now() < deadline, `timeout: ${mode}`);
    await sleep(50);
  }
  if (mode === 'wait-send') assert.ok(Date.now() >= Number(process.argv[3]));
  console.log(JSON.stringify({ observation: mode, now: new Date().toISOString(), sink: sink() }));
} else if (mode === 'ledger') {
  const db = new DatabaseSync(join(profile, 'gateway.sqlite'), { readOnly: true });
  try {
    const deliveries = db.prepare('SELECT delivery_id, job_id, status FROM deliveries ORDER BY rowid').all();
    const audit = db.prepare("SELECT kind, payload_json FROM audit WHERE kind = 'crash.recover'").all();
    const sends = sink();
    console.log(JSON.stringify({ now: new Date().toISOString(), sink: sends, deliveries, audit }, null, 2));
    assert.equal(sends.filter(x => x.text === 'g9-restart-once').length, 1);
    assert.equal(deliveries[0].status, 'accepted');
    if (process.argv[3]) {
      const count = sends.filter(x => x.text === 'g9-crash-once').length;
      assert.ok(count === 0 || count === 1, 'never two sends');
      assert.equal(deliveries.length, 2);
      assert.equal(deliveries[1].status, process.argv[3]);
      if (process.argv[3] === 'commit-unknown') assert.ok(audit.some(x => JSON.parse(x.payload_json).deliveryId === deliveries[1].delivery_id));
      console.log(`crash message count=${count}; never 2; status=${deliveries[1].status}`);
    }
  } finally { db.close(); }
} else throw new Error(`unknown observation ${mode}`);
```

## Defect found by the real run; failing-first proof

The original installer incorrectly quoted `WorkingDirectory`. Real systemd treats
that setting as a literal path, unlike ExecStart argv, and refused to start. The fix
removes argv quoting only for this setting and preserves percent-specifier escaping.
The successful proof deliberately used a prefix with space, `%`, and `$`.

Failing step: original `systemctl --user start pi-hermes-gateway@pilot.service`.
Exactly five raw evidence lines:

```text
$ systemctl --user start pi-hermes-gateway@pilot.service
Failed to start pi-hermes-gateway@pilot.service: Unit pi-hermes-gateway@pilot.service has a bad unit file setting.
[exit=1]
2026-10-13T11:58:48+01:00 damian-linux-MS-7C37 systemd[7104]: /home/damian-linux/.config/systemd/user/pi-hermes-gateway@pilot.service:10: WorkingDirectory= path is not absolute: "/tmp/g9-systemd.AhHQOS/prefix"
LoadState=not-found
```

The first runner's cleanup stopped at the unloaded-unit error (runner exit 5).
Explicit exact-unit disable, reload and deletion then removed its two owned links
and `/tmp/g9-systemd.AhHQOS`; unit returned to not-found/inactive. The successful
runner tolerates only cleanup stop failure; all test/proof steps remain fail-fast.

Added regression before changing installer; command exit 1 (expected):
`node --experimental-strip-types --test packages/gateway/test/install-user-unit.test.ts`.
Raw output:

```text
✔ install-user-unit defaults to write-free dry-run with concrete absolute paths (51.091058ms)
✖ install-user-unit renders WorkingDirectory as a literal path, not an ExecStart quoted argument (24.640076ms)
✔ install-user-unit writes passively; enable alone explicitly reloads and enables only its own unit (77.67541ms)
✔ install-user-unit refuses a symlink destination without changing its target (24.753538ms)
✔ install-user-unit rejects invalid input and Pi-owned prefixes without writes or systemctl (135.179708ms)
✔ doctor discovers the rendered profile unit and claims logout survival only with linger (24.666686ms)
ℹ tests 6
ℹ suites 0
ℹ pass 5
ℹ fail 1
ℹ cancelled 0
ℹ skipped 0
ℹ todo 0
ℹ duration_ms 434.967129

✖ failing tests:

test at packages/gateway/test/install-user-unit.test.ts:49:1
✖ install-user-unit renders WorkingDirectory as a literal path, not an ExecStart quoted argument (24.640076ms)
  AssertionError [ERR_ASSERTION]: Expected values to be strictly equal:
  + actual - expected
  
  + 'WorkingDirectory="/tmp/gateway-unit-TbTbn2/prefix space%%$"'
  - 'WorkingDirectory=/tmp/gateway-unit-TbTbn2/prefix space%%$'
  
      at TestContext.<anonymous> (file:///home/damian-linux/workspace/pi-hermes-gateway-lane-9/packages/gateway/test/install-user-unit.test.ts:54:12)
      at Test.runInAsyncScope (node:async_hooks:227:14)
      at Test.run (node:internal/test_runner/test:1402:25)
      at Test.processPendingSubtests (node:internal/test_runner/test:974:18)
      at Test.postRun (node:internal/test_runner/test:1542:19)
      at Test.run (node:internal/test_runner/test:1467:12)
      at async startSubtestAfterBootstrap (node:internal/test_runner/harness:387:3) {
    generatedMessage: true,
    code: 'ERR_ASSERTION',
    actual: 'WorkingDirectory="/tmp/gateway-unit-TbTbn2/prefix space%%$"',
    expected: 'WorkingDirectory=/tmp/gateway-unit-TbTbn2/prefix space%%$',
    operator: 'strictEqual',
    diff: 'simple'
  }
```

### Harness-only failed attempts (not hidden or retry-wrapped)

Failing step: percent-containing path imported as a URL without encoding; crash
`job create` failed because the local stalled wrapper could not load. Fixed only
observer source to use `pathToFileURL`, matching the automated twin. Exit 1; cleaned.
Exactly five raw evidence lines:

```text
2026-10-13T12:01:38+01:00 damian-linux-MS-7C37 node[2293088]: URI malformed
$ /usr/bin/node /tmp/g9-systemd.ur0CRj/prefix\ space%\$/packages/gateway/dist/cli.js --profile /tmp/g9-systemd.ur0CRj/home/.config/pi-hermes-gateway/pilot job create --text g9-crash-once --at 2026-10-13T11:01:49.214Z
gateway daemon is not running: cannot connect to /tmp/g9-systemd.ur0CRj/home/.config/pi-hermes-gateway/pilot/gateway.sock (ENOENT)
[exit=1]
proof final exit=1
```

Failing step: unnecessary additional restart after successful SIGKILL recovery hit
existing `StartLimitBurst=3`. Removed that extra, non-acceptance step from the runner;
no production restart policy was changed. Exit 1; cleaned and reset-failed only the
owned pilot instance, returning it to not-found/inactive before the successful run.
Exactly five raw evidence lines:

```text
crash message count=1; never 2; status=commit-unknown
$ systemctl --user restart pi-hermes-gateway@pilot
Job for pi-hermes-gateway@pilot.service failed because start of the service was attempted too often.
[exit=1]
proof final exit=1
```

## Automated twin and local validation

`packages/gateway/test/e2e-restart.test.ts` already implements the automated twin:
separate daemon processes, disconnected CLI before restart, persistent non-deduplicating
fake sink, accepted delivery after pre-due restart, no replay after second restart,
and deterministic SIGKILL before/after fake send with commit-unknown recovery and no
replay after another restart. It was retained unchanged and actually executed.
New regression is in `packages/gateway/test/install-user-unit.test.ts`.

Commands were run directly, not retry-wrapped; no new test skips were introduced.
The existing dashboard other-uid token-file test self-skips for non-root users;
this lane ran as uid 1000 (raw skip line below). This is disclosed, not claimed passed.
No elevated test run or unrelated permission change was attempted.

| Command | Exit |
| --- | --- |
| `npm ci` | 0 |
| failing-first installer test above | 1 (expected) |
| `node --experimental-strip-types --test packages/gateway/test/install-user-unit.test.ts packages/gateway/test/e2e-restart.test.ts` | 0 |
| `NODE_OPTIONS=--max-old-space-size=4096 timeout 600 npm test` | 0 before fix; 0 after fix |
| `npm run typecheck` | 0 before fix; 0 after fix |
| `npm run build` | 0 before fix; 0 after fix |
| `bash /tmp/g9-validation/systemd-proof.sh` | 0 final (earlier failures above) |

### Targeted tests, raw output

```text
✔ fake sink retains sends across adapter instances so restarts cannot hide duplicates (3.423257ms)
✔ scheduled message is delivered exactly once after the daemon process is restarted with no client connected (4306.803979ms)
▶ SIGKILL while dispatching recovers as commit-unknown without a second sink entry
  ✔ before fake sink write (4413.506364ms)
  ✔ after fake sink write (4404.669428ms)
✔ SIGKILL while dispatching recovers as commit-unknown without a second sink entry (8819.534202ms)
✔ install-user-unit defaults to write-free dry-run with concrete absolute paths (87.062323ms)
✔ install-user-unit renders WorkingDirectory as a literal path, not an ExecStart quoted argument (73.401855ms)
✔ install-user-unit writes passively; enable alone explicitly reloads and enables only its own unit (139.635702ms)
✔ install-user-unit refuses a symlink destination without changing its target (39.847447ms)
✔ install-user-unit rejects invalid input and Pi-owned prefixes without writes or systemctl (231.956887ms)
✔ doctor discovers the rendered profile unit and claims logout survival only with linger (39.638485ms)
ℹ tests 11
ℹ suites 0
ℹ pass 11
ℹ fail 0
ℹ cancelled 0
ℹ skipped 0
ℹ todo 0
ℹ duration_ms 13287.575926
```

### Full suite after fix, raw output

```text

> pi-hermes-gateway@0.0.0 test
> npm run test -w pi-hermes-gateway-protocol && npm run test -w pi-hermes-gateway-core && npm run test -w pi-hermes-gateway-adapter-telegram && npm run test -w pi-hermes-gateway-adapter-whatsapp && npm run test -w pi-hermes-gateway-adapter-slack && npm run test -w pi-hermes-gateway-companion && npm run test -w pi-hermes-gateway-dashboard && npm run test -w pi-hermes-gateway-wiki


> pi-hermes-gateway-protocol@0.0.0 test
> npm run build && node --experimental-strip-types --test test/*.test.ts


> pi-hermes-gateway-protocol@0.0.0 build
> tsc -p tsconfig.json

✔ accepts a declared M1 text adapter manifest (3.997292ms)
✔ rejects unsupported adapter API versions (0.353663ms)
✔ rejects duplicate capability definitions (0.182662ms)
✔ rejects unknown capability definitions (0.177901ms)
✔ rejects empty capability lists (0.304992ms)
✔ rejects duplicate receipt levels (0.185702ms)
✔ requires accepted receipt level (0.286062ms)
✔ rejects maxTextLength outside protocol bounds (0.194911ms)
✔ rejects invalid adapterId (0.703746ms)
✔ accepts a static owner-route text delivery (1.753424ms)
✔ accepts optional threadId (0.208702ms)
✔ rejects missing route fields (0.233662ms)
✔ rejects empty or oversized route fields (0.187792ms)
✔ rejects empty text (0.314543ms)
✔ rejects oversized text using UTF-16 code units (0.228382ms)
✔ rejects notAfter at or before now (0.214261ms)
✔ rejects notAfter beyond 24 hours (0.211891ms)
✔ accepts optional requireApproval on static delivery (0.666845ms)
✔ rejects non-boolean requireApproval on static delivery (0.758206ms)
✔ rejects invalid caller clock nowMs (0.409903ms)
✔ accepts job.create static-text once-at body (1.676903ms)
✔ accepts job.create daily local schedule with IANA zone (21.740358ms)
✔ rejects worker job kinds in S0/M1 protocol (0.225872ms)
✔ rejects unknown IANA time zones (0.290622ms)
✔ rejects invalid localTime (0.320012ms)
✔ accepts optional requireApproval on job.create and keeps it on the parsed body (0.361743ms)
✔ rejects non-boolean requireApproval on job.create (0.177661ms)
✔ validates job.inspect and delivery.enqueue bodies (0.327942ms)
✔ rejects delivery.enqueue that fails static delivery rules (0.224972ms)
✔ rejects nonexistent once-schedule calendar dates (0.819446ms)
✔ accepts valid UTC once-schedule forms including leap day, month boundaries, fractional seconds, and end-of-day (0.273532ms)
✔ wire validation also checks method bodies (0.579415ms)
✔ accepts a supported wire request within limits (1.795454ms)
✔ rejects unsupported protocol versions (0.207542ms)
✔ rejects missing protocolVersion (0.180592ms)
✔ rejects invalid request IDs (0.307752ms)
✔ rejects unknown methods (0.300042ms)
✔ rejects non-object bodies (0.279282ms)
✔ rejects expired requests (0.305853ms)
✔ rejects expiry beyond the bounded TTL (0.180832ms)
✔ rejects oversized frames (0.729536ms)
✔ rejects oversized payloads (4.716377ms)
✔ rejects invalid caller clock nowMs (0.241802ms)
ℹ tests 43
ℹ suites 0
ℹ pass 43
ℹ fail 0
ℹ cancelled 0
ℹ skipped 0
ℹ todo 0
ℹ duration_ms 205.273876

> pi-hermes-gateway-core@0.0.0 test
> npm run build && node --experimental-strip-types --test --test-skip-pattern "s6 packed tarballs" test/*.test.ts && node --experimental-strip-types --test test/pack-install.test.ts


> pi-hermes-gateway-core@0.0.0 build
> tsc -p tsconfig.json

✔ openGateway defaults to fake adapter (5.796715ms)
✔ gateway accepts a structural send adapter that is not FakeAdapter (7.847071ms)
✔ route adapterId must match the loaded adapter manifest before enqueue, job and dispatch (31.447975ms)
✔ custom adapter dispatches routes carrying its own adapterId (6.873364ms)
✔ adapter commit-unknown receipt is persisted and never auto-retried (5.380421ms)
✔ malformed synchronous adapter receipt is commit-unknown, never accepted (9.542714ms)
✔ loadSendAdapter imports a module path factory without class identity (0.922418ms)
✔ actual Telegram adapter with async fake HTTP settles to accepted after the receipt resolves (35.008392ms)
✔ actual Slack adapter with async fake HTTP settles to accepted after the receipt resolves (6.968495ms)
✔ actual Telegram and Slack adapters record async timeout or rejected HTTP as commit-unknown (12.043484ms)
✔ Telegram adapter loaded with its default HTTP client settles accepted against a loopback fake server (71.423095ms)
✔ generic adapter rejected Promise is commit-unknown, not unhandled, and never auto-retried (18.361683ms)
✔ synchronous adapter throw is commit-unknown and never auto-retried (4.560655ms)
✔ async resolved commit-unknown receipt is persisted and never auto-retried (14.039199ms)
✔ overlapping enqueues and ticks drain once: one send in flight, each delivery sent exactly once (18.232102ms)
✔ hung async send leaves its row dispatching; close does not wait and reopen records commit-unknown (4.556265ms)
✔ send that synchronously enqueues another delivery keeps one send in flight and sends it once after the first settles (5.999496ms)
✔ send that synchronously kicks tick does not start a second drain over already queued deliveries (10.758583ms)
✔ synchronous send that enqueues another delivery still answers its receipt before the reentrant send (3.759409ms)
✔ async receipt whose accepted write fails halts the outbox: no unhandled rejection, no resend, reopen recovers (10.576673ms)
✔ synchronous receipt whose accepted write fails halts the outbox: response stays dispatching, no admission or resend, reopen recovers (6.47174ms)
✔ halt notifier that throws is contained: no unhandled rejection, halt still set, audit still recorded, no resend (7.477768ms)
✔ async halt notifier whose promise rejects is contained: no unhandled rejection, audit not delayed, no resend (5.327042ms)
✔ halt notifier returning a thenable whose then throws is contained: no unhandled rejection, no resend (5.008099ms)
✔ adapter rejection whose commit-unknown write fails halts the outbox and is never retried (4.554645ms)
✔ halted outbox rejects fresh enqueue and job.create without writes, tick admits no occurrence, history stays readable, restart admits (20.49814ms)
✔ job occurrence whose delivery insert write fails rolls back whole; the next tick and a restart admit it exactly once (40.906948ms)
✔ job occurrence whose admission audit write fails rolls back whole; the next tick and a restart admit it exactly once (40.537485ms)
✔ job occurrence whose expired audit write fails rolls back whole; the next tick and a restart admit it exactly once (30.509217ms)
✔ job occurrence whose invalid-route skip audit fails rolls back the skipped occurrence; the next tick records it once (18.951097ms)
✔ sync accepted receipt whose occurrence completion fails rolls back to dispatching and claimed, halts, and restart records commit-unknown without replay (25.136476ms)
✔ async accepted receipt whose accepted audit fails rolls back to dispatching and claimed, halts, and restart records commit-unknown without replay (21.671129ms)
✔ async commit-unknown receipt whose occurrence write fails rolls back to dispatching and claimed, halts, and restart records commit-unknown without replay (33.300849ms)
✔ sync commit-unknown receipt whose audit fails rolls back to dispatching and claimed, halts, and restart records commit-unknown without replay (24.178268ms)
✔ normal job receipts commit delivery, occurrence and audit together for daily and once jobs (22.201773ms)
✔ enqueue commits its fuse debit, delivery and audit before adapter.send, outside any transaction (3.374316ms)
✔ job approved after its pending read is still cancelled by a second Store and never sends (541.890821ms)
✔ delivery approved after its pending read is still quarantined by a second Store and never sends (445.024548ms)
✔ job cancelled by a second Store before approval commits rejects approval without writes (425.105093ms)
✔ delivery quarantined by a second Store before approval commits rejects approval without writes (426.456284ms)
✔ approval audit failure rolls back the job and delivery status change (6.834384ms)
✔ CLI approve waits for a concurrent cancellation and then refuses the cancelled job (1532.318686ms)
✔ job with requireApproval stays pending and tick does not send until approve (20.987473ms)
✔ delivery with requireApproval stays pending and dispatch does not send until approve (3.962991ms)
✔ job.resume does not activate a pending-approval job (2.839242ms)
✔ job.pause cannot launder a pending-approval job into paused, then resume (3.472397ms)
✔ a cancelled job cannot resume and tick does not send (3.96189ms)
✔ pending-approval job cannot launder through cancel then pause then resume (4.611966ms)
✔ active job cannot launder through cancel then pause then resume (3.733969ms)
✔ requireApproval job can approve, pause without sending, then resume and send once (3.614068ms)
✔ an approved active job can pause and resume normally (4.014921ms)
✔ approve of unknown or already-active id fails (2.994893ms)
✔ CLI approve mutates the profile DB and does not start a send (101.120576ms)
✔ IPC job.cancel while an async send holds the outbox fails the queued job delivery; settling the holder and restarting never send it (65.57809ms)
✔ job.cancel after the holder's receipt write halts the outbox fails the queued job delivery; restart does not send it (17.526356ms)
✔ job.pause keeps an unsent queued job delivery queued across a restart; resume dispatches it once (19.127169ms)
✔ a paused job's queued delivery that passes its notAfter while paused expires on resume without sending (15.36361ms)
✔ job.cancel leaves an already-dispatching job delivery in flight; its accepted receipt is recorded (14.463122ms)
✔ job.cancel whose delivery failed write fails rolls back whole and answers an error; the retry cancels (26.935159ms)
✔ job.cancel whose occurrence skipped write fails rolls back whole and answers an error; the retry cancels (19.114658ms)
✔ job.cancel whose job.cancelled audit fails rolls back whole and answers an error; the retry cancels (17.006052ms)
✔ job.cancel whose request_log write fails rolls back whole and answers an error; the retry cancels (6.874063ms)
✔ a cancelled job's leftover queued delivery never dispatches and cannot be resumed into active (4.561526ms)
✔ the conditional dispatch intent refuses a job no longer active inside the dispatch transaction; the whole claim rolls back unsent (4.022511ms)
✔ CI workflow grants only read access to repository contents (5.278221ms)
✔ cli-job: create prints the job id and list shows the created jobs (662.273427ms)
✔ cli-job: malformed operands are usage errors that never reach the daemon (1717.246282ms)
✔ cli-job: an index outside config.routes is rejected with invalid_route and creates no job (152.326424ms)
✔ cli-job: a configured route the daemon does not authorise is rejected with invalid_route (389.635728ms)
✔ cli-job: without a running daemon create and list exit nonzero with a clear message and create nothing (244.512039ms)
✔ cli-job: a repeated --request-id replays the first job id instead of creating a second job (769.403118ms)
✔ cli-worker: rejects extra arguments and job-supplied executables before admission (571.179328ms)
✔ cli-worker: missing synthetic config refuses before claim or spawn (80.365815ms)
✔ cli-worker: an unsafe profile directory is refused before opening the ledger or spawning (269.912607ms)
✔ cli-worker: unknown profile is rejected without consuming the daily invocation (236.301296ms)
✔ cli-worker: inherited registry names are unknown profiles and spend nothing (301.548443ms)
✔ cli-worker: the command is the first positional; `worker approve ID` never approves (169.633218ms)
✔ cli-worker: separate processes reject a repeated occurrence and a second occurrence the same UTC day (339.543238ms)
✔ cli-worker: accepted result creates one inert delivery on an empty ledger (121.333943ms)
✔ cli-worker: a scheduled job delivery is preserved and rejected before admission (111.293745ms)
✔ cli-worker: a delivery committed after the initial check blocks the physical spawn (154.48896ms)
✔ cli-worker: physical spawn and successful child close are recorded by the spawn control (178.182134ms)
✔ cli-worker: post-spawn COMMIT failure kills and reaps child before cwd cleanup (108.895666ms)
✔ cli-worker: rmSync failure still closes Store (115.672039ms)
✔ cli-worker: temporary-directory allocation failure closes Store without claim or spawn (74.184176ms)
✔ cli-worker: unrelated worker-prefixed delivery IDs do not collide with new results (143.970999ms)
✔ cli-worker: result and delivery insertion roll back together and retry does not spawn (226.45134ms)
✔ cli-worker: concurrent delivery occupation rejects completion without overwriting (649.488486ms)
✔ cli-worker: a failing worker still consumes the daily invocation (193.879926ms)
✔ cli-worker: a spawn error still consumes the daily invocation (159.182237ms)
✔ cli-worker: a CLI killed mid-run still consumes the daily invocation (221.998695ms)
✔ cli-worker: a 600KB result reaches piped stdout whole (read delay 0ms) (162.317251ms)
✔ cli-worker: a 600KB result reaches piped stdout whole (read delay 1000ms) (1021.109143ms)
✔ cli-worker: a closed stdout reader fails the CLI but keeps the completed claim (222.66485ms)
✔ cli-worker: finite CLI errors keep their status and never fall through to the daemon (418.232739ms)
✔ cli-worker: a CLI whose ledger cannot be opened exits 1 with a diagnostic, not a stack (138.598387ms)
✔ cli-worker: a newer ledger schema is reported, not masked by closing the store twice (137.374577ms)
✔ store: WAL initialization retries a real SQLITE_BUSY and then opens normally (30.041813ms)
✔ store: persistent WAL contention fails within the init budget and closes the handle (5001.847639ms)
✔ store: non-busy WAL initialization errors fail at once and close the handle (2.281857ms)
✔ store: close after migrate rejected a newer schema keeps the original error (2.091696ms)
✔ cli-worker: parent-timeout teardown kills and reaps hung CLI children, within a bound (349.425394ms)
✔ cli-worker: simultaneous independent CLI processes on a fresh profile spawn exactly one worker per day (31900.16788ms)
✔ job.cancel from a second Store after dispatch reads the occurrence pending, before the claim waits for the dispatch writer lock; neither overwrites the other and restart never resends (19.015467ms)
✔ job.cancel from a second Store after dispatch claims the occurrence, before the expiry write waits for the dispatch writer lock; neither overwrites the other and restart never resends (25.270006ms)
✔ job.cancel from a second Store at the fuse read, before the debit and dispatch intent waits for the dispatch writer lock; neither overwrites the other and restart never resends (6.921644ms)
✔ job.cancel from a second Store after dispatch reads the row queued, before the dispatch lock, fails it with no claim, debit or send (4.623336ms)
✔ job.pause from a second Store before the dispatch lock holds the row queued across restart; resume sends it once (7.397217ms)
✔ job.cancel from a second Store after tick's active-job snapshot, before admission, admits and audits nothing for the cancelled job (4.327064ms)
✔ job.pause from a second Store after tick's active-job snapshot admits a held queued row; resume sends it once (5.026529ms)
✔ dispatch-time expiry whose write fails rolls back the claim; a second-Store cancel then fails the row once and restart never sends or overwrites it (5.871506ms)
✔ revoked-route refusal whose write fails rolls back the claim; a second-Store cancel then fails the row once and restart never sends or overwrites it (7.060095ms)
✔ job.cancel from a second Store after tick's active-job snapshot, before a missed slot, records no skip and keeps the watermark (4.490265ms)
✔ job.pause from a second Store after tick's active-job snapshot, before a missed slot, records no skip and keeps the watermark (6.739783ms)
✔ job.cancel from a second Store between two missed slots keeps the earlier skip and records no later skip or watermark (29.014416ms)
✔ doctor warns for missing configured worker CLI without running it or enabling linger (2.373249ms)
✔ fake sink retains sends across adapter instances so restarts cannot hide duplicates (3.885541ms)
✔ scheduled message is delivered exactly once after the daemon process is restarted with no client connected (4301.913355ms)
▶ SIGKILL while dispatching recovers as commit-unknown without a second sink entry
  ✔ before fake sink write (4347.979125ms)
  ✔ after fake sink write (4337.189014ms)
✔ SIGKILL while dispatching recovers as commit-unknown without a second sink entry (8686.232077ms)
✔ an enqueue whose dedup reads predate a second Store's admission, racing before its send, answers that delivery and the owner's accepted response persists (15.915134ms)
✔ an enqueue whose dedup reads predate a second Store's admission, racing during its send, answers that delivery and the owner's accepted response persists (7.882511ms)
✔ a same-requestId enqueue that takes the writer lock first and admits and sends is the answer for a racer whose reads missed it, even after a refill (4.803777ms)
✔ a same-requestId enqueue that takes the writer lock first and is rate limited by a genuinely exhausted fuse is the answer for a racer whose reads missed it, even after a refill (5.016069ms)
✔ an enqueue queued behind an async holder answers a racing Store with its row, persists the owner's response and sends once (20.790912ms)
✔ a pending-approval enqueue answers a racing Store with its pending response; approval then sends once (5.08939ms)
✔ an enqueue expired at admission answers a racing Store with its expired response and never sends (4.440505ms)
✔ an enqueue whose pending-approval request_log write fails rolls back its row, debit, audit and response; the retry settles once (4.179352ms)
✔ an enqueue whose pending-approval admission audit fails rolls back its row, debit, audit and response; the retry settles once (5.547744ms)
✔ an enqueue whose rate-limited request_log write fails rolls back its row, debit, audit and response; the retry settles once (4.042672ms)
✔ an enqueue answered dispatching before its async receipt settles is replayed with the accepted status once it does (12.295096ms)
✔ an enqueue answered dispatching whose daemon stops before the receipt is replayed commit-unknown after restart and never resent (5.170321ms)
✔ an enqueue whose post-send request_log write fails keeps its one send; the retry answers the accepted row (5.18786ms)
✔ a same-requestId retry whose top-level dedup read misses answers the settled row from the enqueue admission recheck (7.131735ms)
✔ a job.create replaying a recorded enqueue response answers the live row and admits no job (26.233593ms)
✔ S0 validateStaticDelivery cannot express scheduledInstant-anchored notAfter for a future slot (1.521702ms)
✔ job delivery notAfter anchors to scheduledInstant, not catch-up now (9.889787ms)
✔ expired job occurrence is never sent late (5.604394ms)
✔ operator enqueue keeps protocol now-relative notAfter and rejects overdue dispatch (7.939212ms)
✔ per-account token bucket refuses extra sends with audit (21.949421ms)
✔ per-route daily cap refuses with audit (8.122804ms)
✔ unauthorized route error is indistinguishable and audited (4.588146ms)
✔ no IPC method creates routes; unknown method is rejected (2.192287ms)
✔ request dedup returns the first response without a second send (4.074591ms)
✔ wrong profile mode fails closed (0.851916ms)
✔ daemon startup rejects configured routes whose adapterId differs from the loaded adapter (4.894448ms)
✔ second daemon fails to lock and does not remove the first socket (3.926751ms)
✔ profile lock is node-only; holder death releases; no split-brain while held (98.195292ms)
✔ default daemon clock advances and ticks within 60s (224.161622ms)
✔ job on revoked route: reopen tick does not send and audits refusal (4.362764ms)
✔ queued enqueue on revoked route: reopen tick does not send and audits refusal (3.522508ms)
✔ enqueue whose queued delivery insert fails spends no fuse; the same requestId then admits once without a double send (4.701676ms)
✔ enqueue whose queued admission audit fails spends no fuse; the same requestId then admits once without a double send (4.803067ms)
✔ enqueue whose pending-approval admission audit fails spends no fuse; the same requestId then admits once without a double send (4.450625ms)
✔ enqueue whose expired delivery insert fails spends no fuse; the same requestId then admits once without a double send (4.117092ms)
✔ enqueue whose expired audit fails spends no fuse; the same requestId then admits once without a double send (3.720909ms)
✔ job refused by the token bucket fails its delivery and skips its occurrence; restart never resends it (5.895466ms)
✔ job text over a shrunk adapter maxTextLength is refused before any fuse debit and its occurrence is skipped (4.250973ms)
✔ job refusal whose occurrence skip write fails rolls back the whole refusal and halts; restart refuses once (6.35958ms)
✔ job refusal whose refusal audit write fails rolls back the whole refusal and halts; restart refuses once (6.45824ms)
✔ job whose dispatch-intent write fails rolls back its token bucket debit and halts; restart sends once (10.692003ms)
✔ job whose dispatch-intent write fails rolls back its daily cap debit and halts; restart sends once (6.589131ms)
✔ job crash at dispatch-intent rolls back its fuse debit and is commit-unknown; restart never sends it (4.824987ms)
✔ install-user-unit defaults to write-free dry-run with concrete absolute paths (189.23799ms)
✔ install-user-unit renders WorkingDirectory as a literal path, not an ExecStart quoted argument (121.251553ms)
✔ install-user-unit writes passively; enable alone explicitly reloads and enables only its own unit (263.043743ms)
✔ install-user-unit refuses a symlink destination without changing its target (53.025512ms)
✔ install-user-unit rejects invalid input and Pi-owned prefixes without writes or systemctl (381.584835ms)
✔ doctor discovers the rendered profile unit and claims logout survival only with linger (79.243685ms)
✔ job.resume that has read the job paused holds the writer lock; a second-Store cancel waits behind it and ends cancelled with no send (14.278701ms)
✔ job.resume whose dedup read precedes a committed second-Store cancel is denied under the writer lock and never sends (3.761489ms)
✔ job.resume whose audit write fails leaves the job paused with no request log or audit; the retry succeeds once (9.04377ms)
✔ job.pause that has read the job active holds the writer lock; a second-Store cancel waits behind it and ends cancelled with no send (10.950365ms)
✔ job.pause whose dedup read precedes a committed second-Store cancel is denied under the writer lock and never sends (3.556578ms)
✔ job.pause whose audit write fails leaves the job active with no request log or audit; the retry succeeds once (10.697603ms)
✔ job.pause and job.resume keep the pending-approval guard under the writer lock and record the denial (4.344944ms)
✔ job.create with the same requestId from two Stores after both miss the dedup read creates one job and sends once across reopen (10.401401ms)
✔ job.create whose audit write fails rolls back the job, attempt audit and request log; the retry creates one job that sends once (11.259467ms)
✔ fake-adapter createAdapter loads through adapter-loader with a sinkPath config and refuses malformed config (7.615859ms)
✔ CLI loads config.adapter fake module with sinkPath and honors config.tickIntervalMs (613.270215ms)
✔ CLI refuses config.tickIntervalMs outside 1..60000 with exit 2 before starting; the boundaries start (839.220261ms)
✔ no config.adapter keeps the fake adapter with no sink, in process and through the CLI (109.32014ms)
✔ doctor checks absolute Node, node:sqlite, profile dirs; missing linger warns and refuses logout-survival (7.905971ms)
✔ doctor rejects relative Node path and ~/.pi/agent/npm prefix (4.172442ms)
✔ doctor does not enable linger; systemd template is install-inert and avoids pi agent npm (0.544724ms)
✔ restart still delivers once-at to fake sink; second daemon fails (26.030162ms)
✔ stop during a deferred async send: no closed-store write, restart records commit-unknown without replay (27.321832ms)
✔ async accepted receipt that cannot be written halts the daemon outbox with one stderr diagnostic even if its audit fails; restart recovers commit-unknown and sends the queued row once (12.079044ms)
✔ synchronous accepted receipt that cannot be written halts the daemon outbox with one stderr diagnostic; restart recovers commit-unknown without replay (8.207284ms)
✔ daemon whose startup tick cannot write a job delivery keeps no orphan occurrence; restart delivers it once (10.569062ms)
✔ stop does not wait on a hung async send (5.414183ms)
✔ startup recovery whose occurrence write fails rolls back whole; restart records commit-unknown once without replay (13.559886ms)
✔ startup recovery whose audit write fails rolls back whole; restart records commit-unknown once without replay (10.25015ms)
✔ doctor CLI prints report and does not start a daemon (117.353652ms)
✔ logoutSurvivalClaim requires linger and unit evidence (2.797312ms)
✔ doctor profile path check resolves relative ./profile dirs (0.610995ms)
✔ doctor rejects CLI realpath under ~/.pi/agent/npm (1.37851ms)
✔ doctor rejects CLI whose realpath is under a symlinked Pi agent npm prefix (5.12361ms)
✔ linger probe uses os username and rejects slash in the name (2.444899ms)
✔ lingerUser '.' and '..' cannot produce a logout-survival claim (1.425621ms)
✔ crash at claim: interrupted, not accepted, later tick does not send (15.5062ms)
✔ crash at dispatch-intent: commit-unknown never auto-retried (3.459467ms)
✔ crash mid-send: commit-unknown never auto-retried (3.350366ms)
✔ crash before receipt write: commit-unknown even if adapter observed send (7.179966ms)
✔ crash before receipt write with async receipt: commit-unknown, sent once, drain stops (20.859182ms)
✔ crash mid-send with async rejection: commit-unknown, never auto-retried (7.258447ms)
✔ oversized adapter payload is rejected without send (6.928824ms)
✔ open converts leftover dispatching rows to commit-unknown with audit (18.05604ms)
✔ SIGKILL child leaving dispatching is recovered on open (88.613508ms)
✔ retry same requestId with delivery but no request_log returns existing status without fuses (3.067604ms)
✔ SIGKILL after job insert before request_log: same requestId retry gives 1 job and 1 send per slot (171.074029ms)
✔ IPC handleRequest exception returns error frame and keeps listening (4.641706ms)
✔ client write-and-destroy does not kill IPC daemon; next request is answered (329.518751ms)
✔ SIGKILL mid-send then same requestId retry returns commit-unknown without extra send (96.652051ms)
✔ test/pack-install.test.ts (240.56641ms)
✔ requireOwnedTaskHome accepts an owned disposable directory and rejects everything else (8.648927ms)
✔ requireApprovedProductBoundary allows a well-formed call and fails closed on every denied shape (1.011647ms)
✔ release script refuses publish and writes tarballs locally (10439.284566ms)
✔ release builds the workspace in an isolated npm environment and refuses publish (9446.98559ms)
✔ restore quarantine: queued becomes commit-unknown and is not sent (29.468399ms)
✔ already-sent delivery is not resurrected as queued (4.090501ms)
✔ restore quarantine: pending-approval approved and sent post-backup is not replayed by a second approve (12.767929ms)
✔ restore quarantine: never-approved pending-approval delivery is never sent (9.521084ms)
✔ refuse schema newer than binary (22.090112ms)
✔ post-backup sent slot is not resurrected as queued under skip (82.077707ms)
✔ post-backup sent slot is not resurrected as queued under one-latest (27.520054ms)
✔ once job backup in tick lag is not resent after restore+resume under one-latest (14.575803ms)
✔ tick refuses admission while quarantined until explicit resume (5.179271ms)
✔ explicit restore copies backup and quarantines before tick (23.694784ms)
✔ restore of a real-adapter profile materializes with the fake adapter and still quarantines (13.938819ms)
✔ non-db backup restore leaves live DB intact (6.065487ms)
✔ newer-schema backup restore leaves live DB intact (9.929807ms)
✔ interrupted restore with live moved aside recovers original DB (9.462093ms)
✔ interrupted second restore recovers the most recent live DB (10.445111ms)
✔ absent live DB with leftover .pre-restore and no journal does not revive it (11.731501ms)
✔ kill after restore swap then resume sends 0 extra under one-latest (13.965058ms)
✔ kill after restore swap then resume sends 0 extra under skip within grace (16.76986ms)
✔ backup is taken before migrate from v0 (2.433009ms)
✔ resume whose dispatch_enabled write fails rolls back whole; restart keeps direct enqueues unsent until resume (11.795951ms)
✔ resume whose quarantine write fails rolls back whole; restart keeps direct enqueues unsent until resume (20.918012ms)
✔ resume whose audit write fails rolls back whole; restart keeps direct enqueues unsent until resume (21.043453ms)
✔ persisted contradictory dispatch_enabled=1 quarantine=1 never dispatches until resume (18.580954ms)
✔ once-at UTC fires on the scheduled instant (20.248828ms)
✔ daily local IANA time fires (36.734276ms)
✔ DST gap: skip nonexistent local time (7.556339ms)
✔ DST fold: first occurrence only (0.945847ms)
✔ DST AU/NZ first fold, gaps, and adjacent valid local times vs brute-force oracle (362.561627ms)
✔ suspend past two due slots with skip: no burst (8.806279ms)
✔ DST-shortened day: one-latest wake within grace sends 1 not 2 (19.34368ms)
✔ suspend past two due slots with one-latest: single unexpired catch-up (6.46473ms)
✔ interval-sized gap plus millisecond lateness still sends under skip (8.9573ms)
✔ dispatch-time expiry whose delivery write fails rolls back delivery, occurrence and audit and halts; restart settles once (19.35578ms)
✔ dispatch-time expiry whose occurrence write fails rolls back delivery, occurrence and audit and halts; restart settles once (13.661946ms)
✔ dispatch-time expiry whose audit write fails rolls back delivery, occurrence and audit and halts; restart settles once (13.920698ms)
✔ revoked-route refusal whose delivery write fails rolls back delivery, occurrence and audit and halts; restart settles once (15.194878ms)
✔ revoked-route refusal whose occurrence write fails rolls back delivery, occurrence and audit and halts; restart settles once (9.520074ms)
✔ revoked-route refusal whose audit write fails rolls back delivery, occurrence and audit and halts; restart settles once (13.563276ms)
✔ worker-claims migration: v1 WAL data is preserved in backup and upgraded DB (6.808153ms)
✔ worker-claims migration: three processes upgrade v1 without overwriting its WAL backup with v2 (84.138204ms)
✔ worker-claims migration: backup publication failure leaves v1 and prior backup intact (5.06904ms)
✔ worker-claims migration: VACUUM failure under writer lock preserves v1 and prior backup, cleans up, and allows retry (10.860354ms)
✔ loadWorkerProfile loads a known profile by id (1.150479ms)
✔ loadWorkerProfile on missing id throws a helpful error and starts nothing (0.460014ms)
✔ loadWorkerProfile rejects inherited registry names (0.244642ms)
✔ loadWorkerProfile ignores an executablePath supplied in the job body (0.216751ms)
✔ worker-results accepts exactly one result row per occurrence (6.705512ms)
✔ worker-results rejects a second insert for the same occurrence (2.759002ms)
✔ worker-results: claims exclude competing connections and cannot be overwritten by insert (4.768227ms)
✔ worker-results: daily limit is shared across connections and counts every claim status (2.852232ms)
✔ worker-results: daily limit uses UTC days, start-inclusive and end-exclusive (3.611758ms)
✔ worker-results: uncommitted outer transactions cannot admit a worker (2.688041ms)
✔ worker-results: refuses in-memory and temporary stores (1.37672ms)
✔ worker-run: loads the profile, runs its absolute CLI, and stores one accepted result (89.186863ms)
✔ worker-run: ignores any executablePath on the job body (106.379957ms)
✔ worker-run: exhausted budget is rejected without spawning (5.671454ms)
✔ worker-run: a second insert for the same occurrence is rejected (47.409428ms)
✔ worker-run: concurrent occurrence calls spawn once without spending duplicate budget (105.190037ms)
✔ worker-run: budget denial leaves no claim behind (61.493448ms)
✔ worker-run: completed result and duplicate survive reopening the profile DB (49.955218ms)
✔ worker-run: crash after committed claim blocks restart before budget or spawn (122.367621ms)
✔ worker-run: runner failure remains non-retryable after restart (6.43459ms)
✔ worker-run: failure persisting a spawned result never releases its claim (81.596414ms)
✔ worker-run: concurrent processes sharing a profile spawn only once (174.065342ms)
✔ worker-run: an interrupt write failure leaves the original claim blocking retries (52.070244ms)
✔ worker-run: admission samples the clock only after winning the writer lock (559.713219ms)
✔ worker-run: a worker timeout is rejected, not completed, and leaves the claim interrupted (63.04642ms)
✔ worker-run: a nonzero worker exit is rejected, not completed, and leaves the claim interrupted (36.557224ms)
✔ worker-run: a successful result is still accepted and completed unchanged (46.070028ms)
✔ worker-runner: argv carries every isolation flag and runs in the given cwd (77.682494ms)
✔ worker-runner: well-formed output is accepted (73.032837ms)
✔ worker-runner: timeout kills the whole process group (514.599988ms)
✔ worker-runner: oversized output is rejected and the child is killed (45.751616ms)
✔ worker-runner: malformed output is rejected (104.31011ms)
✔ worker-runner: non-zero exit is rejected even with output (76.657386ms)
✔ worker-runner: relative CLI path is refused (2.55052ms)
ℹ tests 296
ℹ suites 0
ℹ pass 296
ℹ fail 0
ℹ cancelled 0
ℹ skipped 0
ℹ todo 0
ℹ duration_ms 44172.906848
S6 packed tarball identities: {"pi-hermes-gateway-protocol":{"name":"pi-hermes-gateway-protocol","version":"0.0.0","sha256":"90ebc61af3dc2ff1f01394a32893f9e5f0108276cf842e5e29356e65bf0de3a8"},"pi-hermes-gateway-core":{"name":"pi-hermes-gateway-core","version":"0.0.0","sha256":"d7a88c33132e910229c7222b8271aabcfe0dc2520c19be3a04c6a439a9ede436"},"pi-hermes-gateway-adapter-telegram":{"name":"pi-hermes-gateway-adapter-telegram","version":"0.0.0","sha256":"163d15c74a54fe8fdf0466310c870102fb98dab8726a469ad6213fd9e01639ad"},"pi-hermes-gateway-adapter-whatsapp":{"name":"pi-hermes-gateway-adapter-whatsapp","version":"0.0.0","sha256":"ef45e26c8e4b523c9cf8c2963fc0735509e2a0809164230f84f40ef5b03c3701"},"pi-hermes-gateway-adapter-slack":{"name":"pi-hermes-gateway-adapter-slack","version":"0.0.0","sha256":"5f37b6d633f66b3977fd0f91d794d2bffac1cf97c540fc74e3a2d27730272eb8"},"pi-hermes-gateway-companion":{"name":"pi-hermes-gateway-companion","version":"0.0.0","sha256":"bd5b1a8263ae547094887818f9aebe64b98be8ac180e8f8cc2fc95e0cf690a62"},"pi-hermes-gateway-dashboard":{"name":"pi-hermes-gateway-dashboard","version":"0.0.0","sha256":"cd42bfd7118a06fcf8af09d9310d05a0c1820ed39532ef2d6553131a0e837a47"},"pi-hermes-gateway-wiki":{"name":"pi-hermes-gateway-wiki","version":"0.0.0","sha256":"ed0adfcfee149cde931211c09cb56e6d650df7a215a7bd75302c58fa6e783652"}}
✔ s6 packed tarballs install in a disposable npm home without publish (12047.356761ms)
ℹ tests 1
ℹ suites 0
ℹ pass 1
ℹ fail 0
ℹ cancelled 0
ℹ skipped 0
ℹ todo 0
ℹ duration_ms 12185.759554

> pi-hermes-gateway-adapter-telegram@0.0.0 test
> npm run build && node --experimental-strip-types --test test/*.test.ts && node test/g4-pack-import.mjs


> pi-hermes-gateway-adapter-telegram@0.0.0 build
> tsc -p tsconfig.json

✔ apiOrigin is used instead of api.telegram.org (1.714894ms)
✔ default post mock 200 + message_id is accepted and does not retry (34.215275ms)
✔ default post timeout/abort is commit-unknown with no retry and no token (83.87344ms)
✔ loader supplies default post so telegram send hits the local mock server (5.042909ms)
✔ dedicated-bot config only; invalid token is not echoed (1.436591ms)
✔ origin policy rejects non-loopback HTTP before posting and permits HTTPS or exact loopback (1.619322ms)
✔ mock sendMessage success returns accepted provider id (0.386713ms)
✔ HTTP 500 with ok:true body is commit-unknown, not accepted (0.221632ms)
✔ 2xx ok:true with missing message_id is commit-unknown, not the deliveryId (0.215632ms)
✔ 2xx ok:true with invalid message_id is commit-unknown (0.389363ms)
✔ 2xx with body error (ok:false) is commit-unknown (0.451453ms)
✔ mock sendMessage timeout is commit-unknown (0.210731ms)
✔ thrown HTTP errors redact the token and stay commit-unknown (0.297602ms)
✔ source never mentions getUpdates or setWebhook (0.527454ms)
✔ createAdapter is a structural send adapter (0.179231ms)
ℹ tests 15
ℹ suites 0
ℹ pass 15
ℹ fail 0
ℹ cancelled 0
ℹ skipped 0
ℹ todo 0
ℹ duration_ms 281.971995

> pi-hermes-gateway-protocol@0.0.0 build
> tsc -p tsconfig.json


> pi-hermes-gateway-adapter-telegram@0.0.0 build
> tsc -p tsconfig.json


added 2 packages, and audited 3 packages in 1s

found 0 vulnerabilities
{"files":6,"imported":{"adapterId":"telegram"}}

> pi-hermes-gateway-adapter-whatsapp@0.0.0 test
> npm run build && node --experimental-strip-types --test test/*.test.ts && node test/g4-pack-import.mjs


> pi-hermes-gateway-adapter-whatsapp@0.0.0 build
> tsc -p tsconfig.json

✔ auth dir is a fixed child of the gateway profile dir and never a config value (1.797394ms)
✔ defaultWhatsAppSend without socket deps is unconfigured, opens nothing, sends nothing (1.32652ms)
✔ fake socket send opens under the profile auth dir, sends the text, closes, and is accepted (1.082568ms)
✔ socket without a close method still sends and is accepted (1.436022ms)
✔ missing or blank provider message id is ok-without-id and commit-unknown via the adapter (1.147079ms)
✔ hung socket send is timeout, the socket is closed, and there is no retry (13.127132ms)
✔ a socket that opens after the timeout is closed and never sends (7.123025ms)
✔ socket open errors redact the auth dir path and the session secret and stay commit-unknown (2.232807ms)
✔ sendMessage errors are commit-unknown and the socket is still closed (0.335353ms)
✔ createWhatsAppSend rejects missing socket factory or profile dir before any send (0.590905ms)
✔ inbound events are discarded without store, reply, or read-marking (0.943757ms)
✔ discardInbound ignores missing hooks and does not persist the payload (0.148852ms)
✔ source has no inbound store, reply, or read-marking (0.462343ms)
✔ gateway loader loads whatsapp like telegram and injects the unconfigured default sender (2.46966ms)
✔ openGateway still defaults to fake when whatsapp exists (0.395073ms)
✔ injected timeout through a loaded factory is commit-unknown once (no adapter retry) (0.326653ms)
✔ send-only config only; secrets and auth dirs are not echoed (2.173287ms)
✔ injected send success returns accepted provider id (0.694975ms)
✔ injected sync ok with missing providerMessageId is commit-unknown, no fake id (0.253562ms)
✔ injected sync ok with empty/whitespace providerMessageId is commit-unknown, no fake id (0.216191ms)
✔ injected Promise ok with missing providerMessageId is commit-unknown, no fake id (0.403863ms)
✔ injected Promise ok with empty providerMessageId is commit-unknown, no fake id (0.329102ms)
✔ injected Promise ok with nonempty providerMessageId is accepted (0.221591ms)
✔ injected send timeout is commit-unknown with no retry (0.539854ms)
✔ unknown send is commit-unknown (1.425441ms)
✔ thrown send errors redact session secrets and stay commit-unknown (0.393513ms)
✔ createAdapter is a structural send adapter without a live socket (1.845234ms)
✔ package is private npm-only, depends only on protocol, and source bundles no socket library (0.806237ms)
ℹ tests 28
ℹ suites 0
ℹ pass 28
ℹ fail 0
ℹ cancelled 0
ℹ skipped 0
ℹ todo 0
ℹ duration_ms 186.402904

> pi-hermes-gateway-protocol@0.0.0 build
> tsc -p tsconfig.json


> pi-hermes-gateway-adapter-whatsapp@0.0.0 build
> tsc -p tsconfig.json


added 2 packages, and audited 3 packages in 930ms

found 0 vulnerabilities
{"files":6,"imported":{"adapterId":"whatsapp","reason":"whatsapp-socket-unconfigured"}}

> pi-hermes-gateway-adapter-slack@0.0.0 test
> npm run build && node --experimental-strip-types --test test/*.test.ts && node test/g4-pack-import.mjs


> pi-hermes-gateway-adapter-slack@0.0.0 build
> tsc -p tsconfig.json

✔ apiOrigin is used instead of slack.com (1.777513ms)
✔ default post mock 200 + ts is accepted and does not retry (46.366949ms)
✔ default post timeout/abort is commit-unknown with no retry and no token (89.214161ms)
✔ loader supplies default post so slack send hits the local mock server (12.184724ms)
✔ gateway loader loads slack (3.527808ms)
✔ openGateway still defaults to fake when slack exists (1.396001ms)
✔ bot-token config only; invalid token is not echoed (1.828955ms)
✔ origin policy rejects non-loopback HTTP before posting and permits HTTPS or exact loopback (1.843335ms)
✔ mock chat.postMessage success returns accepted provider id (0.468374ms)
✔ HTTP 500 with ok:true body is commit-unknown, not accepted (0.381623ms)
✔ 2xx ok:true with missing ts is commit-unknown, not the deliveryId (0.236502ms)
✔ 2xx ok:true with invalid ts is commit-unknown (0.328432ms)
✔ 2xx with body error (ok:false) is commit-unknown (0.223402ms)
✔ mock chat.postMessage timeout is commit-unknown (0.376523ms)
✔ thrown HTTP errors redact the token and stay commit-unknown (0.680836ms)
✔ source never mentions Events API or Socket Mode (0.832607ms)
✔ createAdapter is a structural send adapter (0.286933ms)
✔ package is private npm-only with no pi key (0.231502ms)
ℹ tests 18
ℹ suites 0
ℹ pass 18
ℹ fail 0
ℹ cancelled 0
ℹ skipped 0
ℹ todo 0
ℹ duration_ms 338.034779

> pi-hermes-gateway-protocol@0.0.0 build
> tsc -p tsconfig.json


> pi-hermes-gateway-adapter-slack@0.0.0 build
> tsc -p tsconfig.json


added 2 packages, and audited 3 packages in 1s

found 0 vulnerabilities
{"files":6,"imported":{"adapterId":"slack"}}

> pi-hermes-gateway-companion@0.0.0 test
> npm run build && node --experimental-strip-types --test test/*.test.ts && node test/g4-pack-import.mjs


> pi-hermes-gateway-companion@0.0.0 build
> tsc -p tsconfig.json

✔ importing companion does not start a daemon or mention Telegram transport (1.16655ms)
✔ status and enqueue without a daemon report unavailable and start nothing (0.404393ms)
✔ session_start does not start a daemon or open Telegram (0.334263ms)
✔ gateway_status reports worker unavailable without starting a daemon (2.266728ms)
✔ gateway_status distinguishes a daemon rejection from unavailability (9.800256ms)
ℹ tests 5
ℹ suites 0
ℹ pass 5
ℹ fail 0
ℹ cancelled 0
ℹ skipped 0
ℹ todo 0
ℹ duration_ms 173.409873

> pi-hermes-gateway-protocol@0.0.0 build
> tsc -p tsconfig.json


> pi-hermes-gateway-companion@0.0.0 build
> tsc -p tsconfig.json


added 2 packages, and audited 3 packages in 1s

found 0 vulnerabilities
{"files":14,"imported":{"unavailable":true}}

> pi-hermes-gateway-dashboard@0.0.0 test
> npm run build && node --experimental-strip-types --test test/*.test.ts && node test/g4-pack-import.mjs


> pi-hermes-gateway-dashboard@0.0.0 build
> tsc -p tsconfig.json

✔ collectStatus reads jobs, occurrences, and deliveries from a temp profile DB (3.557467ms)
✔ collectStatus bounds list length (14.405952ms)
✔ collectStatus truncates text fields (1.602513ms)
✔ collectStatus lists pending-approval jobs and deliveries (1.547222ms)
✔ collectStatus counts and lists from one snapshot when a writer commits between them (2.330618ms)
✔ collectStatus throws when the profile DB is missing (0.941698ms)
✔ GET / and GET /api/status serve a temp profile DB (40.132881ms)
✔ unexpected Host is 403; localhost with port is allowed (15.183007ms)
✔ configured bind host is accepted and others stay forbidden (3.415726ms)
✔ mutating HTTP methods are 405 and do not enqueue (9.988487ms)
✔ unknown paths and traversal are 404 (5.430432ms)
✔ collection failure is 503 without leaking the error (3.718499ms)
✔ missing profile DB is 503 (3.313686ms)
✔ package is private npm plugin, not a Pi package; source has no enqueue (0.498354ms)
✔ /api/status without or with a wrong bearer token is 401 and does not collect (6.220508ms)
✔ /api/status with the owner token returns job and delivery text (2.765671ms)
✔ forged Host is 403 even with the owner token, and never collects (4.676447ms)
✔ Host with a non-numeric or empty port suffix is 403 even with the owner token, and never collects (9.707425ms)
✔ non-loopback or hostname bind is rejected before listening (2.551999ms)
✔ numeric loopback binds 127.0.0.0/8 and ::1 listen (5.454462ms)
✔ missing, symlinked, group/other-readable or weak token file fails closed (2.824912ms)
✔ token file must hold exactly 64 lowercase hex characters (2.323948ms)
﹣ token file owned by another uid fails closed (0.162381ms) # chown to another uid needs root
✔ page and error responses never contain the token; page keeps it in memory only (5.901376ms)
ℹ tests 24
ℹ suites 0
ℹ pass 23
ℹ fail 0
ℹ cancelled 0
ℹ skipped 1
ℹ todo 0
ℹ duration_ms 322.223245

> pi-hermes-gateway-dashboard@0.0.0 build
> tsc -p tsconfig.json


added 1 package, and audited 2 packages in 618ms

found 0 vulnerabilities
{"files":6,"imported":{"listLimit":100}}

> pi-hermes-gateway-wiki@0.0.0 test
> npm run build && node --experimental-strip-types --test test/*.test.ts && node test/g4-pack-import.mjs


> pi-hermes-gateway-wiki@0.0.0 build
> tsc -p tsconfig.json

✔ empty notes yield empty article and concept indexes (2.806012ms)
✔ missing notes directory yields empty indexes (0.556014ms)
✔ compiles a note into an article using the H1 title (2.774671ms)
✔ extracts [[wikilinks]] into concept pages (1.31538ms)
✔ unicode titles and concepts are preserved (1.093598ms)
✔ NFC-normalizes equivalent unicode concept spellings (0.875667ms)
✔ compile is byte-identical across runs (1.735854ms)
✔ ignores non-markdown files and does not recurse (0.769606ms)
✔ [[Target|label]] uses Target as the concept (0.743696ms)
✔ recompile removes stale article and concept files (1.37969ms)
✔ duplicate wikilinks on one note collapse; concept lists articles sorted (0.848727ms)
ℹ tests 11
ℹ suites 0
ℹ pass 11
ℹ fail 0
ℹ cancelled 0
ℹ skipped 0
ℹ todo 0
ℹ duration_ms 186.02317

> pi-hermes-gateway-wiki@0.0.0 build
> tsc -p tsconfig.json


added 1 package, and audited 2 packages in 731ms

found 0 vulnerabilities
{"files":6,"imported":{"compileWiki":"function"}}
```

### Typecheck after fix, raw output

```text

> pi-hermes-gateway@0.0.0 typecheck
> npm run build -w pi-hermes-gateway-protocol && npm run typecheck -w pi-hermes-gateway-protocol && npm run typecheck -w pi-hermes-gateway-core && npm run typecheck -w pi-hermes-gateway-adapter-telegram && npm run typecheck -w pi-hermes-gateway-adapter-whatsapp && npm run typecheck -w pi-hermes-gateway-adapter-slack && npm run typecheck -w pi-hermes-gateway-companion && npm run typecheck -w pi-hermes-gateway-dashboard && npm run typecheck -w pi-hermes-gateway-wiki


> pi-hermes-gateway-protocol@0.0.0 build
> tsc -p tsconfig.json


> pi-hermes-gateway-protocol@0.0.0 typecheck
> tsc -p tsconfig.json --noEmit


> pi-hermes-gateway-core@0.0.0 typecheck
> tsc -p tsconfig.json --noEmit


> pi-hermes-gateway-adapter-telegram@0.0.0 typecheck
> tsc -p tsconfig.json --noEmit


> pi-hermes-gateway-adapter-whatsapp@0.0.0 typecheck
> tsc -p tsconfig.json --noEmit


> pi-hermes-gateway-adapter-slack@0.0.0 typecheck
> tsc -p tsconfig.json --noEmit


> pi-hermes-gateway-companion@0.0.0 typecheck
> tsc -p tsconfig.json --noEmit


> pi-hermes-gateway-dashboard@0.0.0 typecheck
> tsc -p tsconfig.json --noEmit


> pi-hermes-gateway-wiki@0.0.0 typecheck
> tsc -p tsconfig.json --noEmit

```

### Build after fix, raw output

```text

> pi-hermes-gateway@0.0.0 build
> npm run build -w pi-hermes-gateway-protocol && npm run build -w pi-hermes-gateway-core && npm run build -w pi-hermes-gateway-adapter-telegram && npm run build -w pi-hermes-gateway-adapter-whatsapp && npm run build -w pi-hermes-gateway-adapter-slack && npm run build -w pi-hermes-gateway-companion && npm run build -w pi-hermes-gateway-dashboard && npm run build -w pi-hermes-gateway-wiki


> pi-hermes-gateway-protocol@0.0.0 build
> tsc -p tsconfig.json


> pi-hermes-gateway-core@0.0.0 build
> tsc -p tsconfig.json


> pi-hermes-gateway-adapter-telegram@0.0.0 build
> tsc -p tsconfig.json


> pi-hermes-gateway-adapter-whatsapp@0.0.0 build
> tsc -p tsconfig.json


> pi-hermes-gateway-adapter-slack@0.0.0 build
> tsc -p tsconfig.json


> pi-hermes-gateway-companion@0.0.0 build
> tsc -p tsconfig.json


> pi-hermes-gateway-dashboard@0.0.0 build
> tsc -p tsconfig.json


> pi-hermes-gateway-wiki@0.0.0 build
> tsc -p tsconfig.json

```
