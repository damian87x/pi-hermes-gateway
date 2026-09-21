import assert from "node:assert/strict";
import { copyFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { DatabaseSync } from "node:sqlite";
import { openGateway, SCHEMA_VERSION, TestClock } from "../dist/index.js";
import { cleanup, handle, openTestGw, ROUTE } from "./helpers.ts";

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

test("backup is taken before migrate from v0", () => {
  const { dir } = openTestGw();
  const bak = [...new Set(
    // migrate of a newly created file copies it; evidence that backup path is used
    [join(dir, `gateway.sqlite.pre-migrate-v0-to-v${SCHEMA_VERSION}.bak`)],
  )];
  assert.equal(existsSync(bak[0]!), true);
  cleanup(dir);
});
