# S1 technical correction 10 — conductor ruling

Owner: fix and move on under conductor.
Start 064dae727ed76ad0306f2acfe881ce8c51dafd68.
Opus r9: code-safety PASS, spec REJECT session d38af441-1772-4615-ace0-b20fb9d4e8c6.

## Required (AC3)

Under `one-latest`, never send two slots of the same daily job in one tick. If any on-time instant exists, skip missed instants. Clock-jump over two due slots on a DST-shortened day with wake inside grace must send **1**, not 2.

TestClock test for Europe/Berlin 2026-03-28/29 (or equivalent) wake within grace.

Lows deferred. TDD first. Fresh Grok. 40 minutes. Evidence docs/evidence/s1/fix-r10/. No push.
