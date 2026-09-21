# S1 technical correction 6 — conductor ruling

Owner: "fix and move on you sholdshould use conductor leather"

Start 9ee0883fb1b272f57494b702a34c40b57c047b9a.
Opus claude-opus-5 session 3d9a2210-e93c-4a70-8a58-e98c3e9c4e12 REJECT.
Prior Highs and r4/r5 Mediums independently verified fixed.

## Required

Materialize restore skips and watermark advance **before** the live swap, or persist restore_pending + backup/recovery times on the temp copy so the next open finishes materialization and **blocks --resume-dispatch** until then.

Kill after swap, before restoreQuarantine, then resume must send **0** extra messages under one-latest and default skip.

Same S1 allowlist. TDD first. Lows deferred unless they fall out of this edit. No push. Fresh Grok. 40 minutes. Evidence docs/evidence/s1/fix-r6/.
