import type { Store } from "../store.js";

export type ResultRow = {
  occurrenceId: string;
  value: unknown;
  acceptedAtMs: number;
};

export type InsertOutcome =
  | { status: "accepted"; row: ResultRow }
  | { status: "rejected"; reason: "duplicate" };

export type ResultsStore = {
  claim(occurrenceId: string, nowMs: number): boolean;
  releaseUnstarted(occurrenceId: string): void;
  interrupt(occurrenceId: string): void;
  complete(occurrenceId: string, value: unknown, nowMs: number): ResultRow;
  insert(occurrenceId: string, value: unknown, nowMs: number): InsertOutcome;
  get(occurrenceId: string): ResultRow | undefined;
  list(): ResultRow[];
};

function decode(row: Record<string, unknown>): ResultRow {
  return {
    occurrenceId: String(row.occurrence_id),
    value: JSON.parse(String(row.result_json)),
    acceptedAtMs: Number(row.accepted_at_ms),
  };
}

// Use the caller's migrated profile Store; lifecycle remains with its owner.
export function createResultsStore(store: Store): ResultsStore {
  if (!store.path || store.path === ":memory:") throw new Error("worker claims require a file-backed profile Store");
  const db = store.db;
  return {
    claim(occurrenceId, nowMs) {
      // Own the transaction so success cannot mean an uncommitted outer claim.
      return store.transaction(() => db.prepare(
        "INSERT INTO worker_claims(occurrence_id, status, claimed_at_ms) VALUES(?, 'claimed', ?) ON CONFLICT(occurrence_id) DO NOTHING",
      ).run(occurrenceId, nowMs).changes === 1);
    },
    releaseUnstarted(occurrenceId) {
      // Only budget denial, before runWorker is called, may release a claim.
      db.prepare("DELETE FROM worker_claims WHERE occurrence_id = ? AND status = 'claimed'").run(occurrenceId);
    },
    interrupt(occurrenceId) {
      db.prepare("UPDATE worker_claims SET status = 'interrupted' WHERE occurrence_id = ? AND status = 'claimed'").run(occurrenceId);
    },
    complete(occurrenceId, value, nowMs) {
      const updated = db.prepare(
        "UPDATE worker_claims SET status = 'completed', result_json = ?, accepted_at_ms = ? WHERE occurrence_id = ? AND status = 'claimed'",
      ).run(JSON.stringify(value), nowMs, occurrenceId);
      if (updated.changes !== 1) throw new Error(`worker claim is not pending: ${occurrenceId}`);
      return { occurrenceId, value, acceptedAtMs: nowMs };
    },
    insert(occurrenceId, value, nowMs) {
      const inserted = db.prepare(
        "INSERT INTO worker_claims(occurrence_id, status, claimed_at_ms, result_json, accepted_at_ms) VALUES(?, 'completed', ?, ?, ?) ON CONFLICT(occurrence_id) DO NOTHING",
      ).run(occurrenceId, nowMs, JSON.stringify(value), nowMs);
      return inserted.changes === 1
        ? { status: "accepted", row: { occurrenceId, value, acceptedAtMs: nowMs } }
        : { status: "rejected", reason: "duplicate" };
    },
    get(occurrenceId) {
      const row = db.prepare("SELECT * FROM worker_claims WHERE occurrence_id = ? AND status = 'completed'").get(occurrenceId);
      return row ? decode(row) : undefined;
    },
    list() {
      return db.prepare("SELECT * FROM worker_claims WHERE status = 'completed' ORDER BY rowid").all().map(decode);
    },
  };
}
