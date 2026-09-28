# S1 technical correction 7 — conductor ruling

Owner: fix and move on under conductor.
Start 680e67b52e5a777f94369ec072a43aedcc7b7cd4.
Opus r6: code-safety PASS, spec PASS, conformance REJECT (session 84ece7a7-a20c-4c78-baf8-be065759ab99). Outcome not run.

## Required (AC5)

Crash-consistent request dedup. After mid-send kill, retrying the same requestId within TTL must return the existing delivery (id + status, e.g. commit-unknown) without consuming fuses and without UNIQUE crash.

Wrap IPC handleRequest so exceptions return an error frame instead of exiting the daemon.

Regression: real or equivalent kill mid-send, restart, same requestId retry, 0 extra sends, daemon stays up.

Lows deferred. No push. Fresh Grok. TDD first. 40 minutes. Evidence docs/evidence/s1/fix-r7/.
