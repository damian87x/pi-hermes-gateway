#!/usr/bin/env bash
set -euo pipefail
ROOT="/home/damian-linux/workspace/billioner-coder/apps/pi-hermes-gateway-s0-review-r2"
cd "$ROOT"
echo "ROOT=$ROOT"
echo "HEAD=$(git rev-parse HEAD)"
echo "BASE=4035d5b60c4ed611f9a81b2f9ca850682b62fb7b"
echo "BRANCH=$(git rev-parse --abbrev-ref HEAD)"
test "$(git rev-parse 4035d5b60c4ed611f9a81b2f9ca850682b62fb7b)" = "4035d5b60c4ed611f9a81b2f9ca850682b62fb7b"
test "$(git rev-parse HEAD)" = "82d0de5dae6229ff0983267e4b26bdafe99a4178"
case "$ROOT" in
  */apps/pi-hermes-gateway-s0-review-r2) ;;
  *) echo "not the isolated s0 worktree"; exit 1 ;;
esac
test ! -d packages/gateway
test ! -d packages/adapter-telegram
test ! -d packages/adapter-whatsapp
test ! -d packages/pi-companion
test ! -d packages/telegram-companion
python3 - <<'PY'
import json, pathlib, sys
root = pathlib.Path(".")
forbidden_scripts = {
    "preinstall","install","postinstall","prepare","preprepare","postprepare",
    "prepublish","prepublishOnly","publish","postpublish","prepack","postpack",
}
bad = []
pkgs = [root / "package.json", *root.glob("packages/*/package.json")]
if not pkgs:
    sys.exit("no package.json")
for p in pkgs:
    data = json.loads(p.read_text())
    if data.get("private") is not True:
        bad.append(f"{p}: private is not true")
    if "license" in data:
        bad.append(f"{p}: license field present")
    if "pi" in data:
        bad.append(f"{p}: pi manifest present")
    scripts = data.get("scripts") or {}
    for name in scripts:
        if name in forbidden_scripts:
            bad.append(f"{p}: lifecycle script {name}")
    if data.get("peerDependencies"):
        bad.append(f"{p}: peerDependencies")
if bad:
    print("\n".join(bad))
    sys.exit(1)
print("private/lifecycle/pi checks ok", [str(p) for p in pkgs])
PY
echo G1_OK
