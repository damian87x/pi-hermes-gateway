import { copyFileSync, mkdtempSync, rmSync, chmodSync, writeFileSync, utimesSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
const DIST = process.argv[2];
const { startDaemon, TestClock, openGateway } = await import(`${DIST}/index.js`);
const { PROTOCOL_VERSION } = await import("pi-hermes-gateway-protocol");
const ROUTE = { profileId: "profile-a", adapterId: "fake", accountId: "acct-1", chatId: "chat-1" };
let seq = 0;
function call(gw, method, body) {
  const now = gw.clock.nowMs();
  const req = { protocolVersion: PROTOCOL_VERSION, requestId: `p2-${++seq}-${now}`, method, body, expiresAt: now + 30_000 };
  return gw.handleRequest(req, new TextEncoder().encode(JSON.stringify(req)).byteLength);
}
function prof() { const d = mkdtempSync(join(tmpdir(), "r3cs-p2-")); chmodSync(d, 0o700); return d; }
function start(dir, clock, policy, extra = {}) { return startDaemon({ profileDir: dir, routes: [ROUTE], clock, bindSocket: false, tickIntervalMs: 60_000, catchUpPolicy: policy, ...extra }); }
function backup(d, dir) { d.gateway.store.db.exec("PRAGMA wal_checkpoint(TRUNCATE);"); const b = join(dir, "backup.sqlite"); copyFileSync(join(dir, "gateway.sqlite"), b); return b; }
const results = [];
function rec(name, ok, detail) { results.push({ name, ok, ...detail }); }

// A/B: once job, backup in tick lag, restore via daemon, operator resume, both policies; explicit backupTime and mtime default
for (const policy of ["one-latest", "skip"]) for (const mode of ["explicit", "mtime"]) {
  const dir = prof();
  const W0 = Date.now();
  const T = mode === "mtime" ? W0 - 30_000 : Date.UTC(2026, 5, 1, 12);
  const c1 = new TestClock(T - 3_600_000);
  const d1 = start(dir, c1, policy);
  call(d1.gateway, "job.create", { kind: "static-text", text: "once", route: ROUTE, schedule: { type: "once", atUtc: new Date(T).toISOString() } });
  c1.set(T + 20_000); // due, tick has not run yet
  const b = backup(d1, dir);
  const backupTime = c1.nowMs();
  if (mode === "mtime") utimesSync(b, new Date(), new Date()); // mtime = real now (>= T)
  c1.set(T + 50_000); d1.gateway.tick();
  const sent1 = d1.adapter.sent.length; d1.stop();
  const c2 = new TestClock((mode === "mtime" ? Date.now() : T) + 600_000);
  const d2 = start(dir, c2, policy, { restoreFromBackup: b, ...(mode === "explicit" ? { backupTimeMs: backupTime } : {}) });
  const q = d2.gateway.store.getMeta("quarantine"); const sentQ = d2.adapter.sent.length; d2.stop();
  c2.add(60_000);
  const d3 = start(dir, c2, policy, { resumeDispatch: true });
  d3.gateway.tick(); c2.add(3_600_000); d3.gateway.tick();
  const occ = d3.gateway.store.listOccurrences(); const dl = d3.gateway.store.listDeliveries();
  const sentAfter = d3.adapter.sent.length; d3.stop();
  rec(`once-tick-lag ${policy} ${mode}`, sent1 === 1 && q === "1" && sentQ === 0 && sentAfter === 0 && dl.every(x => x.status !== "queued"), { sent1, quarantine: q, sentQ, sentAfterResume: sentAfter, occ: occ.map(o => o.status), deliveries: dl.map(x => x.status) });
  rmSync(dir, { recursive: true, force: true });
}

// C: daily job, backup in tick lag (slot S <= B not yet ticked), one-latest, restore, resume
for (const policy of ["one-latest", "skip"]) {
  const dir = prof();
  const S = Date.UTC(2026, 0, 1, 12);
  const c1 = new TestClock(S - 3_600_000);
  const d1 = start(dir, c1, policy);
  call(d1.gateway, "job.create", { kind: "static-text", text: "daily", route: ROUTE, schedule: { type: "daily", localTime: "12:00", timeZone: "UTC" } });
  c1.set(S + 20_000);
  const b = backup(d1, dir); const backupTime = c1.nowMs();
  c1.set(S + 50_000); d1.gateway.tick(); const sent1 = d1.adapter.sent.length; d1.stop();
  const c2 = new TestClock(S + 600_000);
  const d2 = start(dir, c2, policy, { restoreFromBackup: b, backupTimeMs: backupTime });
  const wm = d2.gateway.store.listJobs()[0].watermark_ms; d2.stop();
  c2.add(60_000);
  const d3 = start(dir, c2, policy, { resumeDispatch: true });
  d3.gateway.tick();
  const sentAfter = d3.adapter.sent.length;
  const occS = d3.gateway.store.listOccurrences().filter(o => o.scheduled_instant_ms === S);
  const skippedAuditForS = d3.gateway.store.listAudit().filter(a => a.kind === "occurrence.skipped" && JSON.parse(a.payload_json).scheduledInstantMs === S).length;
  // liveness: next day slot fires exactly once
  c2.set(S + 86_400_000 + 1_000); d3.gateway.tick(); d3.gateway.tick();
  const sentNext = d3.adapter.sent.length; d3.stop();
  rec(`daily-tick-lag ${policy}`, sent1 === 1 && sentAfter === 0 && wm === S + 600_000 && sentNext === 1, { sent1, watermarkIsRecovery: wm === S + 600_000, sentAfterResume: sentAfter, occRowsForS: occS.length, skippedAuditForS, nextDaySends: sentNext });
  rmSync(dir, { recursive: true, force: true });
}

// E: backup holds a queued delivery (dispatch disabled at backup) that was sent post-backup
{
  const dir = prof(); const c1 = new TestClock(Date.UTC(2026, 0, 1, 10));
  const d1 = start(dir, c1, "one-latest");
  d1.gateway.store.setMeta("dispatch_enabled", "0");
  call(d1.gateway, "delivery.enqueue", { route: ROUTE, text: "held", notAfter: c1.nowMs() + 3_600_000 });
  call(d1.gateway, "job.create", { kind: "static-text", text: "d", route: ROUTE, schedule: { type: "daily", localTime: "10:01", timeZone: "UTC" } });
  c1.add(60_000); d1.gateway.tick();
  const b = backup(d1, dir); const bt = c1.nowMs();
  d1.gateway.store.setMeta("dispatch_enabled", "1"); d1.gateway.processOutbox(); const sent1 = d1.adapter.sent.length; d1.stop();
  const c2 = new TestClock(bt + 120_000);
  const d2 = start(dir, c2, "one-latest", { restoreFromBackup: b, backupTimeMs: bt }); const st = d2.gateway.store.listDeliveries().map(x => x.status); d2.stop();
  const d3 = start(dir, c2, "one-latest", { resumeDispatch: true }); d3.gateway.tick(); const sentAfter = d3.adapter.sent.length; d3.stop();
  rec("queued-in-backup", sent1 === 2 && sentAfter === 0 && st.every(s => s === "commit-unknown"), { sent1, statusesAfterRestore: st, sentAfterResume: sentAfter });
  rmSync(dir, { recursive: true, force: true });
}

// J: restart during quarantine without flags stays quarantined; IPC job.resume does not lift it; unknown method dispatch.resume refused
{
  const dir = prof(); const c1 = new TestClock(Date.UTC(2026, 0, 1, 10));
  const d1 = start(dir, c1, "one-latest");
  call(d1.gateway, "job.create", { kind: "static-text", text: "x", route: ROUTE, schedule: { type: "daily", localTime: "11:00", timeZone: "UTC" } });
  const b = backup(d1, dir); d1.stop();
  const d2 = start(dir, c1, "one-latest", { restoreFromBackup: b, backupTimeMs: c1.nowMs() }); d2.stop();
  c1.set(Date.UTC(2026, 0, 1, 11, 0, 10));
  const d3 = start(dir, c1, "one-latest");
  const jobId = d3.gateway.store.listJobs()[0].job_id;
  const r1 = call(d3.gateway, "job.resume", { jobId });
  const r2 = call(d3.gateway, "dispatch.resume", {});
  const enq = call(d3.gateway, "delivery.enqueue", { route: ROUTE, text: "during-quarantine", notAfter: c1.nowMs() + 3_600_000 });
  d3.gateway.tick();
  const sentQ = d3.adapter.sent.length; const q = d3.gateway.store.getMeta("quarantine");
  const enqStatus = enq.ok ? enq.body.status : enq.error.code; d3.stop();
  let combo = null; try { start(dir, c1, "one-latest", { restoreFromBackup: b, resumeDispatch: true }).stop(); combo = "accepted"; } catch (e) { combo = e.message; }
  const d4 = start(dir, c1, "one-latest", { resumeDispatch: true }); const sentResume = d4.adapter.sent.map(s => s.text); d4.stop();
  rec("quarantine-operator-only", sentQ === 0 && q === "1" && combo !== "accepted", { restartQuarantine: q, jobResumeOk: r1.ok, dispatchResumeMethod: r2.ok ? "accepted" : r2.error.code, enqueueDuringQuarantine: enqStatus, sentWhileQuarantined: sentQ, restorePlusResume: combo, sentOnOperatorResume: sentResume });
  rmSync(dir, { recursive: true, force: true });
}

// H: interrupted restore window — backup copied over live DB, process dies before restoreQuarantine; next plain start
{
  const dir = prof(); const c1 = new TestClock(Date.UTC(2026, 0, 1, 11, 59, 30));
  const d1 = start(dir, c1, "one-latest");
  call(d1.gateway, "job.create", { kind: "static-text", text: "noon", route: ROUTE, schedule: { type: "daily", localTime: "12:00", timeZone: "UTC" } });
  const b = backup(d1, dir);
  c1.set(Date.UTC(2026, 0, 1, 12, 0, 5)); d1.gateway.tick(); const sent1 = d1.adapter.sent.length; d1.stop();
  // emulate daemon.ts:129 replaceDbWithBackup completing, then SIGKILL before daemon.ts:144
  copyFileSync(b, join(dir, "gateway.sqlite"));
  const c2 = new TestClock(Date.UTC(2026, 0, 1, 12, 10));
  const d2 = start(dir, c2, "one-latest"); const resent = d2.adapter.sent.map(s => s.text); d2.stop();
  rec("interrupted-restore-window (consequence demo)", resent.length === 0, { sentBeforeDisaster: sent1, resentAfterPlainStart: resent });
  rmSync(dir, { recursive: true, force: true });
}
console.log(JSON.stringify(results, null, 1));
