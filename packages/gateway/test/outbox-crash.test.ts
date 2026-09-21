import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { join } from "node:path";
import { test } from "node:test";
import { openGateway, TestClock } from "../dist/index.js";
import { cleanup, handle, openTestGw, ROUTE, tmpDir } from "./helpers.ts";

function enqueueNow(gw: ReturnType<typeof openTestGw>["gw"], clockNow: number, text = "x") {
  return handle(gw, "delivery.enqueue", { route: ROUTE, text, notAfter: clockNow + 60_000 }, clockNow);
}

test("crash at claim: interrupted, not accepted, later tick does not send", () => {
  const { gw, clock, dir, adapter } = openTestGw();
  gw.crashNext = "claim";
  enqueueNow(gw, clock.nowMs());
  assert.equal(adapter.sent.length, 0);
  const occOrDlv = gw.store.listDeliveries()[0];
  assert.ok(occOrDlv);
  gw.crashNext = null;
  gw.processOutbox();
  assert.equal(adapter.sent.length, 0);
  gw.close();
  cleanup(dir);
});

test("crash at dispatch-intent: commit-unknown never auto-retried", () => {
  const { gw, clock, dir, adapter } = openTestGw();
  gw.crashNext = "dispatch-intent";
  enqueueNow(gw, clock.nowMs());
  const row = gw.store.listDeliveries()[0];
  assert.equal(row?.status, "commit-unknown");
  assert.equal(adapter.sent.length, 0);
  gw.processOutbox();
  assert.equal(adapter.sent.length, 0);
  assert.equal(gw.store.getDelivery(row!.delivery_id)?.status, "commit-unknown");
  gw.close();
  cleanup(dir);
});

test("crash mid-send: commit-unknown never auto-retried", () => {
  const { gw, clock, dir, adapter } = openTestGw();
  gw.crashNext = "mid-send";
  enqueueNow(gw, clock.nowMs());
  const row = gw.store.listDeliveries()[0];
  assert.equal(row?.status, "commit-unknown");
  assert.equal(adapter.sent.length, 0);
  gw.processOutbox();
  assert.equal(adapter.sent.length, 0);
  gw.close();
  cleanup(dir);
});

test("crash before receipt write: commit-unknown even if adapter observed send", () => {
  const { gw, clock, dir, adapter } = openTestGw();
  gw.crashNext = "before-receipt";
  enqueueNow(gw, clock.nowMs());
  const row = gw.store.listDeliveries()[0];
  assert.equal(row?.status, "commit-unknown");
  assert.equal(adapter.sent.length, 1);
  gw.processOutbox();
  assert.equal(adapter.sent.length, 1);
  gw.close();
  cleanup(dir);
});

test("oversized adapter payload is rejected without send", () => {
  const { gw, clock, dir, adapter } = openTestGw();
  const text = "y".repeat(adapter.manifest.maxTextLength + 1);
  const res = handle(gw, "delivery.enqueue", { route: ROUTE, text, notAfter: clock.nowMs() + 60_000 }, clock.nowMs());
  assert.equal(res.ok, false);
  if (!res.ok) assert.equal(res.error.code, "text_too_long");
  assert.equal(adapter.sent.length, 0);
  gw.close();
  cleanup(dir);
});

test("open converts leftover dispatching rows to commit-unknown with audit", () => {
  const { gw, clock, dir } = openTestGw();
  enqueueNow(gw, clock.nowMs());
  const row = gw.store.listDeliveries()[0]!;
  gw.store.setDispatchIntent(row.delivery_id);
  assert.equal(gw.store.getDelivery(row.delivery_id)?.status, "dispatching");
  gw.close();
  const clock2 = new TestClock(clock.nowMs());
  const { gateway: gw2 } = openGateway({
    dbPath: join(dir, "gateway.sqlite"),
    clock: clock2,
    routes: [ROUTE],
  });
  assert.equal(gw2.store.getDelivery(row.delivery_id)?.status, "commit-unknown");
  assert.ok(gw2.store.listAudit().some((a) => a.kind === "crash.recover"));
  gw2.processOutbox();
  assert.equal(gw2.store.getDelivery(row.delivery_id)?.status, "commit-unknown");
  gw2.close();
  cleanup(dir);
});

test("SIGKILL child leaving dispatching is recovered on open", async () => {
  const dir = tmpDir();
  const dbPath = join(dir, "gateway.sqlite");
  const storeUrl = new URL("../dist/store.js", import.meta.url).href;
  const child = spawn(
    process.execPath,
    [
      "--input-type=module",
      "-e",
      `
      import { Store } from ${JSON.stringify(storeUrl)};
      const store = new Store(${JSON.stringify(dbPath)});
      store.migrate();
      store.insertDelivery({
        delivery_id: "dlv_kill",
        job_id: null,
        occurrence_id: null,
        source: "enqueue",
        route_json: "{}",
        text: "k",
        not_after_ms: Date.now() + 60_000,
        status: "dispatching",
        request_id: null,
        created_at_ms: Date.now(),
        dispatch_intent: 1,
      });
      store.db.exec("PRAGMA wal_checkpoint(TRUNCATE);");
      console.log("ready");
      setInterval(() => {}, 1000);
      `,
    ],
    { stdio: ["ignore", "pipe", "pipe"] },
  );
  await new Promise<void>((resolve, reject) => {
    const t = setTimeout(() => reject(new Error("child ready timeout")), 5000);
    child.stdout?.on("data", (chunk: Uint8Array | string) => {
      if (String(chunk).includes("ready")) {
        clearTimeout(t);
        resolve();
      }
    });
    child.once("error", reject);
  });
  child.kill("SIGKILL");
  await new Promise((resolve) => child.once("exit", resolve));
  const clock = new TestClock(Date.UTC(2026, 0, 1, 10, 0, 0));
  const { gateway } = openGateway({ dbPath, clock, routes: [ROUTE] });
  assert.equal(gateway.store.getDelivery("dlv_kill")?.status, "commit-unknown");
  assert.ok(gateway.store.listAudit().some((a) => a.kind === "crash.recover"));
  gateway.close();
  cleanup(dir);
});
