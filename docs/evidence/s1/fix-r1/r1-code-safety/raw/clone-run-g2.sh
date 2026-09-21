#!/usr/bin/env bash
set -euo pipefail
ROOT="/tmp/s1r1-clone"
cd "$ROOT"
echo "node=$(node -v) path=$(command -v node)"
echo "npm=$(npm -v) path=$(command -v npm)"
echo "project_tsc=$(./node_modules/.bin/tsc --version)"
echo "global_tsc=$(tsc --version 2>/dev/null || true)"
echo "pi_path=$(command -v pi || true) (not executed by reviewer)"
node -e 'console.log("sqlite", process.versions.sqlite)'
node --input-type=module -e 'import { DatabaseSync } from "node:sqlite"; console.log("node:sqlite", typeof DatabaseSync)'
npm ls --depth=0
npm run typecheck
npm run build
echo G2_OK
