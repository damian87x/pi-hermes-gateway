# S1 technical correction 5 — conductor ruling

Same restore contract as fix-r4 item 1, still open. Start e1ea846e60bbee2c1abb310512a96cf94bf3e871.
Opus claude-opus-5 session 8b020b34-c47c-4627-929f-f5aed1656f2f REJECT.
Tick-grace medium and prior Highs independently verified fixed.

## Required

Interrupted **second** restore (or missing `gateway.sqlite` with leftover aside files) must not revive a stale unquarantined DB or resend.

Make the in-flight aside name unique and recoverable (journal naming the aside, or always use `.pre-restore` for in-flight and archive older copies first). On plain start, recover only the aside for that in-flight restore. Never revive an older archived DB. Checkpoint WAL before swap if needed so sidecars cannot pair with the wrong main file.

Tests: interrupted second restore recovers the most recent live DB; `gateway.sqlite` absent and no journal must not revive `.pre-restore`.

Do not fold unrelated Lows. No push. Fresh Grok. TDD first. 40 minutes. Evidence docs/evidence/s1/fix-r5/.
