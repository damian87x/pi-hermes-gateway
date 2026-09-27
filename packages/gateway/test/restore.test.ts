import assert from "node:assert/strict";
import { copyFileSync, existsSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { DatabaseSync } from "node:sqlite";
import { mkdirSync, chmodSync } from "node:fs";
import { ADAPTER_API_VERSION, LIMITS, validateAdapterManifest } from "pi-hermes-gateway-protocol";
import { createFakeAdapter, openGateway, replaceDbWithBackup, SCHEMA_VERSION, startDaemon, TestClock } from "../dist/index.js";
import { cleanup, handle, openTestGw, ROUTE, tmpDir } from "./helpers.ts";

test("restore quarantine: queued becomes commit-unknown and is not sent", () => {
  const { gw, clock, dir, adapter } = openTestGw();
  gw.store.setMeta("dispatch_enabled", "0");
  const enq = handle(gw, "delivery.enqueue", { route: ROUTE, text: "hold", notAfter: clock.nowMs() + 60_000 }, clock.nowMs());
  assert.equal(enq.ok, true);
  assert.equal(adapter.sent.length, 0);
  const backupTime = clock.nowMs();
  const backup = join(dir, "backup.sqlite");
  gw.store.db.exec("PRAGMA wal_checkpoint(TRUNCATE);");
  copyFileSync(join(dir, "gateway.sqlite"), backup);
  gw.store.setMeta("dispatch_enabled", "1");
  gw.processOutbox();
  assert.equal(adapter.sent.length, 1);
  gw.close();

  copyFileSync(backup, join(dir, "gateway.sqlite"));
  const clock2 = new TestClock(clock.nowMs() + 5_000);
  const { gateway: gw2 } = openGateway({
    dbPath: join(dir, "gateway.sqlite"),
    clock: clock2,
    routes: [ROUTE],
  });
  const auditBefore = gw2.store.listAudit().length;
  gw2.restoreQuarantine(backupTime, clock2.nowMs());
  const row = gw2.store.listDeliveries()[0];
  assert.equal(row?.status, "commit-unknown");
  gw2.tick();
  assert.equal(gw2.store.getDelivery(row!.delivery_id)?.status, "commit-unknown");
  assert.ok(gw2.store.listAudit().length >= auditBefore);
  assert.equal(gw2.store.getMeta("quarantine"), "1");
  assert.equal(gw2.store.dispatchEnabled(), false);
  gw2.close();
  cleanup(dir);
});

test("already-sent delivery is not resurrected as queued", () => {
  const { gw, clock, dir, adapter } = openTestGw();
  handle(gw, "delivery.enqueue", { route: ROUTE, text: "sent", notAfter: clock.nowMs() + 60_000 }, clock.nowMs());
  assert.equal(adapter.sent.length, 1);
  const id = gw.store.listDeliveries()[0]!.delivery_id;
  assert.equal(gw.store.getDelivery(id)?.status, "accepted");
  gw.restoreQuarantine(clock.nowMs() - 1, clock.nowMs());
  assert.equal(gw.store.getDelivery(id)?.status, "accepted");
  gw.store.setMeta("dispatch_enabled", "1");
  gw.processOutbox();
  assert.equal(adapter.sent.length, 1);
  gw.close();
  cleanup(dir);
});

test("refuse schema newer than binary", () => {
  const { gw, dir } = openTestGw();
  gw.close();
  const db = new DatabaseSync(join(dir, "gateway.sqlite"));
  db.exec("PRAGMA user_version = 99");
  db.close();
  const clock = new TestClock(Date.UTC(2026, 0, 1));
  assert.throws(() => {
    openGateway({ dbPath: join(dir, "gateway.sqlite"), clock, routes: [ROUTE] });
  }, /newer than binary/);
  cleanup(dir);
});

function postBackupSentSlot(policy: "skip" | "one-latest") {
  const clock = new TestClock(Date.UTC(2026, 0, 1, 11, 0, 0));
  const { gw, dir, adapter } = openTestGw({ clock, catchUpPolicy: policy });
  handle(
    gw,
    "job.create",
    {
      kind: "static-text",
      text: "slot",
      route: ROUTE,
      schedule: { type: "daily", localTime: "12:00", timeZone: "UTC" },
    },
    clock.nowMs(),
  );
  const backupTime = clock.nowMs();
  gw.store.db.exec("PRAGMA wal_checkpoint(TRUNCATE);");
  const backup = join(dir, "backup.sqlite");
  copyFileSync(join(dir, "gateway.sqlite"), backup);
  clock.set(Date.UTC(2026, 0, 1, 12, 0, 0));
  gw.tick();
  assert.equal(adapter.sent.length, 1);
  gw.close();
  copyFileSync(backup, join(dir, "gateway.sqlite"));
  const clock2 = new TestClock(Date.UTC(2026, 0, 1, 12, 0, 30));
  const { gateway: gw2 } = openGateway({
    dbPath: join(dir, "gateway.sqlite"),
    clock: clock2,
    routes: [ROUTE],
    catchUpPolicy: policy,
  });
  gw2.restoreQuarantine(backupTime, clock2.nowMs());
  gw2.tick();
  const occ = gw2.store.listOccurrences();
  assert.equal(occ.length, 1);
  assert.equal(occ[0]?.status, "skipped");
  assert.equal(occ[0]?.scheduled_instant_ms, Date.UTC(2026, 0, 1, 12, 0, 0));
  assert.equal(gw2.store.listDeliveries().every((d) => d.status !== "queued"), true);
  assert.equal(gw2.store.listJobs()[0]?.watermark_ms, clock2.nowMs());
  assert.equal(gw2.store.getMeta("quarantine"), "1");
  assert.equal(gw2.store.dispatchEnabled(), false);
  gw2.close();
  cleanup(dir);
}

test("post-backup sent slot is not resurrected as queued under skip", () => {
  postBackupSentSlot("skip");
});

test("post-backup sent slot is not resurrected as queued under one-latest", () => {
  postBackupSentSlot("one-latest");
});

test("once job backup in tick lag is not resent after restore+resume under one-latest", () => {
  const atUtc = "2026-06-01T12:00:00.000Z";
  const T = Date.parse(atUtc);
  const clock = new TestClock(T - 3_600_000);
  const { gw, dir, adapter } = openTestGw({ clock, catchUpPolicy: "one-latest" });
  handle(
    gw,
    "job.create",
    {
      kind: "static-text",
      text: "once-lag",
      route: ROUTE,
      schedule: { type: "once", atUtc },
    },
    clock.nowMs(),
  );
  clock.set(T + 30_000);
  gw.store.db.exec("PRAGMA wal_checkpoint(TRUNCATE);");
  const backup = join(dir, "backup.sqlite");
  copyFileSync(join(dir, "gateway.sqlite"), backup);
  const backupTime = clock.nowMs();
  clock.set(T + 60_000);
  gw.tick();
  assert.equal(adapter.sent.length, 1);
  gw.close();

  copyFileSync(backup, join(dir, "gateway.sqlite"));
  const clock2 = new TestClock(T + 600_000);
  const adapter2 = createFakeAdapter();
  const { gateway: gw2 } = openGateway({
    dbPath: join(dir, "gateway.sqlite"),
    clock: clock2,
    routes: [ROUTE],
    catchUpPolicy: "one-latest",
    adapter: adapter2,
  });
  gw2.restoreQuarantine(backupTime, clock2.nowMs());
  gw2.resumeDispatch();
  gw2.tick();
  assert.equal(adapter2.sent.length, 0);
  assert.equal(gw2.store.listDeliveries().length, 0);
  const occ = gw2.store.listOccurrences();
  assert.equal(occ.length, 1);
  assert.equal(occ[0]?.status, "skipped");
  assert.equal(occ[0]?.scheduled_instant_ms, T);
  gw2.close();
  cleanup(dir);
});

test("tick refuses admission while quarantined until explicit resume", () => {
  const clock = new TestClock(Date.UTC(2026, 0, 1, 10, 0, 0));
  const { gw, dir, adapter } = openTestGw({ clock });
  handle(
    gw,
    "job.create",
    {
      kind: "static-text",
      text: "later",
      route: ROUTE,
      schedule: { type: "once", atUtc: "2026-01-01T12:00:00.000Z" },
    },
    clock.nowMs(),
  );
  gw.restoreQuarantine(clock.nowMs(), clock.nowMs());
  clock.set(Date.UTC(2026, 0, 1, 12, 0, 0));
  gw.tick();
  assert.equal(adapter.sent.length, 0);
  assert.equal(gw.store.listOccurrences().length, 0);
  gw.resumeDispatch();
  assert.equal(gw.store.getMeta("quarantine"), "0");
  assert.equal(gw.store.dispatchEnabled(), true);
  gw.tick();
  assert.equal(adapter.sent.length, 1);
  gw.close();
  cleanup(dir);
});

test("explicit restore copies backup and quarantines before tick", () => {
  const dir = tmpDir();
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  chmodSync(dir, 0o700);
  writeFileSync(join(dir, "config.json"), JSON.stringify({ routes: [ROUTE] }), { mode: 0o600 });
  const clock = new TestClock(Date.UTC(2026, 0, 1, 11, 0, 0));
  const d1 = startDaemon({ profileDir: dir, routes: [ROUTE], clock, bindSocket: false, tickIntervalMs: 60_000 });
  handle(
    d1.gateway,
    "job.create",
    {
      kind: "static-text",
      text: "slot",
      route: ROUTE,
      schedule: { type: "daily", localTime: "12:00", timeZone: "UTC" },
    },
    clock.nowMs(),
  );
  const backupTime = clock.nowMs();
  d1.gateway.store.db.exec("PRAGMA wal_checkpoint(TRUNCATE);");
  const backup = join(dir, "backup.sqlite");
  copyFileSync(join(dir, "gateway.sqlite"), backup);
  clock.set(Date.UTC(2026, 0, 1, 12, 0, 0));
  d1.gateway.tick();
  assert.equal(d1.adapter.sent.length, 1);
  d1.stop();
  const clock2 = new TestClock(Date.UTC(2026, 0, 1, 12, 0, 30));
  const d2 = startDaemon({
    profileDir: dir,
    routes: [ROUTE],
    clock: clock2,
    bindSocket: false,
    tickIntervalMs: 60_000,
    restoreFromBackup: backup,
    backupTimeMs: backupTime,
  });
  try {
    assert.equal(d2.gateway.store.getMeta("quarantine"), "1");
    assert.equal(d2.gateway.store.dispatchEnabled(), false);
    assert.equal(d2.adapter.sent.length, 0);
    assert.equal(d2.gateway.store.listDeliveries().every((row) => row.status !== "queued"), true);
    const occ = d2.gateway.store.listOccurrences();
    assert.equal(occ.length, 1);
    assert.equal(occ[0]?.status, "skipped");
    assert.equal(existsSync(join(dir, "gateway.sqlite.pre-restore")), true);
  } finally {
    d2.stop();
    cleanup(dir);
  }
});

function telegramStub(sent: string[]) {
  const manifestResult = validateAdapterManifest({
    adapterId: "telegram",
    adapterApiVersion: ADAPTER_API_VERSION,
    capabilities: ["send.text"],
    configSchemaVersion: 1,
    maxTextLength: LIMITS.maxTextChars,
    receiptLevels: ["accepted"],
  });
  if (!manifestResult.ok) throw new Error(manifestResult.error.message);
  return {
    manifest: manifestResult.value,
    send(envelope: { deliveryId: string }) {
      sent.push(envelope.deliveryId);
      return { receiptLevel: "accepted" as const, providerMessageId: `telegram:${envelope.deliveryId}` };
    },
  };
}

test("restore of a real-adapter profile materializes with the fake adapter and still quarantines", () => {
  const dir = tmpDir();
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  chmodSync(dir, 0o700);
  const telegramRoute = { ...ROUTE, adapterId: "telegram" };
  const clock = new TestClock(Date.UTC(2026, 0, 1, 11, 0, 0));
  const sent1: string[] = [];
  const d1 = startDaemon({
    profileDir: dir,
    routes: [telegramRoute],
    adapter: telegramStub(sent1),
    clock,
    bindSocket: false,
    tickIntervalMs: 60_000,
  });
  handle(
    d1.gateway,
    "job.create",
    {
      kind: "static-text",
      text: "slot",
      route: telegramRoute,
      schedule: { type: "daily", localTime: "12:00", timeZone: "UTC" },
    },
    clock.nowMs(),
  );
  const backupTime = clock.nowMs();
  d1.gateway.store.db.exec("PRAGMA wal_checkpoint(TRUNCATE);");
  const backup = join(dir, "backup.sqlite");
  copyFileSync(join(dir, "gateway.sqlite"), backup);
  clock.set(Date.UTC(2026, 0, 1, 12, 0, 0));
  d1.gateway.tick();
  assert.equal(sent1.length, 1);
  d1.stop();
  const sent2: string[] = [];
  const d2 = startDaemon({
    profileDir: dir,
    routes: [telegramRoute],
    adapter: telegramStub(sent2),
    clock: new TestClock(Date.UTC(2026, 0, 1, 12, 0, 30)),
    bindSocket: false,
    tickIntervalMs: 60_000,
    restoreFromBackup: backup,
    backupTimeMs: backupTime,
  });
  try {
    assert.equal(d2.gateway.store.getMeta("quarantine"), "1");
    assert.equal(d2.gateway.store.dispatchEnabled(), false);
    assert.equal(sent2.length, 0);
    const occ = d2.gateway.store.listOccurrences();
    assert.equal(occ.length, 1);
    assert.equal(occ[0]?.status, "skipped");
  } finally {
    d2.stop();
    cleanup(dir);
  }
});

function seedProfile(dir: string): number {
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  chmodSync(dir, 0o700);
  writeFileSync(join(dir, "config.json"), JSON.stringify({ routes: [ROUTE] }), { mode: 0o600 });
  const clock = new TestClock(Date.UTC(2026, 0, 1, 10, 0, 0));
  const d = startDaemon({ profileDir: dir, routes: [ROUTE], clock, bindSocket: false, tickIntervalMs: 60_000 });
  for (let i = 0; i < 3; i++) {
    handle(d.gateway, "delivery.enqueue", { route: ROUTE, text: `live-${i}`, notAfter: clock.nowMs() + 60_000 }, clock.nowMs());
  }
  const audit = d.gateway.store.listAudit().length;
  d.stop();
  return audit;
}

function liveAuditCount(dbPath: string): number {
  const db = new DatabaseSync(dbPath);
  const n = Number(db.prepare("SELECT count(*) AS n FROM audit").get()?.n);
  db.close();
  return n;
}

test("non-db backup restore leaves live DB intact", () => {
  const dir = tmpDir();
  const before = seedProfile(dir);
  const bad = join(dir, "bad-backup.sqlite");
  writeFileSync(bad, "this is not sqlite\n".repeat(20));
  assert.throws(() => {
    startDaemon({
      profileDir: dir,
      routes: [ROUTE],
      clock: new TestClock(Date.UTC(2026, 0, 1, 11, 0, 0)),
      bindSocket: false,
      restoreFromBackup: bad,
      backupTimeMs: 0,
    });
  }, /not a database/);
  assert.equal(liveAuditCount(join(dir, "gateway.sqlite")), before);
  cleanup(dir);
});

test("newer-schema backup restore leaves live DB intact", () => {
  const dir = tmpDir();
  const before = seedProfile(dir);
  const bad = join(dir, "bad-backup.sqlite");
  const db = new DatabaseSync(bad);
  db.exec("CREATE TABLE x(a); PRAGMA user_version = 99;");
  db.close();
  assert.throws(() => {
    startDaemon({
      profileDir: dir,
      routes: [ROUTE],
      clock: new TestClock(Date.UTC(2026, 0, 1, 11, 0, 0)),
      bindSocket: false,
      restoreFromBackup: bad,
      backupTimeMs: 0,
    });
  }, /newer than binary/);
  assert.equal(liveAuditCount(join(dir, "gateway.sqlite")), before);
  cleanup(dir);
});

function parkLiveAside(live: string, aside: string): void {
  renameSync(live, aside);
  for (const extra of ["-wal", "-shm"]) {
    if (existsSync(`${live}${extra}`)) renameSync(`${live}${extra}`, `${aside}${extra}`);
  }
}

test("interrupted restore with live moved aside recovers original DB", () => {
  const dir = tmpDir();
  const before = seedProfile(dir);
  const live = join(dir, "gateway.sqlite");
  const aside = `${live}.pre-restore`;
  parkLiveAside(live, aside);
  writeFileSync(`${live}.restore-journal`, aside);
  const d = startDaemon({
    profileDir: dir,
    routes: [ROUTE],
    clock: new TestClock(Date.UTC(2026, 0, 1, 11, 0, 0)),
    bindSocket: false,
    tickIntervalMs: 60_000,
  });
  try {
    assert.equal(d.gateway.store.listAudit().length, before);
    assert.notEqual(d.gateway.store.getMeta("quarantine"), "1");
  } finally {
    d.stop();
    cleanup(dir);
  }
});

test("interrupted second restore recovers the most recent live DB", () => {
  const dir = tmpDir();
  const firstAudit = seedProfile(dir);
  const live = join(dir, "gateway.sqlite");
  copyFileSync(live, `${live}.pre-restore`);
  const clock = new TestClock(Date.UTC(2026, 0, 1, 11, 0, 0));
  const d1 = startDaemon({
    profileDir: dir,
    routes: [ROUTE],
    clock,
    bindSocket: false,
    tickIntervalMs: 60_000,
  });
  handle(d1.gateway, "delivery.enqueue", { route: ROUTE, text: "second-live", notAfter: clock.nowMs() + 60_000 }, clock.nowMs());
  const secondAudit = d1.gateway.store.listAudit().length;
  assert.ok(secondAudit > firstAudit);
  d1.stop();
  const aside2 = `${live}.pre-restore-999`;
  parkLiveAside(live, aside2);
  writeFileSync(`${live}.restore-journal`, aside2);
  const d2 = startDaemon({
    profileDir: dir,
    routes: [ROUTE],
    clock: new TestClock(Date.UTC(2026, 0, 1, 11, 30, 0)),
    bindSocket: false,
    tickIntervalMs: 60_000,
  });
  try {
    assert.equal(d2.gateway.store.listAudit().length, secondAudit);
    assert.equal(d2.gateway.store.listDeliveries().some((row) => row.text === "second-live"), true);
    assert.notEqual(d2.gateway.store.getMeta("quarantine"), "1");
    assert.equal(existsSync(`${live}.pre-restore`), true);
  } finally {
    d2.stop();
    cleanup(dir);
  }
});

test("absent live DB with leftover .pre-restore and no journal does not revive it", () => {
  const dir = tmpDir();
  const before = seedProfile(dir);
  const live = join(dir, "gateway.sqlite");
  copyFileSync(live, `${live}.pre-restore`);
  unlinkSync(live);
  for (const extra of [`${live}-wal`, `${live}-shm`]) {
    if (existsSync(extra)) unlinkSync(extra);
  }
  const d = startDaemon({
    profileDir: dir,
    routes: [ROUTE],
    clock: new TestClock(Date.UTC(2026, 0, 1, 11, 0, 0)),
    bindSocket: false,
    tickIntervalMs: 60_000,
  });
  try {
    assert.notEqual(d.gateway.store.listAudit().length, before);
    assert.equal(d.gateway.store.listDeliveries().length, 0);
    assert.equal(existsSync(`${live}.pre-restore`), true);
    assert.equal(liveAuditCount(`${live}.pre-restore`), before);
  } finally {
    d.stop();
    cleanup(dir);
  }
});

function killAfterRestoreSwapThenResume(policy: "skip" | "one-latest") {
  const dir = tmpDir();
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  chmodSync(dir, 0o700);
  writeFileSync(join(dir, "config.json"), JSON.stringify({ routes: [ROUTE], catchUpPolicy: policy }), { mode: 0o600 });
  const clock = new TestClock(Date.UTC(2026, 0, 1, 11, 0, 0));
  const d1 = startDaemon({
    profileDir: dir,
    routes: [ROUTE],
    clock,
    catchUpPolicy: policy,
    bindSocket: false,
    tickIntervalMs: 60_000,
  });
  handle(
    d1.gateway,
    "job.create",
    {
      kind: "static-text",
      text: "slot",
      route: ROUTE,
      schedule: { type: "daily", localTime: "12:00", timeZone: "UTC" },
    },
    clock.nowMs(),
  );
  const backupTime = clock.nowMs();
  d1.gateway.store.db.exec("PRAGMA wal_checkpoint(TRUNCATE);");
  const backup = join(dir, "backup.sqlite");
  copyFileSync(join(dir, "gateway.sqlite"), backup);
  clock.set(Date.UTC(2026, 0, 1, 12, 0, 0));
  d1.gateway.tick();
  assert.equal(d1.adapter.sent.length, 1);
  d1.stop();

  const clock2 = new TestClock(Date.UTC(2026, 0, 1, 12, 0, 30));
  replaceDbWithBackup(join(dir, "gateway.sqlite"), backup, {
    clock: clock2,
    routes: [ROUTE],
    catchUpPolicy: policy,
    backupTimeMs: backupTime,
    tickGraceMs: 65_000,
  });
  const plain = startDaemon({
    profileDir: dir,
    routes: [ROUTE],
    clock: clock2,
    catchUpPolicy: policy,
    bindSocket: false,
    tickIntervalMs: 60_000,
  });
  try {
    assert.equal(plain.adapter.sent.length, 0);
  } finally {
    plain.stop();
  }
  const resumed = startDaemon({
    profileDir: dir,
    routes: [ROUTE],
    clock: clock2,
    catchUpPolicy: policy,
    bindSocket: false,
    tickIntervalMs: 60_000,
    resumeDispatch: true,
  });
  try {
    assert.equal(resumed.adapter.sent.length, 0);
    const occ = resumed.gateway.store.listOccurrences();
    assert.equal(occ.length, 1);
    assert.equal(occ[0]?.status, "skipped");
    assert.equal(occ[0]?.scheduled_instant_ms, Date.UTC(2026, 0, 1, 12, 0, 0));
  } finally {
    resumed.stop();
    cleanup(dir);
  }
}

test("kill after restore swap then resume sends 0 extra under one-latest", () => {
  killAfterRestoreSwapThenResume("one-latest");
});

test("kill after restore swap then resume sends 0 extra under skip within grace", () => {
  killAfterRestoreSwapThenResume("skip");
});

test("backup is taken before migrate from v0", () => {
  const { dir } = openTestGw();
  const bak = [...new Set(
    // migrate of a newly created file copies it; evidence that backup path is used
    [join(dir, `gateway.sqlite.pre-migrate-v0-to-v${SCHEMA_VERSION}.bak`)],
  )];
  assert.equal(existsSync(bak[0]!), true);
  cleanup(dir);
});
