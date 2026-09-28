#!/usr/bin/env bash
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/../../.." && pwd)"
cd "$ROOT"
for f in docs/architecture.md docs/security.md docs/parity.md docs/migration.md docs/provenance.md README.md packages/protocol/README.md; do
  test -s "$f"
  echo "present $f"
done
test ! -e LICENSE
test ! -e packages/protocol/LICENSE
grep -q "No outbound project license" docs/provenance.md
grep -q "filesystem" docs/security.md
grep -q "commit-unknown" docs/security.md
grep -q "Two loaders" docs/architecture.md
grep -q "static text" docs/parity.md
grep -q "quarantine" docs/migration.md
grep -q "not claim an npm scope" README.md
if grep -R --include='*.ts' -n "from '@earendil-works" packages/protocol/src; then
  echo "protocol imports Pi packages"; exit 1
fi
echo G6_OK
