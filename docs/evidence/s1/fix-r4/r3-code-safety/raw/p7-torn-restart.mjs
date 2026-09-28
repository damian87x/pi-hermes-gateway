import { writeFileSync, mkdtempSync, rmSync, mkdirSync, copyFileSync, statSync } from "node:fs"; import { tmpdir } from "node:os"; import { join } from "node:path";
import { DatabaseSync } from "node:sqlite"; import { spawn } from "node:child_process";
const DIST = process.argv[2];
const { startDaemon, TestClock, SystemClock } = await import(`${DIST}/index.js`);
const { PROTOCOL_VERSION } = await import("pi-hermes-gateway-protocol");
const ROUTE = { profileId: "profile-a", adapterId: "fake", accountId: "acct-1", chatId: "chat-1" };
const base = mkdtempSync(join(tmpdir(), "r3cs-p7-")); const big = join(base, "big.sqlite");
{ const dir = join(base, "seed"); mkdirSync(dir, { mode: 0o700 });
  const c = new SystemClock(); const d = startDaemon({ profileDir: dir, routes: [ROUTE], clock: c, bindSocket: false });
  d.gateway.store.setMeta("dispatch_enabled", "0");
  d.gateway.handleRequest({ protocolVersion: PROTOCOL_VERSION, requestId: "q", method: "delivery.enqueue", expiresAt: c.nowMs() + 30000, body: { route: ROUTE, text: "queued-at-backup(already sent post-backup)", notAfter: c.nowMs() + 3_600_000 } }, 500);
  d.gateway.store.setMeta("dispatch_enabled", "1");
  d.gateway.store.db.exec("CREATE TABLE pad(b BLOB)"); const ins = d.gateway.store.db.prepare("INSERT INTO pad VALUES (randomblob(1048576))"); for (let i = 0; i < 150; i++) ins.run();
  d.gateway.store.db.exec("PRAGMA wal_checkpoint(TRUNCATE);"); copyFileSync(join(dir, "gateway.sqlite"), big); d.stop(); }
const out = [];
for (let t = 0; t < 12; t++) {
  const dir = join(base, `p${t}`); mkdirSync(dir, { mode: 0o700 });
  writeFileSync(join(dir, "config.json"), JSON.stringify({ routes: [ROUTE] }), { mode: 0o600 });
  startDaemon({ profileDir: dir, routes: [ROUTE], clock: new SystemClock(), bindSocket: false }).stop();
  const child = spawn(process.execPath, [join(DIST, "cli.js"), "--profile", dir, "--restore", big], { stdio: ["ignore", "pipe", "pipe"] });
  await new Promise(r => setTimeout(r, 5 + t * 10)); child.kill("SIGKILL"); await new Promise(r => child.once("exit", r));
  const size = statSync(join(dir, "gateway.sqlite")).size;
  let r;
  try { const d = startDaemon({ profileDir: dir, routes: [ROUTE], bindSocket: false }); r = { plainStart: "started", quarantine: d.gateway.store.getMeta("quarantine"), sent: d.adapter.sent.map(s => s.text) }; d.stop(); }
  catch (e) { r = { plainStart: `refused: ${e.message}` }; }
  out.push({ killAfterMs: 5 + t * 10, dbBytesAfterKill: size, ...r });
}
rmSync(base, { recursive: true, force: true });
console.log(JSON.stringify(out, null, 1));
