import { mkdtempSync, copyFileSync } from "node:fs"; import { tmpdir } from "node:os"; import { join } from "node:path";
import { openGateway, TestClock } from "/tmp/s1r1-clone/packages/gateway/dist/index.js";
import { createFakeAdapter } from "/tmp/s1r1-clone/packages/gateway/dist/fake-adapter.js";
const ROUTE = { profileId: "p", adapterId: "fake", accountId: "a", chatId: "c" };
const H = 3600e3; let seq = 0;
function mk(policy = "skip", t0 = Date.UTC(2026, 0, 1, 10), dir = mkdtempSync(join(tmpdir(), "s1r1-"))) {
  const clock = new TestClock(t0); const adapter = createFakeAdapter();
  const { gateway } = openGateway({ dbPath: join(dir, "g.sqlite"), clock, routes: [ROUTE], catchUpPolicy: policy, adapter });
  return { gw: gateway, clock, adapter, dir };
}
function req(gw, method, body, id) { const r = { protocolVersion: 1, requestId: id ?? `r${++seq}`, method, body, expiresAt: gw.clock.nowMs() + 30000 };
  return gw.handleRequest(r, Buffer.byteLength(JSON.stringify(r))); }
const out = {};
// A. late dispatch expires: slot at 11:00, admitted on time with dispatch disabled; dispatch at 11:00+24h+1ms => expired
{ const { gw, clock, adapter } = mk(); gw.store.setMeta("dispatch_enabled", "0");
  const j = req(gw, "job.create", { kind: "static-text", text: "hi", route: ROUTE, schedule: { type: "once", atUtc: "2026-01-01T11:00:00.000Z" } });
  clock.set(Date.UTC(2026, 0, 1, 11, 0, 30)); gw.tick();
  const d = gw.store.listDeliveries()[0];
  clock.set(Date.UTC(2026, 0, 2, 11, 0, 0, 1)); gw.store.setMeta("dispatch_enabled", "1"); gw.processOutbox();
  out.A_lateDispatch = { job: j.ok, notAfter: d && new Date(d.not_after_ms).toISOString(), status: gw.store.getDelivery(d.delivery_id).status, sent: adapter.sent.length }; }
// B. skip vs one-latest over two missed daily slots; C. one-latest where latest already expired
for (const policy of ["skip", "one-latest"]) {
  const { gw, clock, adapter } = mk(policy);
  req(gw, "job.create", { kind: "static-text", text: "d", route: ROUTE, schedule: { type: "daily", localTime: "12:00", timeZone: "UTC" } });
  clock.set(Date.UTC(2026, 0, 3, 13)); gw.tick();
  out["B_" + policy] = { sent: adapter.sent.length, occ: gw.store.listOccurrences().map((o) => o.status) };
}
{ const { gw, clock, adapter } = mk("one-latest");
  req(gw, "job.create", { kind: "static-text", text: "d", route: ROUTE, schedule: { type: "daily", localTime: "12:00", timeZone: "UTC" } });
  // suspend 3 days, resume 01:00 on day 4 => latest missed slot (day3 12:00) is 13h old (<24h) -> 1 send; now resume after >24h since latest
  clock.set(Date.UTC(2026, 0, 4, 12, 30)); gw.tick(); // day4 12:00 is 30min late -> missed (grace 60s) and is latest; within notAfter => send 1
  out.C_oneLatest_30minLate = { sent: adapter.sent.length, occ: gw.store.listOccurrences().map((o) => o.status) };
}
// D. restore quarantine + one-latest: backup before slot, slot sent post-backup, restore backup, quarantine, tick
for (const policy of ["one-latest", "skip"]) {
  const { gw, clock, adapter, dir } = mk(policy);
  req(gw, "job.create", { kind: "static-text", text: "daily", route: ROUTE, schedule: { type: "daily", localTime: "12:00", timeZone: "UTC" } });
  gw.store.db.exec("PRAGMA wal_checkpoint(TRUNCATE);"); const backupTime = clock.nowMs(); copyFileSync(join(dir, "g.sqlite"), join(dir, "bak.sqlite"));
  clock.set(Date.UTC(2026, 0, 1, 12, 0, 10)); gw.tick(); const sentBefore = adapter.sent.length; gw.close();
  copyFileSync(join(dir, "bak.sqlite"), join(dir, "g.sqlite"));
  const recovery = policy === "skip" ? Date.UTC(2026, 0, 1, 12, 0, 40) : Date.UTC(2026, 0, 1, 14);
  const r = mk(policy, recovery, dir); r.gw.restoreQuarantine(backupTime, recovery); r.gw.tick();
  out["D_restore_" + policy] = { sentPostBackupBeforeRestore: sentBefore, recoveryAt: new Date(recovery).toISOString(),
    afterQuarantineTick: { occ: r.gw.store.listOccurrences().map((o) => [new Date(o.scheduled_instant_ms).toISOString(), o.status]), deliveries: r.gw.store.listDeliveries().map((d) => d.status), dispatchEnabled: r.gw.store.dispatchEnabled() } };
  r.gw.close();
}
// E. unauthorized-route indistinguishability across variants and methods, incl. fuse exhaustion / oversize
{ const { gw, clock } = mk(); const variants = [ { ...ROUTE, chatId: "zz" }, { ...ROUTE, accountId: "b" }, { ...ROUTE, profileId: "q" }, { ...ROUTE, adapterId: "telegram" }, { ...ROUTE, threadId: "t1" } ];
  const strip = (r) => JSON.stringify({ ...r, requestId: undefined });
  const res = new Set();
  for (const v of variants) {
    res.add(strip(req(gw, "delivery.enqueue", { route: v, text: "x", notAfter: clock.nowMs() + 60000 })));
    res.add(strip(req(gw, "delivery.enqueue", { route: v, text: "x".repeat(5000), notAfter: clock.nowMs() + 60000 })));
    res.add(strip(req(gw, "job.create", { kind: "static-text", text: "x", route: v, schedule: { type: "once", atUtc: "2026-01-01T11:00:00.000Z" } })));
  }
  for (let i = 0; i < 10; i++) req(gw, "delivery.enqueue", { route: ROUTE, text: "x", notAfter: clock.nowMs() + 60000 });
  for (const v of variants) res.add(strip(req(gw, "delivery.enqueue", { route: v, text: "x", notAfter: clock.nowMs() + 60000 })));
  out.E_unauthDistinctResponses = [...res];
  const methods = ["route.create", "route.add", "routes.set", "config.update", "route.update"].map((m) => req(gw, m, { route: ROUTE }).error?.code);
  out.E_routeMethods = methods;
  out.E_auditKinds = [...new Set(gw.store.listAudit().map((a) => a.kind))];
}
// F. expired operator enqueue still consumes fuse tokens?
{ const { gw, clock } = mk(); const before = gw.store.getAccountFuse("a");
  const r = req(gw, "delivery.enqueue", { route: ROUTE, text: "x", notAfter: clock.nowMs() + 1 }); clock.add(0);
  out.F_fuseBefore = before; out.F_fuseAfterEnqueue = gw.store.getAccountFuse("a"); out.F_status = r.body; }
console.log(JSON.stringify(out, null, 1));
