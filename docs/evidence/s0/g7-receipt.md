# G7 post-commit receipts — immutable candidate identities

This evidence-only supplement was assembled by the conductor after the reviews. It is not part of either reviewed commit and does not claim an evidence commit has been code-reviewed. Original worker summaries retain candidateSha:null to avoid self-reference; exact post-commit launcher receipts are preserved below rather than rewriting history.

| Candidate | Base | Raw git diff base..candidate SHA-256 | Post-worker tracked/untracked status |
|---|---|---|---|
| Initial: `0da0a1d2e2d71b482df98d186e743a2e3a9e9603` | `4035d5b60c4ed611f9a81b2f9ca850682b62fb7b` | `e148a206ce5b0e7b3fbf3cc6b44d40a11b3e94c2530bdc700dbfac2f8606a080` | Empty, as captured in initial-worker.json |
| Corrected S0: `82d0de5dae6229ff0983267e4b26bdafe99a4178` | `4035d5b60c4ed611f9a81b2f9ca850682b62fb7b` | `9d68ca943f130b237eab6a1b71edfbffa0c1f63619258e985e88ff0c6ab461af` | Empty, as captured in fix-r1-worker.json |

## Durable project-relative sources

- `docs/evidence/s0/receipts/initial-worker.json`: actual initial worker process/model/session-output receipt and post-commit identity/status.
- `docs/evidence/s0/receipts/fix-r1-worker.json`: actual correction worker receipt and post-commit identity/status.
- `docs/evidence/s0/receipts/ladder-r2.json`: four-stage dispatch scoreboard, not a substitute for the stage verdicts.
- `docs/evidence/s0-review/r2-code-safety/g7-source-unchanged.txt`: independent final candidate identity/cleanliness verification before/after tests.
- `docs/evidence/s0-review/r2-conformance/g0-identity.txt`: independent origin-conformance identity check.
- `docs/evidence/s0-review/r2-outcome/raw/11-final-state.txt`: independent observable-outcome final state check.
- Each `docs/evidence/s0-review/r2-*/native-receipt.json` and `native-result.json` preserves native Claude session identity, observed model and verdict output.

All four final reviews attest `82d0de5...`, not an arbitrary later HEAD. R1 acceptance is historical and does not replace corrected-source verification. No product verification was run by the parent. Evidence appended after the candidate remains an explicitly separate uncommitted supplement until authorised closeout handling; it must not be represented as part of the reviewed candidate. Current supplement containment and pointer integrity require the delegated evidence-only closeout check.
