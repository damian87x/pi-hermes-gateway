# S0 conductor candidate closeout — ACCEPTED (local S0 only)

## Scope

S0 foundation only. M1 and the owner's always-on messaging outcome are NOT complete. No daemon, scheduler, live Telegram/WhatsApp, model worker, publication or account migration is accepted here. No push, PR, merge or service activation was authorised/performed by this conductor.

Frozen contract: `docs/evidence/s0/contract.md`; technical correction ruling: `docs/evidence/s0/fix-r1-contract.md`. Repository location is the user's chosen `apps/pi-hermes-gateway`, not the earlier proposed sibling name. Mutation worktree `apps/pi-hermes-gateway-s0`, branch `feat/s0-foundation`. Baseline `4035d5b...`; reviewed candidate `82d0de5dae6229ff0983267e4b26bdafe99a4178`. Full base and digest values are in `g7-receipt.md` and the preserved launcher receipts.

## Independent final candidate scoreboard

| Stage | Native model | Session | Verdict | Evidence |
|---|---|---|---|---|
| G1–G7 + code safety | claude-opus-5 | bb4487b9-a0f7-420a-897e-315d68288326 | PASS | docs/evidence/s0-review/r2-code-safety/summary.json |
| Spec compliance | claude-opus-5 | 6a2cc5c6-6d48-4d16-bd84-f4b3d695ebcd | PASS | docs/evidence/s0-review/r2-spec/summary.json |
| Origin/AC conformance, plan skipped | claude-opus-5 | b832030c-900f-40d9-88ba-681f23f57e84 | PASS with AC7 record gaps | docs/evidence/s0-review/r2-conformance/summary.json |
| Observable S0 outcome | claude-opus-5 | f9a2a215-1f9b-40df-b5f6-0fee3e10955c | PASS | docs/evidence/s0-review/r2-outcome/summary.json |

All attest the same candidate/diff. Code-safety independently reran G1–G7: 39 tests, zero skips/failures; clean packed imports and module-root checks. Outcome exercised two offline consumers, 90 behavior cases and 15 identity invariants; passive-import guard had a discriminating negative control. These are observed S0 results, not future-message-delivery proof. Original worker was xai/grok-4.6; the fresh correction worker used the same exact route. No parent product-code edits or gate execution.

## Evidence adjudication

- Conformance identified absent tracked diff values and a dangling G7 path, even though it independently recomputed the correct values. Persistent launcher receipts already existed outside the new repo; the assertion that they existed only in transient terminal output was incomplete context, not grounds for dropping the finding.
- Parent copied the exact original post-commit receipts into `docs/evidence/s0/receipts/` and created the promised `g7-receipt.md`, with explicit initial/final candidate labels. This closes portability/pointer gaps only if the fresh evidence auditor verifies the actual files.
- Final verdict/native-result/raw evidence directories were copied without reauthoring conclusions. They remain a separate uncommitted evidence supplement. Product candidate SHA has not been advanced to claim review of an evidence-only commit.
- Evidence-only audit PASS: native claude-opus-5 session c98989ab-8336-4a59-96fc-95ff1d6c46f4. Product identity/digest and zero tracked modifications were independently recomputed; 56 reviewer-identity checks and 39 raw-path references passed. See docs/evidence/s0-review/r2-evidence-audit/summary.json. Prior test results remain labelled prior, not freshly rerun.
- The conformance packedFiles=32 entry is a reporting/count-basis error: its own raw log lists 34 total files, identical across all stages; 32 counts only dist files. Original report preserved, audit erratum in AUD-7.
- Parent accepts the frozen S0 product candidate 82d0de5. Supplement is to be retained in a separate evidence-only commit; this is not a new product candidate or a claim that product reviews attested a later commit. No product test rerun or new product correction is warranted by the evidence audit.
- Scope limit: auditor did not compare copies against sibling/.pi/tasks originals; it checked in-project identities and independently recomputed content digests. Timestamp consistency is corroboration, not hostile-tamper-proof authentication.

## Carry-forward risks and decisions

Nonblocking S0 findings: inherited-property/accessor handling for in-process non-JSON objects; mutable exported constants; valid years 0000–0099 over-rejected. No new hardening is implicitly authorised by this closeout.

Before S1 scheduler contract: explicitly settle past-dated once-job admission/skip behavior and delivery expiry anchoring (scheduled instant vs catch-up enqueue). The reviewed plan already defaults missed occurrences to skip with optional single latest catch-up; do not erase that approved rule. Also specify audit preservation/quarantine across database restores. These policy questions are not silent product fixes.

Owner namespace/publication identity and outbound project license remain undecided. All current packages remain private and unpublished. Node v24.20.0 was the measured runtime; other versions and host service behavior are unverified.

## Remaining inventory

- S0: ACCEPTED locally; four product reviews and separate evidence audit PASS. Review applies to frozen product revision 82d0de5, with the evidence supplement separately retained.
- S1 durable fake-adapter core: not dispatched, needs lane contract.
- S2 lifecycle/Pi companion, S3 Telegram, S6 M1 distribution: pending.
- M1b WhatsApp and M2–M5: later milestones, no completion claims.
