#!/usr/bin/env bash
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/../../.." && pwd)"
cd "$ROOT"
echo "node=$(node -v) path=$(command -v node)"
echo "npm=$(npm -v) path=$(command -v npm)"
echo "project_tsc=$(./node_modules/.bin/tsc --version)"
echo "global_tsc=$(tsc --version 2>/dev/null || true)"
echo "pi=$(pi --version 2>/dev/null || true)"
node -e 'console.log("sqlite", process.versions.sqlite)'
node --input-type=module -e 'import { DatabaseSync } from "node:sqlite"; console.log("node:sqlite", typeof DatabaseSync)'
npm ls --depth=0
npm run typecheck
npm run build
echo G2_OK
