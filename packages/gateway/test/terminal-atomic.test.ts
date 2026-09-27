import assert from "node:assert/strict";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";
import { TestClock, type Gateway } from "../dist/index.js";
import { cleanup, handle, openTestGw, ROUTE } from "./helpers.ts";

const AT = "2026-01-01T12:00:00.000Z";
const BOUND_MS = 60_000;

function auditCount(gw: Gateway, kind: string): number {
  return gw.store.listAudit().filter((r) => r.kind === kind).length;
}

// Admits one job occurrence with dispatch disabled, so its delivery is left queued for a later open.
function queueJobDelivery(): { dir: string } {
  const { gw, clock, dir, adapter } = openTestGw({ notAfterBoundMs: BOUND_MS });
  const created = handle(gw, "job.create", { kind: "static-text", text: "terminal", route: ROUTE, schedule: { type: "once", atUtc: AT } }, clock.nowMs());
  assert.equal(created.ok, true);
  gw.store.setMeta("dispatch_enabled", "0");
  clock.set(Date.parse(AT));
  gw.tick();
  assert.equal(adapter.sent.length, 0);
  assert.equal(gw.store.listDeliveries()[0]?.status, "queued");
  assert.equal(gw.store.listOccurrences()[0]?.status, "pending");
  gw.store.setMeta("dispatch_enabled", "1");
  gw.close();
  return { dir };
}

const paths = [
  {
    name: "dispatch-time expiry",
    clockMs: Date.parse(AT) + BOUND_MS + 1,
    routes: [ROUTE],
    delivery: "expired",
    occurrence: "expired",
    audit: "delivery.expired",
  },
  {
    name: "revoked-route refusal",
    clockMs: Date.parse(AT),
    routes: [],
    delivery: "failed",
    occurrence: "skipped",
    audit: "delivery.send.rejected",
  },
];

for (const path of paths) {
  const faults = [
    { name: "delivery", trigger: `BEFORE UPDATE ON deliveries WHEN NEW.status = '${path.delivery}'` },
    { name: "occurrence", trigger: `BEFORE UPDATE ON occurrences WHEN NEW.status = '${path.occurrence}'` },
    { name: "audit", trigger: `BEFORE INSERT ON audit WHEN NEW.kind = '${path.audit}'` },
  ];
  for (const fault of faults) {
    test(`${path.name} whose ${fault.name} write fails rolls back delivery, occurrence and audit and halts; restart settles once`, () => {
      const { dir } = queueJobDelivery();
      const dbPath = join(dir, "gateway.sqlite");
      const side = new DatabaseSync(dbPath);
      side.exec(`CREATE TRIGGER block_terminal ${fault.trigger} BEGIN SELECT RAISE(ABORT, 'injected terminal write failure'); END`);

      const clock = new TestClock(path.clockMs);
      const { gw, adapter } = openTestGw({ clock, dir, routes: path.routes, notAfterBoundMs: BOUND_MS });
      gw.tick();
      assert.equal(adapter.sent.length, 0);
      assert.ok(gw.outboxHalt, "the failed terminal write halts the outbox");
      const delivery = gw.store.listDeliveries()[0];
      assert.equal(delivery?.status, "queued", "the delivery is not terminal without its occurrence and audit");
      assert.equal(delivery.dispatch_intent, 0);
      assert.equal(gw.store.getOccurrence(delivery.occurrence_id!)?.status, "pending", "the claim rolls back with the terminal write");
      assert.equal(auditCount(gw, path.audit), 0);
      assert.equal(auditCount(gw, "delivery.send.attempt"), 0);
      gw.close();
      side.exec("DROP TRIGGER block_terminal");
      side.close();

      // Restart re-evaluates the still-queued row and commits its terminal state exactly once.
      const { gw: gw2, adapter: adapter2 } = openTestGw({ clock, dir, routes: path.routes, notAfterBoundMs: BOUND_MS });
      gw2.tick();
      gw2.tick();
      assert.equal(gw2.outboxHalt, null);
      assert.equal(adapter2.sent.length, 0);
      assert.equal(gw2.store.listDeliveries()[0]?.status, path.delivery);
      assert.equal(gw2.store.listOccurrences()[0]?.status, path.occurrence);
      assert.equal(auditCount(gw2, path.audit), 1);
      gw2.close();

      // A committed terminal state never replays, even once the route is authorised and time is in bounds.
      const { gw: gw3, adapter: adapter3 } = openTestGw({ clock: new TestClock(Date.parse(AT)), dir, notAfterBoundMs: BOUND_MS });
      gw3.tick();
      assert.equal(adapter3.sent.length, 0);
      assert.equal(gw3.store.listDeliveries()[0]?.status, path.delivery);
      assert.equal(gw3.store.listOccurrences()[0]?.status, path.occurrence);
      assert.equal(auditCount(gw3, path.audit), 1);
      gw3.close();
      cleanup(dir);
    });
  }
}
