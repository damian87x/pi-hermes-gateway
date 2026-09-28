import { writeFileSync, mkdtempSync, rmSync, chmodSync, copyFileSync, existsSync, statSync, readdirSync } from "node:fs"; import { tmpdir } from "node:os"; import { join } from "node:path";
import { DatabaseSync } from "node:sqlite"; import { spawn } from "node:child_process";
const DIST = process.argv[2];
const { startDaemon, TestClock } = await import(`${DIST}/index.js`);
const { PROTOCOL_VERSION } = await import("pi-hermes-gateway-protocol");
const ROUTE = { profileId: "profile-a", adapterId: "fake", accountId: "acct-1", chatId: "chat-1" };
const out = {};
function live(dir) {
  const c = new TestClock(Date.UTC(2026, 0, 1, 10));
  const d = startDaemon({ profileDir: dir, routes: [ROUTE], clock: c, bindSocket: false });
  for (let i = 0; i < 3; i++) d.gateway.handleRequest({ protocolVersion: PROTOCOL_VERSION, requestId: `l${i}`, method: "delivery.enqueue", expiresAt: c.nowMs() + 30000, body: { route: ROUTE, text: `live-${i}`, notAfter: c.nowMs() + 60000 } }, 500);
  const audit = d.gateway.store.listAudit().length; d.stop(); return audit;
}
function count(dbPath) { try { const db = new DatabaseSync(dbPath); const n = db.prepare("SELECT count(*) AS n FROM audit").get().n; db.close(); return n; } catch (e) { return `unreadable: ${e.message}`; } }
for (const kind of ["not-a-db", "newer-schema", "missing"]) {
  const dir = mkdtempSync(join(tmpdir(), "r3cs-p6-")); chmodSync(dir, 0o700);
  const auditBefore = live(dir);
  const bad = join(dir, "bad-backup.sqlite");
  if (kind === "not-a-db") writeFileSync(bad, "this is not sqlite\n".repeat(100));
  if (kind === "newer-schema") { const db = new DatabaseSync(bad); db.exec("CREATE TABLE x(a); PRAGMA user_version = 99;"); db.close(); }
  let err = null;
  try { startDaemon({ profileDir: dir, routes: [ROUTE], clock: new TestClock(Date.UTC(2026, 0, 1, 11)), bindSocket: false, restoreFromBackup: bad, backupTimeMs: 0 }).stop(); } catch (e) { err = e.message; }
  out[kind] = { restoreError: err, liveAuditRowsBefore: auditBefore, liveAuditRowsAfter: count(join(dir, "gateway.sqlite")), profileFiles: readdirSync(dir).sort() };
  rmSync(dir, { recursive: true, force: true });
}
// real SIGKILL during CLI --restore at random offsets: classify on-disk outcome
const cli = join(DIST, "cli.js");
const trials = { quarantined: 0, unquarantinedRestored: 0, original: 0, unreadable: 0 };
const base = mkdtempSync(join(tmpdir(), "r3cs-p6k-"));
// build a large backup (~150MB) so the copy window is observable
const big = join(base, "big-backup.sqlite");
{
  const dir = join(base, "seed"); const { mkdirSync } = await import("node:fs"); mkdirSync(dir, { mode: 0o700 });
  const c = new TestClock(Date.UTC(2026, 0, 1, 10)); const d = startDaemon({ profileDir: dir, routes: [ROUTE], clock: c, bindSocket: false });
  d.gateway.store.setMeta("dispatch_enabled", "0");
  d.gateway.handleRequest({ protocolVersion: PROTOCOL_VERSION, requestId: "q", method: "delivery.enqueue", expiresAt: c.nowMs() + 30000, body: { route: ROUTE, text: "queued-at-backup", notAfter: c.nowMs() + 3_600_000 } }, 500);
  d.gateway.store.setMeta("dispatch_enabled", "1");
  d.gateway.store.db.exec("CREATE TABLE pad(b BLOB)"); const ins = d.gateway.store.db.prepare("INSERT INTO pad VALUES (randomblob(1048576))"); for (let i = 0; i < 150; i++) ins.run();
  d.gateway.store.db.exec("PRAGMA wal_checkpoint(TRUNCATE);"); copyFileSync(join(dir, "gateway.sqlite"), big); d.stop();
}
for (let t = 0; t < 16; t++) {
  const dir = join(base, `p${t}`); const { mkdirSync } = await import("node:fs"); mkdirSync(dir, { mode: 0o700 });
  writeFileSync(join(dir, "config.json"), JSON.stringify({ routes: [ROUTE] }), { mode: 0o600 });
  live(dir);
  const child = spawn(process.execPath, [cli, "--profile", dir, "--restore", big], { stdio: ["ignore", "pipe", "pipe"] });
  const delay = 5 + t * 12;
  await new Promise(r => setTimeout(r, delay)); child.kill("SIGKILL"); await new Promise(r => child.once("exit", r));
  let cls;
  try {
    const db = new DatabaseSync(join(dir, "gateway.sqlite"), { readOnly: true });
    const q = db.prepare("SELECT v FROM meta WHERE k='quarantine'").get()?.v; const hasPad = !!db.prepare("SELECT name FROM sqlite_master WHERE name='pad'").get();
    const ic = db.prepare("PRAGMA quick_check").get(); db.close();
    cls = !hasPad ? "original" : q === "1" ? "quarantined" : "unquarantinedRestored";
    if (Object.values(ic)[0] !== "ok") cls = "unreadable";
  } catch { cls = "unreadable"; }
  trials[cls]++;
}
out.randomKillDuringCliRestore = { trials, backupBytes: statSync(big).size };
rmSync(base, { recursive: true, force: true });
console.log(JSON.stringify(out, null, 1));
