# S1 technical correction 4 — conductor ruling

Human, after three rejects: "ok fix this conitnue"

Pinned start: ea773fc7ab0435bc2742562f069408289f1c2e48.
Opus `claude-opus-5` session b83d8740-dd5d-46f4-b397-6755d215d254 REJECT.
All prior Highs (including H5) independently verified fixed.

This extra round is only the two Mediums that still violate frozen policy 3 / AC3.

## Required

1. **Atomic restore:** validate backup read-only first (opens, user_version <= SCHEMA_VERSION, integrity). Copy to temp in the profile dir, stamp quarantine=1 / dispatch_enabled=0 on the temp copy, fsync, move live DB + wal/shm aside (preserved), rename temp into place. Newer-schema or non-DB backup must leave the live DB intact. After any interruption: original live DB or quarantined restored DB — never torn, never auto-resend.

2. **Tick grace:** grace must exceed tick interval by a real margin (e.g. tick 30s / grace 60s, or grace >= interval + several seconds), or classify missed from the previous tick watermark. Default skip must not drop an on-time slot because setInterval ran a few ms late. Test interval-sized gaps plus millisecond lateness.

Do not fold Lows (daily skip receipts, enqueue during quarantine, deleting lock file) unless they fall out of the same edit. No transports, no python3, no push.

Same S1 allowlist. Fresh Grok 4.6. TDD failing probes first. 40 minutes. Evidence docs/evidence/s1/fix-r4/. Include copied r3-code-safety evidence. worker-summary.json candidateSha null.
