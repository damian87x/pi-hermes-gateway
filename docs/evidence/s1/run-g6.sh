#!/usr/bin/env bash
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/../../.." && pwd)"
cd "$ROOT"
python3 - <<'PY'
from pathlib import Path
root = Path(".")
required = [
    "docs/architecture.md",
    "docs/security.md",
    "docs/parity.md",
    "docs/migration.md",
    "docs/provenance.md",
    "README.md",
    "packages/gateway/README.md",
]
missing = [p for p in required if not (root / p).exists()]
if missing:
    raise SystemExit(f"missing docs: {missing}")
texts = []
for p in required:
    texts.append((p, (root / p).read_text()))
joined = "\n".join(t for _, t in texts)
lower = joined.lower()
for needle in ["scheduledinstant", "one latest", "quarantine", "node:sqlite"]:
    if needle not in lower:
        raise SystemExit(f"docs missing policy term: {needle}")
license_files = list(root.glob("LICENSE*")) + list(root.glob("**/LICENSE*"))
license_files = [p for p in license_files if "node_modules" not in p.parts]
if license_files:
    raise SystemExit(f"license files present: {license_files}")
print("requiredDocs", len(required))
print("licenseFiles", 0)
print("G6_OK")
PY
