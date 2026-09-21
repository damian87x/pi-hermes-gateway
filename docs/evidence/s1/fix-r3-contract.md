# S1 technical correction 3 — conductor ruling

Pinned candidate still 2cc27ede72cb984d8de772595b2710ac07d5f62e.
Attempt 2 timed out (exit 124) with no commit; uncommitted test dirt was reverted. This is attempt 3 of 3.

Same High as r2: once-job restore resurrection under one-latest when backup is taken in the tick lag. See docs/evidence/s1-review/r2-code-safety/summary.json.

Reproduce with a failing test first, then the smallest core.ts fix, then full tests. Do not expand into Low findings. 40 minutes; if you cannot land an honest green commit, stop BLOCKED — do not claim PASS.

Evidence docs/evidence/s1/fix-r3/. No push.
