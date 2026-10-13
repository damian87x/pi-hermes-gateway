import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

const evidence = readFileSync(new URL("../../../docs/evidence/finish/fake-systemd-proof.md", import.meta.url), "utf8");
const harness = evidence.split("```bash\n")[1].split("\n```")[0];
// Execute only observation helpers, never the systemd flow or real process/socket tools.
const helpers = harness.slice(harness.indexOf("run() {"), harness.indexOf("cleanup() {"));

function observe(command: string, pgrepOutput = "", pgrepStatus = 1, socketOutput = "", socketStatus = 0) {
  const root = mkdtempSync(join(tmpdir(), "g9-harness-test-"));
  const bin = join(root, "bin");
  mkdirSync(bin);
  writeFileSync(join(bin, "pgrep"), '#!/bin/sh\nprintf "%s" "$PGREP_OUTPUT"\nexit "$PGREP_STATUS"\n', { mode: 0o700 });
  writeFileSync(join(bin, "ss"), '#!/bin/sh\n[ "$*" = "-xH state connected" ] || exit 3\nprintf "%s" "$SOCKET_OUTPUT"\nexit "$SOCKET_STATUS"\n', { mode: 0o700 });
  // id and awk are the only non-fixture commands the helpers need.
  for (const tool of ["id", "awk"]) {
    writeFileSync(join(bin, tool), `#!/bin/sh\nexec /usr/bin/${tool} "$@"\n`, { mode: 0o700 });
  }
  try {
    // The host may prepend /usr/bin to spawned PATH; reset it inside the shell.
    return spawnSync("/bin/bash", ["-c", `set -euo pipefail\nPATH="$FIXTURE_BIN"\n${helpers}\n${command}`], {
      encoding: "utf8", timeout: 5000,
      env: { PATH: bin, FIXTURE_BIN: bin, PROFILE: join(root, "pilot"), PGREP_OUTPUT: pgrepOutput, PGREP_STATUS: String(pgrepStatus), SOCKET_OUTPUT: socketOutput.replaceAll("<pilot>", join(root, "pilot/gateway.sock")), SOCKET_STATUS: String(socketStatus) },
    });
  } finally { rmSync(root, { recursive: true, force: true }); }
}

test("systemd proof accepts and logs empty pgrep status 1", () => {
  const result = observe("show_tuis");
  assert.equal(result.status, 0, result.stderr);
  assert.ok(result.stdout.includes("pgrep -fa pi\\ \\|claude --uid"));
  assert.match(result.stdout, /\[exit=1\]/);
});

test("systemd proof preserves raw pgrep output and rejects tool errors", () => {
  const raw = "123 pi --profile other\n456 claude\n";
  const result = observe("show_tuis", raw, 0);
  assert.equal(result.status, 0, result.stderr);
  assert.ok(result.stdout.includes(raw));
  assert.match(result.stdout, /\[exit=0\]/);
  assert.equal(observe("show_tuis", "", 2).status, 2);
});

test("systemd proof accepts no pilot clients and ignores unrelated sockets", () => {
  for (const stage of ["before-restart", "after-restart"]) {
    const result = observe(`assert_no_pilot_clients ${stage}`, "", 1,
      "u_str ESTAB 0 0 /tmp/other/gateway.sock 12 * 13\nu_str ESTAB 0 0 <pilot>.other 14 * 15\n");
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, new RegExp(`${stage}: pilot socket clients=0`));
  }
});

test("systemd proof rejects pilot clients on either endpoint before and after restart", () => {
  for (const stage of ["before-restart", "after-restart"]) {
    for (const row of ["u_str ESTAB 0 0 <pilot> 12 * 13\n", "u_str ESTAB 0 0 * 13 <pilot> 12\n"]) {
      const result = observe(`assert_no_pilot_clients ${stage}`, "", 1, row);
      assert.equal(result.status, 1, result.stderr);
      assert.match(result.stdout, /u_str ESTAB/);
      assert.match(result.stdout, new RegExp(`${stage}: pilot socket clients=present`));
    }
  }
});

test("systemd proof rejects ss errors and brackets the first restart with client checks", () => {
  assert.equal(observe("assert_no_pilot_clients before-restart", "", 1, "", 2).status, 2);
  assert.match(harness, /run "\$NODE" "\$CLI"[^\n]*job create[^\n]*\n[\s\S]*?show_tuis\nassert_no_pilot_clients before-restart\nrun systemctl --user restart pi-hermes-gateway@pilot\nrun sleep 1\nassert_no_pilot_clients after-restart/);
  assert.match(harness, /pi --offline --no-extensions --no-skills[^\n]* -p \/g9-pilot/);
  assert.match(harness, /Pi pilot profile created and driven: id=/);
  assert.match(harness, /Pi pilot session exited:[^\n]*beforeDue=/);
});
