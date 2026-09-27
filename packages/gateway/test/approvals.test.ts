import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { cleanup, handle, openTestGw, ROUTE } from "./helpers.ts";

const cliPath = join(dirname(fileURLToPath(import.meta.url)), "..", "dist", "cli.js");

test("job with requireApproval stays pending and tick does not send until approve", () => {
  const { gw, clock, dir, adapter } = openTestGw();
  const at = "2026-01-01T12:00:00.000Z";
  const created = handle(
    gw,
    "job.create",
    {
      kind: "static-text",
      text: "needs-ok",
      route: ROUTE,
      schedule: { type: "once", atUtc: at },
      requireApproval: true,
    },
    clock.nowMs(),
  );
  assert.equal(created.ok, true);
  if (!created.ok) throw new Error("create failed");
  const jobId = (created.body as { jobId: string }).jobId;
  const job = gw.store.getJob(jobId);
  assert.equal(job?.status, "pending-approval");
  clock.set(Date.parse(at));
  gw.tick();
  assert.equal(adapter.sent.length, 0);
  assert.equal(gw.store.listDeliveries().length, 0);
  const approved = gw.approve(jobId);
  assert.equal(approved.ok, true);
  assert.equal(gw.store.getJob(jobId)?.status, "active");
  gw.tick();
  assert.equal(adapter.sent.length, 1);
  assert.equal(adapter.sent[0]?.text, "needs-ok");
  gw.close();
  cleanup(dir);
});

test("delivery with requireApproval stays pending and dispatch does not send until approve", () => {
  const { gw, clock, dir, adapter } = openTestGw();
  const enq = handle(
    gw,
    "delivery.enqueue",
    { route: ROUTE, text: "hold", notAfter: clock.nowMs() + 60_000, requireApproval: true },
    clock.nowMs(),
  );
  assert.equal(enq.ok, true);
  if (!enq.ok) throw new Error("enqueue failed");
  const deliveryId = (enq.body as { deliveryId: string; status: string }).deliveryId;
  assert.equal((enq.body as { status: string }).status, "pending-approval");
  assert.equal(gw.store.getDelivery(deliveryId)?.status, "pending-approval");
  gw.tick();
  gw.processOutbox();
  assert.equal(adapter.sent.length, 0);
  const approved = gw.approve(deliveryId);
  assert.equal(approved.ok, true);
  assert.equal(gw.store.getDelivery(deliveryId)?.status, "queued");
  gw.processOutbox();
  assert.equal(adapter.sent.length, 1);
  assert.equal(adapter.sent[0]?.text, "hold");
  gw.close();
  cleanup(dir);
});

test("job.resume does not activate a pending-approval job", () => {
  const { gw, clock, dir, adapter } = openTestGw();
  const at = "2026-01-01T12:00:00.000Z";
  const created = handle(
    gw,
    "job.create",
    {
      kind: "static-text",
      text: "no-resume",
      route: ROUTE,
      schedule: { type: "once", atUtc: at },
      requireApproval: true,
    },
    clock.nowMs(),
  );
  assert.equal(created.ok, true);
  if (!created.ok) throw new Error("create failed");
  const jobId = (created.body as { jobId: string }).jobId;
  const resumed = handle(gw, "job.resume", { jobId }, clock.nowMs());
  assert.equal(resumed.ok, false);
  assert.equal(gw.store.getJob(jobId)?.status, "pending-approval");
  clock.set(Date.parse(at));
  gw.tick();
  assert.equal(adapter.sent.length, 0);
  gw.close();
  cleanup(dir);
});

test("job.pause cannot launder a pending-approval job into paused, then resume", () => {
  const { gw, clock, dir, adapter } = openTestGw();
  const at = "2026-01-01T12:00:00.000Z";
  const created = handle(
    gw,
    "job.create",
    {
      kind: "static-text",
      text: "no-launder",
      route: ROUTE,
      schedule: { type: "once", atUtc: at },
      requireApproval: true,
    },
    clock.nowMs(),
  );
  assert.equal(created.ok, true);
  if (!created.ok) throw new Error("create failed");
  const jobId = (created.body as { jobId: string }).jobId;

  const paused = handle(gw, "job.pause", { jobId }, clock.nowMs());
  assert.equal(paused.ok, false);
  assert.equal(gw.store.getJob(jobId)?.status, "pending-approval");

  const resumed = handle(gw, "job.resume", { jobId }, clock.nowMs());
  assert.equal(resumed.ok, false);
  assert.equal(gw.store.getJob(jobId)?.status, "pending-approval");

  clock.set(Date.parse(at));
  gw.tick();
  assert.equal(adapter.sent.length, 0);
  gw.close();
  cleanup(dir);
});

test("a cancelled job cannot resume and tick does not send", () => {
  const { gw, clock, dir, adapter } = openTestGw();
  const at = "2026-01-01T12:00:00.000Z";
  const created = handle(
    gw,
    "job.create",
    {
      kind: "static-text",
      text: "no-resume-after-cancel",
      route: ROUTE,
      schedule: { type: "once", atUtc: at },
    },
    clock.nowMs(),
  );
  assert.equal(created.ok, true);
  if (!created.ok) throw new Error("create failed");
  const jobId = (created.body as { jobId: string }).jobId;
  assert.equal(gw.store.getJob(jobId)?.status, "active");

  const cancelled = handle(gw, "job.cancel", { jobId }, clock.nowMs());
  assert.equal(cancelled.ok, true);
  assert.equal(gw.store.getJob(jobId)?.status, "cancelled");

  const resumed = handle(gw, "job.resume", { jobId }, clock.nowMs());
  assert.equal(resumed.ok, false);
  assert.equal(gw.store.getJob(jobId)?.status, "cancelled");

  clock.set(Date.parse(at));
  gw.tick();
  assert.equal(adapter.sent.length, 0);
  gw.close();
  cleanup(dir);
});

test("an approved active job can pause and resume normally", () => {
  const { gw, clock, dir, adapter } = openTestGw();
  const at = "2026-01-01T12:00:00.000Z";
  const created = handle(
    gw,
    "job.create",
    {
      kind: "static-text",
      text: "pause-resume-ok",
      route: ROUTE,
      schedule: { type: "once", atUtc: at },
    },
    clock.nowMs(),
  );
  assert.equal(created.ok, true);
  if (!created.ok) throw new Error("create failed");
  const jobId = (created.body as { jobId: string }).jobId;
  assert.equal(gw.store.getJob(jobId)?.status, "active");

  const paused = handle(gw, "job.pause", { jobId }, clock.nowMs());
  assert.equal(paused.ok, true);
  assert.equal(gw.store.getJob(jobId)?.status, "paused");

  const resumed = handle(gw, "job.resume", { jobId }, clock.nowMs());
  assert.equal(resumed.ok, true);
  assert.equal(gw.store.getJob(jobId)?.status, "active");

  clock.set(Date.parse(at));
  gw.tick();
  assert.equal(adapter.sent.length, 1);
  assert.equal(adapter.sent[0]?.text, "pause-resume-ok");
  gw.close();
  cleanup(dir);
});

test("approve of unknown or already-active id fails", () => {
  const { gw, clock, dir } = openTestGw();
  const created = handle(
    gw,
    "job.create",
    {
      kind: "static-text",
      text: "live",
      route: ROUTE,
      schedule: { type: "once", atUtc: "2026-01-01T12:00:00.000Z" },
    },
    clock.nowMs(),
  );
  assert.equal(created.ok, true);
  if (!created.ok) throw new Error("create failed");
  const jobId = (created.body as { jobId: string }).jobId;
  const missing = gw.approve("job_missing");
  assert.equal(missing.ok, false);
  const twice = gw.approve(jobId);
  assert.equal(twice.ok, false);
  gw.close();
  cleanup(dir);
});

test("CLI approve mutates the profile DB and does not start a send", () => {
  const { gw, clock, dir, adapter } = openTestGw();
  const enq = handle(
    gw,
    "delivery.enqueue",
    { route: ROUTE, text: "cli-hold", notAfter: clock.nowMs() + 60_000, requireApproval: true },
    clock.nowMs(),
  );
  assert.equal(enq.ok, true);
  if (!enq.ok) throw new Error("enqueue failed");
  const deliveryId = (enq.body as { deliveryId: string }).deliveryId;
  gw.close();

  mkdirSync(dir, { recursive: true, mode: 0o700 });
  chmodSync(dir, 0o700);
  writeFileSync(join(dir, "config.json"), JSON.stringify({ routes: [ROUTE] }), { mode: 0o600 });

  const ran = spawnSync(process.execPath, [cliPath, "--profile", dir, "approve", deliveryId], {
    encoding: "utf8",
    timeout: 8_000,
  });
  assert.equal(ran.status, 0, ran.stderr);
  assert.match(ran.stdout + ran.stderr, /approved/i);

  const { gw: gw2, dir: dir2, adapter: adapter2 } = openTestGw({ dir });
  assert.equal(dir2, dir);
  assert.equal(gw2.store.getDelivery(deliveryId)?.status, "queued");
  assert.equal(adapter.sent.length, 0);
  assert.equal(adapter2.sent.length, 0);
  gw2.processOutbox();
  assert.equal(adapter2.sent.length, 1);
  gw2.close();
  cleanup(dir);
});
