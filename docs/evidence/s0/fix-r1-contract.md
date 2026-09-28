# S0 technical correction 1 — conductor ruling

Implementation candidate: 0da0a1d2e2d71b482df98d186e743a2e3a9e9603.
Independent native Claude CLI requested `opus`, observed `claude-opus-5`, session eb8ba0e6-3c5f-4793-bd34-65995488c7cd. Code-safety/G1–G7 PASS applies ONLY to that candidate. No other review class has run. Native receipt and complete independent summary/raw evidence preserved under docs/evidence/s0-review/r1-code-safety/.

The parent holds S0 acceptance because findings F1 and F2 directly undermine frozen AC3: bounded expiry and rejecting malformed schedules. This is a narrow technical correction, not a new architecture/security-policy decision. Fixing them invalidates final-source applicability of prior gate PASS; affected independent verification and all four final review stages must attest the new candidate.

## Required fixes (reviewer findings are preserved verbatim in summary.json)

F1: `validateWireRequest` and `validateStaticDelivery` accept invalid caller clock values (undefined/NaN/non-number), silently bypassing expiry. Validate nowMs, fail closed with a stable error, add regression tests in both entry points. Use consistent clock-validation semantics. Audit all existing callers of the touched helpers; do not build future callers.

F2: once schedule validation accepts nonexistent dates such as 2026-02-30 and 2026-04-31 and silently rolls forward. Reject nonexistent calendar dates; preserve supported valid UTC/fractional forms. A valid ISO end-of-day form is not itself the reported defect. Add leap/non-leap and month-boundary regressions. Do not introduce scheduling execution or new future-horizon policy.

F3–F6 remain recorded findings for the remaining independent review stages. Do not fold unrelated hardening, global freezing, prototype/accessor policy, or job horizon decisions into this correction. If a required fix cannot be made without one of those decisions, stop with the concrete ambiguity.

## Allowlist / gates

Code changes limited to packages/protocol/src/{wire,delivery,jobs,check}.ts (shared check helper only if needed), relevant existing protocol test files, and docs/evidence/**. Small documentation adjustments only if needed to state the corrected existing behavior. No package/dependency/version changes, no architecture refactor, no outside project mutations.

Fresh Grok 4.6 context, no resumption of the original worker. TDD: reproduce F1/F2 failing cases on the candidate first, then minimal fix and relevant/full tests, typecheck, build, G4/G5 imports. Original S0 authority and no-push/no-live restrictions unchanged. Commit locally on feat/s0-foundation. Include newly copied R1 evidence and this ruling in the commit. Existing evidence describes the old SHA and must not be rewritten as current PASS.

40-minute maximum, reserve final 5 minutes for report/commit. Produce docs/evidence/s0/fix-r1/worker-summary.json with compact gate rows, raw evidence paths, changed paths, unresolved findings and next step. Parent consumes summary only; native Opus review follows. This is correction attempt 1 of at most 3 narrowing technical attempts.
