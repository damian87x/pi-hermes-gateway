# S1 technical correction 8 — conductor ruling

Owner: fix and move on under conductor.
Start 06a79add33dac962582518ffeb862e685221fcee.
Opus r7 code-safety REJECT session ffb83a42-c647-45bb-839e-bf87f8abc71b.
Crash-consistent requestId independently verified fixed.

## Required

IPC must not exit the daemon on client disconnect. Per-connection `sock.on('error')` (and server error handler). Client writes one frame and destroys immediately; daemon must still answer the next request.

Lows deferred. TDD first. Fresh Grok. 40 minutes. Evidence docs/evidence/s1/fix-r8/. No push.
