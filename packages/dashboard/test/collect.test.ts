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

test("collectStatus throws when the profile DB is missing", () => {
  const { dir } = makeProfile({ jobs: 0, occurrences: 0, deliveries: 0 });
  try {
    assert.throws(() => collectStatus(join(dir, "missing.sqlite")));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
