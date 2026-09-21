# S1 technical correction 1 — conductor ruling

Implementation candidate: f5c88a4323bdf8d3a2e1f30aee7eb8dd63195678.
Independent native Claude CLI requested `opus`, observed `claude-opus-5`, session 72451921-ed6c-457c-af55-0f6c559ed448. Code-safety **REJECT**. Spec/conformance/outcome were not run. Evidence preserved under docs/evidence/s1-review/r1-code-safety/.

Parent holds S1 because four High findings violate frozen AC2/AC3/AC5 and policies 2, 3, 7. This is correction attempt 1 of 3. Not a new architecture.

## Owner rulings frozen here (do not re-open)

1. **Lock:** no undeclared `python3` runtime dependency. Node-only exclusive profile lock. Prefer stdlib (`fs` exclusive open / SQLite exclusive locking). No native addon. Helper-exit must fail closed; second instance must not write.
2. **Quarantine exit:** dispatch resumes only via an **explicit operator command** after reconciliation. Never auto-exit. Restoring a backup must quarantine before any tick.

## Required fixes (findings preserved verbatim in r1-code-safety/summary.json)

H1 DST: first fold, not second; do not skip valid adjacent local times; AU/NZ tests vs brute-force oracle.
H2 Restore: materialize (backup, recovery] as skipped/commit-unknown, advance watermark, no resurrection of already-sent slots as queued; refuse admission while quarantined.
H3 Daemon/CLI: real advancing clock; tick ≤60s; TestClock only when injected.
H4 Lock liveness: Node-only; helper/process death releases ownership fail-closed; no split-brain writers.
M1 On open, convert stuck `dispatching` rows to `commit-unknown` with audit; SIGKILL/child-process coverage where cheap.
M2 Explicit restore entry that quarantines before tick.

Do not fold Low items (WAL backup, transactions, @types/node) unless they fall out of the same root-cause edit. Do not add transports, Pi, systemd, or publish.

## Allowlist / gates

Same S1 allowlist. Include copied r1-code-safety evidence and this ruling in the commit. Fresh Grok 4.6; TDD the failing probes first. 40 minutes; last 5 for report/commit. If incomplete, BLOCKED with remaining High items, never fake PASS.

Write docs/evidence/s1/fix-r1/worker-summary.json. Native Opus code-safety must re-attest the new SHA; prior REJECT stays historical.
