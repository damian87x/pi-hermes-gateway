import type { Store } from "../store.js";

export type ResultRow = {
  occurrenceId: string;
  value: unknown;
  acceptedAtMs: number;
};

export type InsertOutcome =
  | { status: "accepted"; row: ResultRow }
  | { status: "rejected"; reason: "duplicate" };

export type ClaimOutcome = "claimed" | "duplicate" | "budget_exhausted";

export type ResultsStore = {
  claim(occurrenceId: string, nowMs: number, dailyInvocationLimit: number): ClaimOutcome;
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

const DAY_MS = 86_400_000;

// Use the caller's migrated profile Store; lifecycle remains with its owner.
export function createResultsStore(store: Store): ResultsStore {
  if (!store.path || store.path === ":memory:") throw new Error("worker claims require a file-backed profile Store");
  const db = store.db;
  return {
    claim(occurrenceId, nowMs, dailyInvocationLimit) {
      // Own the transaction so success cannot mean an uncommitted outer claim.
      // Every claim, whatever its later status, spends its UTC day's limit.
      return store.transaction(() => {
        if (db.prepare("SELECT 1 FROM worker_claims WHERE occurrence_id = ?").get(occurrenceId)) return "duplicate";
        const dayStartMs = Math.floor(nowMs / DAY_MS) * DAY_MS;
        const used = db.prepare(
          "SELECT COUNT(*) AS n FROM worker_claims WHERE claimed_at_ms >= ? AND claimed_at_ms < ?",
        ).get(dayStartMs, dayStartMs + DAY_MS);
        if (Number(used?.n) >= dailyInvocationLimit) return "budget_exhausted";
        db.prepare("INSERT INTO worker_claims(occurrence_id, status, claimed_at_ms) VALUES(?, 'claimed', ?)").run(occurrenceId, nowMs);
        return "claimed";
      });
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
