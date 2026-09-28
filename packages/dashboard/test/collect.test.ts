import assert from "node:assert/strict";
import { rmSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";
import { collectStatus, LIST_LIMIT, TEXT_LIMIT } from "../dist/index.js";
import { makeProfile } from "./helpers.ts";

test("collectStatus reads jobs, occurrences, and deliveries from a temp profile DB", () => {
  const { dir, dbPath } = makeProfile({ jobs: 2, occurrences: 2, deliveries: 2 });
  try {
    const status = collectStatus(dbPath);
    assert.equal(status.jobs.length, 2);
    assert.equal(status.occurrences.length, 2);
    assert.equal(status.deliveries.length, 2);
    assert.equal(status.jobs[0]?.jobId, "job-1");
    assert.equal(status.jobs[0]?.status, "active");
    assert.equal(status.truncated.jobs, false);
    assert.equal(status.truncated.occurrences, false);
    assert.equal(status.truncated.deliveries, false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("collectStatus bounds list length", () => {
  const { dir, dbPath } = makeProfile({ jobs: LIST_LIMIT + 20, occurrences: 0, deliveries: 0 });
  try {
    const status = collectStatus(dbPath);
    assert.equal(status.jobs.length, LIST_LIMIT);
    assert.equal(status.truncated.jobs, true);
    assert.equal(status.jobsTotal, LIST_LIMIT + 20);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("collectStatus truncates text fields", () => {
  const { dir, dbPath } = makeProfile({ jobs: 1, occurrences: 0, deliveries: 1 });
  try {
    const db = new DatabaseSync(dbPath);
    db.prepare("UPDATE jobs SET text = ? WHERE job_id = ?").run("x".repeat(TEXT_LIMIT + 50), "job-0");
    db.close();
    const status = collectStatus(dbPath);
    assert.equal(status.jobs[0]?.text.length, TEXT_LIMIT);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("collectStatus lists pending-approval jobs and deliveries", () => {
  const { dir, dbPath } = makeProfile({ jobs: 1, occurrences: 0, deliveries: 1 });
  try {
    const db = new DatabaseSync(dbPath);
    db.prepare("UPDATE jobs SET status = ? WHERE job_id = ?").run("pending-approval", "job-0");
    db.prepare("UPDATE deliveries SET status = ? WHERE delivery_id = ?").run("pending-approval", "dlv-0");
    db.close();
    const status = collectStatus(dbPath);
    assert.equal(status.jobs[0]?.status, "pending-approval");
    assert.equal(status.deliveries[0]?.status, "pending-approval");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("collectStatus counts and lists from one snapshot when a writer commits between them", () => {
  const { dir, dbPath } = makeProfile({ jobs: 0, occurrences: 0, deliveries: 0 });
  const setup = new DatabaseSync(dbPath);
  setup.exec("PRAGMA journal_mode = WAL;");
  setup.close();
  const originalPrepare = DatabaseSync.prototype.prepare;
  let committed = false;
  DatabaseSync.prototype.prepare = function (this: DatabaseSync, sql: string) {
    if (!committed && sql.startsWith("SELECT job_id")) {
      committed = true;
      const writer = new DatabaseSync(dbPath);
      writer.exec("BEGIN IMMEDIATE");
      writer
        .prepare(
          "INSERT INTO jobs(job_id, kind, text, route_json, schedule_json, status, created_at_ms, watermark_ms) VALUES('job-late','static-text','late','{}','{}','active',1,1)",
        )
        .run();
      writer
        .prepare(
          "INSERT INTO deliveries(delivery_id, job_id, occurrence_id, source, route_json, text, not_after_ms, status, request_id, created_at_ms) VALUES('dlv-late','job-late',NULL,'job','{}','late',2,'queued',NULL,1)",
        )
        .run();
      writer.exec("COMMIT");
      writer.close();
    }
    return originalPrepare.call(this, sql);
  } as typeof originalPrepare;
  try {
    const status = collectStatus(dbPath);
    assert.equal(committed, true);
    assert.equal(status.jobsTotal, status.jobs.length);
    assert.equal(status.deliveriesTotal, status.deliveries.length);
    assert.equal(status.jobsTotal, 0);
    assert.equal(status.deliveriesTotal, 0);
    DatabaseSync.prototype.prepare = originalPrepare;
    const after = collectStatus(dbPath);
    assert.equal(after.jobsTotal, 1);
    assert.deepEqual(after.jobs.map((job) => job.jobId), ["job-late"]);
    assert.equal(after.deliveriesTotal, 1);
    assert.deepEqual(after.deliveries.map((delivery) => delivery.deliveryId), ["dlv-late"]);
  } finally {
    DatabaseSync.prototype.prepare = originalPrepare;
    rmSync(dir, { recursive: true, force: true });
  }
});

test("collectStatus throws when the profile DB is missing", () => {
  const { dir } = makeProfile({ jobs: 0, occurrences: 0, deliveries: 0 });
  try {
    assert.throws(() => collectStatus(join(dir, "missing.sqlite")));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
