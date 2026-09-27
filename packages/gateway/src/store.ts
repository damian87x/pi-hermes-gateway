import { existsSync, mkdtempSync, renameSync, rmSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";

export const SCHEMA_VERSION = 2;

const MIGRATION_V2 = `
CREATE TABLE worker_claims (
  occurrence_id TEXT PRIMARY KEY,
  status TEXT NOT NULL CHECK(status IN ('claimed', 'completed', 'interrupted')),
  claimed_at_ms INTEGER NOT NULL,
  result_json TEXT,
  accepted_at_ms INTEGER
);
`;

const MIGRATION_V1 = `
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
CREATE UNIQUE INDEX IF NOT EXISTS deliveries_request_id ON deliveries(request_id) WHERE request_id IS NOT NULL;
CREATE TABLE IF NOT EXISTS audit (
  audit_id INTEGER PRIMARY KEY AUTOINCREMENT,
  at_ms INTEGER NOT NULL,
  kind TEXT NOT NULL,
  payload_json TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS request_log (
  request_id TEXT PRIMARY KEY,
  response_json TEXT NOT NULL,
  at_ms INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS fuse_account (
  account_id TEXT PRIMARY KEY,
  tokens REAL NOT NULL,
  updated_at_ms INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS fuse_route_day (
  route_key TEXT NOT NULL,
  day TEXT NOT NULL,
  count INTEGER NOT NULL,
  PRIMARY KEY (route_key, day)
);
`;

declare const performance: { now(): number };

// SQLite reports SQLITE_BUSY without calling the busy handler while another connection holds a
// lock during conversion to WAL, so concurrent first opens of a fresh ledger fail despite
// busy_timeout. Only this transaction-free statement is retried, against one deadline.
const WAL_INIT_BUDGET_MS = 5000;
const WAL_INIT_RETRY_SLEEP_MS = 25;
const SQLITE_BUSY = 5;
const SQLITE_BUSY_SNAPSHOT = 517;

function isSqliteBusy(err: unknown): boolean {
  const errcode = (err as { errcode?: unknown } | null)?.errcode;
  return typeof errcode === "number" && (errcode & 0xff) === SQLITE_BUSY && errcode !== SQLITE_BUSY_SNAPSHOT;
}

function enableWal(db: DatabaseSync): void {
  const deadlineMs = performance.now() + WAL_INIT_BUDGET_MS;
  const sleeper = new Int32Array(new SharedArrayBuffer(4));
  for (;;) {
    db.exec(`PRAGMA busy_timeout = ${Math.ceil(deadlineMs - performance.now())};`);
    try {
      db.exec("PRAGMA journal_mode = WAL;");
      return;
    } catch (err) {
      if (!isSqliteBusy(err)) throw err;
      const sleepMs = Math.min(WAL_INIT_RETRY_SLEEP_MS, deadlineMs - performance.now());
      if (sleepMs <= 0) throw err;
      Atomics.wait(sleeper, 0, 0, sleepMs);
      if (performance.now() >= deadlineMs) throw err;
    }
  }
}

export type JobRow = {
  job_id: string;
  kind: string;
  text: string;
  route_json: string;
  schedule_json: string;
  status: string;
  created_at_ms: number;
  watermark_ms: number;
};

export type OccurrenceRow = {
  occurrence_id: string;
  job_id: string;
  scheduled_instant_ms: number;
  status: string;
};

export type DeliveryRow = {
  delivery_id: string;
  job_id: string | null;
  occurrence_id: string | null;
  source: string;
  route_json: string;
  text: string;
  not_after_ms: number;
  status: string;
  request_id: string | null;
  created_at_ms: number;
  dispatch_intent: number;
};

export type AuditRow = {
  audit_id: number;
  at_ms: number;
  kind: string;
  payload_json: string;
};

export class Store {
  readonly db: DatabaseSync;
  readonly path: string;

  constructor(path: string) {
    this.path = path;
    const db = new DatabaseSync(path);
    try {
      enableWal(db);
      db.exec("PRAGMA busy_timeout = 5000;");
      db.exec("PRAGMA foreign_keys = ON;");
    } catch (err) {
      db.close();
      throw err;
    }
    this.db = db;
  }

  userVersion(): number {
    const row = this.db.prepare("PRAGMA user_version").get();
    if (!row) return 0;
    const v = row.user_version;
    return typeof v === "number" ? v : 0;
  }

  migrate(): { backedUpTo: string | null } {
    const version = this.userVersion();
    if (version > SCHEMA_VERSION) {
      this.db.close();
      throw new Error(`schema version ${version} is newer than binary ${SCHEMA_VERSION}`);
    }
    let backedUpTo: string | null = null;
    if (version < SCHEMA_VERSION) {
      this.transaction(() => {
        // Recheck under the writer lock: only the winner may publish a backup.
        const version = this.userVersion();
        if (version > SCHEMA_VERSION) {
          throw new Error(`schema version ${version} is newer than binary ${SCHEMA_VERSION}`);
        }
        if (version === SCHEMA_VERSION) return;
        if (this.path !== ":memory:" && existsSync(this.path)) {
          backedUpTo = `${this.path}.pre-migrate-v${version}-to-v${SCHEMA_VERSION}.bak`;
          const tempDir = mkdtempSync(`${backedUpTo}.tmp-`);
          try {
            const snapshot = `${tempDir}/snapshot.sqlite`;
            // VACUUM cannot run in a transaction. A separate WAL reader includes
            // committed pages while our writer lock prevents any schema/data change.
            const source = new DatabaseSync(this.path, { readOnly: true });
            try {
              source.prepare("VACUUM INTO ?").run(snapshot);
            } finally {
              source.close();
            }
            renameSync(snapshot, backedUpTo);
          } finally {
            rmSync(tempDir, { recursive: true, force: true });
          }
        }
        if (version < 1) {
          this.db.exec(MIGRATION_V1);
          this.setMeta("dispatch_enabled", "1");
          this.setMeta("quarantine", "0");
        }
        if (version < 2) this.db.exec(MIGRATION_V2);
        this.db.exec(`PRAGMA user_version = ${SCHEMA_VERSION}`);
      });
    }
    return { backedUpTo };
  }

  close(): void {
    // migrate() already closed the connection when it rejected a newer schema.
    if (!(this.db as DatabaseSync & { readonly isOpen: boolean }).isOpen) return;
    try {
      this.db.exec("PRAGMA wal_checkpoint(TRUNCATE);");
    } catch {
      /* ignore checkpoint errors on close */
    }
    this.db.close();
  }

  setMeta(k: string, v: string): void {
    this.db.prepare("INSERT INTO meta(k, v) VALUES(?, ?) ON CONFLICT(k) DO UPDATE SET v = excluded.v").run(k, v);
  }

  getMeta(k: string): string | null {
    const row = this.db.prepare("SELECT v FROM meta WHERE k = ?").get(k);
    return row && typeof row.v === "string" ? row.v : null;
  }

  dispatchEnabled(): boolean {
    return this.getMeta("dispatch_enabled") !== "0";
  }

  transaction<T>(fn: () => T): T {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const result = fn();
      this.db.exec("COMMIT");
      return result;
    } catch (err) {
      this.db.exec("ROLLBACK");
      throw err;
    }
  }

  insertJob(row: JobRow): void {
    this.db
      .prepare(
        "INSERT INTO jobs(job_id, kind, text, route_json, schedule_json, status, created_at_ms, watermark_ms) VALUES(?,?,?,?,?,?,?,?)",
      )
      .run(
        row.job_id,
        row.kind,
        row.text,
        row.route_json,
        row.schedule_json,
        row.status,
        row.created_at_ms,
        row.watermark_ms,
      );
  }

  getJob(jobId: string): JobRow | undefined {
    return this.db.prepare("SELECT * FROM jobs WHERE job_id = ?").get(jobId) as JobRow | undefined;
  }

  listJobs(): JobRow[] {
    return this.db.prepare("SELECT * FROM jobs ORDER BY created_at_ms").all() as JobRow[];
  }

  setJobStatus(jobId: string, status: string): void {
    this.db.prepare("UPDATE jobs SET status = ? WHERE job_id = ?").run(status, jobId);
  }

  setWatermark(jobId: string, watermarkMs: number): void {
    this.db.prepare("UPDATE jobs SET watermark_ms = ? WHERE job_id = ?").run(watermarkMs, jobId);
  }

  insertOccurrence(row: OccurrenceRow): void {
    this.db
      .prepare("INSERT INTO occurrences(occurrence_id, job_id, scheduled_instant_ms, status) VALUES(?,?,?,?)")
      .run(row.occurrence_id, row.job_id, row.scheduled_instant_ms, row.status);
  }

  getOccurrence(id: string): OccurrenceRow | undefined {
    return this.db.prepare("SELECT * FROM occurrences WHERE occurrence_id = ?").get(id) as OccurrenceRow | undefined;
  }

  findOccurrence(jobId: string, scheduledInstantMs: number): OccurrenceRow | undefined {
    return this.db
      .prepare("SELECT * FROM occurrences WHERE job_id = ? AND scheduled_instant_ms = ?")
      .get(jobId, scheduledInstantMs) as OccurrenceRow | undefined;
  }

  listOccurrences(jobId?: string): OccurrenceRow[] {
    if (jobId) {
      return this.db
        .prepare("SELECT * FROM occurrences WHERE job_id = ? ORDER BY scheduled_instant_ms")
        .all(jobId) as OccurrenceRow[];
    }
    return this.db.prepare("SELECT * FROM occurrences ORDER BY scheduled_instant_ms").all() as OccurrenceRow[];
  }

  setOccurrenceStatus(id: string, status: string): void {
    this.db.prepare("UPDATE occurrences SET status = ? WHERE occurrence_id = ?").run(status, id);
  }

  insertDelivery(row: DeliveryRow): void {
    this.db
      .prepare(
        "INSERT INTO deliveries(delivery_id, job_id, occurrence_id, source, route_json, text, not_after_ms, status, request_id, created_at_ms, dispatch_intent) VALUES(?,?,?,?,?,?,?,?,?,?,?)",
      )
      .run(
        row.delivery_id,
        row.job_id,
        row.occurrence_id,
        row.source,
        row.route_json,
        row.text,
        row.not_after_ms,
        row.status,
        row.request_id,
        row.created_at_ms,
        row.dispatch_intent,
      );
  }

  getDelivery(id: string): DeliveryRow | undefined {
    return this.db.prepare("SELECT * FROM deliveries WHERE delivery_id = ?").get(id) as DeliveryRow | undefined;
  }

  getDeliveryByRequestId(requestId: string): DeliveryRow | undefined {
    return this.db
      .prepare("SELECT * FROM deliveries WHERE request_id = ?")
      .get(requestId) as DeliveryRow | undefined;
  }

  listDeliveries(): DeliveryRow[] {
    return this.db.prepare("SELECT * FROM deliveries ORDER BY created_at_ms").all() as DeliveryRow[];
  }

  queuedDeliveries(): DeliveryRow[] {
    return this.db.prepare("SELECT * FROM deliveries WHERE status = 'queued' ORDER BY created_at_ms").all() as DeliveryRow[];
  }

  setDeliveryStatus(id: string, status: string): void {
    this.db.prepare("UPDATE deliveries SET status = ? WHERE delivery_id = ?").run(status, id);
  }

  setDispatchIntent(id: string): void {
    this.db.prepare("UPDATE deliveries SET dispatch_intent = 1, status = 'dispatching' WHERE delivery_id = ?").run(id);
  }

  // One statement, so a job cancel either sees the row dispatching or this sees the job not active.
  claimDispatchIntent(id: string): boolean {
    const result = this.db
      .prepare(
        "UPDATE deliveries SET dispatch_intent = 1, status = 'dispatching' WHERE delivery_id = ? AND status = 'queued' " +
          "AND (job_id IS NULL OR EXISTS (SELECT 1 FROM jobs WHERE jobs.job_id = deliveries.job_id AND jobs.status = 'active'))",
      )
      .run(id);
    return Number(result.changes) === 1;
  }

  queuedJobDeliveries(jobId: string): DeliveryRow[] {
    return this.db
      .prepare("SELECT * FROM deliveries WHERE job_id = ? AND status = 'queued' ORDER BY created_at_ms")
      .all(jobId) as DeliveryRow[];
  }

  insertAudit(atMs: number, kind: string, payload: unknown): void {
    this.db.prepare("INSERT INTO audit(at_ms, kind, payload_json) VALUES(?,?,?)").run(atMs, kind, JSON.stringify(payload));
  }

  listAudit(): AuditRow[] {
    return this.db.prepare("SELECT * FROM audit ORDER BY audit_id").all() as AuditRow[];
  }

  getRequest(requestId: string): string | null {
    const row = this.db.prepare("SELECT response_json FROM request_log WHERE request_id = ?").get(requestId);
    return row && typeof row.response_json === "string" ? row.response_json : null;
  }

  putRequest(requestId: string, responseJson: string, atMs: number): void {
    this.db.prepare("INSERT OR IGNORE INTO request_log(request_id, response_json, at_ms) VALUES(?,?,?)").run(
      requestId,
      responseJson,
      atMs,
    );
  }

  // Replaces an existing entry only when it answers with the same delivery, never another response.
  putDeliveryRequest(requestId: string, deliveryId: string, responseJson: string, atMs: number): void {
    this.db
      .prepare(
        "INSERT INTO request_log(request_id, response_json, at_ms) VALUES(?,?,?) ON CONFLICT(request_id) DO UPDATE " +
          "SET response_json = excluded.response_json, at_ms = excluded.at_ms " +
          "WHERE json_extract(request_log.response_json, '$.body.deliveryId') = ?",
      )
      .run(requestId, responseJson, atMs, deliveryId);
  }

  getAccountFuse(accountId: string): { tokens: number; updated_at_ms: number } | undefined {
    const row = this.db.prepare("SELECT tokens, updated_at_ms FROM fuse_account WHERE account_id = ?").get(accountId);
    if (!row) return undefined;
    return { tokens: Number(row.tokens), updated_at_ms: Number(row.updated_at_ms) };
  }

  setAccountFuse(accountId: string, tokens: number, updatedAtMs: number): void {
    this.db
      .prepare(
        "INSERT INTO fuse_account(account_id, tokens, updated_at_ms) VALUES(?,?,?) ON CONFLICT(account_id) DO UPDATE SET tokens = excluded.tokens, updated_at_ms = excluded.updated_at_ms",
      )
      .run(accountId, tokens, updatedAtMs);
  }

  getRouteDay(routeKey: string, day: string): number {
    const row = this.db.prepare("SELECT count FROM fuse_route_day WHERE route_key = ? AND day = ?").get(routeKey, day);
    return row ? Number(row.count) : 0;
  }

  setRouteDay(routeKey: string, day: string, count: number): void {
    this.db
      .prepare(
        "INSERT INTO fuse_route_day(route_key, day, count) VALUES(?,?,?) ON CONFLICT(route_key, day) DO UPDATE SET count = excluded.count",
      )
      .run(routeKey, day, count);
  }

  applyRestoreQuarantine(backupTimeMs: number, recoveryTimeMs: number): void {
    this.setMeta("dispatch_enabled", "0");
    this.setMeta("quarantine", "1");
    this.setMeta("backup_time_ms", String(backupTimeMs));
    this.setMeta("recovery_time_ms", String(recoveryTimeMs));
    this.db
      .prepare(
        "UPDATE deliveries SET status = 'commit-unknown' WHERE status IN ('pending-approval', 'queued', 'dispatching')",
      )
      .run();
    this.db
      .prepare(
        "UPDATE occurrences SET status = 'skipped' WHERE status IN ('pending', 'claimed', 'interrupted') AND scheduled_instant_ms > ? AND scheduled_instant_ms <= ?",
      )
      .run(backupTimeMs, recoveryTimeMs);
  }
}
