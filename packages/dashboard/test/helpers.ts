import { mkdirSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";

const SCHEMA = `
CREATE TABLE IF NOT EXISTS meta (
  k TEXT PRIMARY KEY,
  v TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS jobs (
  job_id TEXT PRIMARY KEY,
  kind TEXT NOT NULL,
  text TEXT NOT NULL,
  route_json TEXT NOT NULL,
  schedule_json TEXT NOT NULL,
  status TEXT NOT NULL,
  created_at_ms INTEGER NOT NULL,
  watermark_ms INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS occurrences (
  occurrence_id TEXT PRIMARY KEY,
  job_id TEXT NOT NULL,
  scheduled_instant_ms INTEGER NOT NULL,
  status TEXT NOT NULL,
  UNIQUE(job_id, scheduled_instant_ms)
);
CREATE TABLE IF NOT EXISTS deliveries (
  delivery_id TEXT PRIMARY KEY,
  job_id TEXT,
  occurrence_id TEXT,
  source TEXT NOT NULL,
  route_json TEXT NOT NULL,
  text TEXT NOT NULL,
  not_after_ms INTEGER NOT NULL,
  status TEXT NOT NULL,
  request_id TEXT,
  created_at_ms INTEGER NOT NULL,
  dispatch_intent INTEGER NOT NULL DEFAULT 0
);
`;

export type FixtureOpts = {
  jobs?: number;
  occurrences?: number;
  deliveries?: number;
};

export function makeProfile(opts?: FixtureOpts): { dir: string; dbPath: string } {
  const dir = mkdtempSync(join(tmpdir(), "gw-dash-"));
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const dbPath = join(dir, "gateway.sqlite");
  const db = new DatabaseSync(dbPath);
  db.exec(SCHEMA);
  const jobCount = opts?.jobs ?? 1;
  const occCount = opts?.occurrences ?? 1;
  const dlvCount = opts?.deliveries ?? 1;
  const route = JSON.stringify({
    profileId: "profile-a",
    adapterId: "fake",
    accountId: "acct-1",
    chatId: "chat-1",
  });
  for (let i = 0; i < jobCount; i += 1) {
    db.prepare(
      "INSERT INTO jobs(job_id, kind, text, route_json, schedule_json, status, created_at_ms, watermark_ms) VALUES(?,?,?,?,?,?,?,?)",
    ).run(
      `job-${i}`,
      "static-text",
      `hello-${i}`,
      route,
      JSON.stringify({ kind: "once", atMs: 1_000 + i }),
      "active",
      1_700_000_000_000 + i,
      1_700_000_000_000 + i,
    );
  }
  for (let i = 0; i < occCount; i += 1) {
    db.prepare(
      "INSERT INTO occurrences(occurrence_id, job_id, scheduled_instant_ms, status) VALUES(?,?,?,?)",
    ).run(`occ-${i}`, `job-${Math.min(i, Math.max(jobCount - 1, 0))}`, 1_700_000_000_000 + i, "pending");
  }
  for (let i = 0; i < dlvCount; i += 1) {
    db.prepare(
      "INSERT INTO deliveries(delivery_id, job_id, occurrence_id, source, route_json, text, not_after_ms, status, request_id, created_at_ms, dispatch_intent) VALUES(?,?,?,?,?,?,?,?,?,?,?)",
    ).run(
      `dlv-${i}`,
      `job-${Math.min(i, Math.max(jobCount - 1, 0))}`,
      `occ-${Math.min(i, Math.max(occCount - 1, 0))}`,
      "job",
      route,
      `payload-${i}`,
      1_700_000_086_400 + i,
      "queued",
      null,
      1_700_000_000_000 + i,
      0,
    );
  }
  db.close();
  return { dir, dbPath };
}
