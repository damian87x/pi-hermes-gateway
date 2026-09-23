export type ResultRow = {
  occurrenceId: string;
  value: unknown;
  acceptedAtMs: number;
};

export type InsertOutcome =
  | { status: "accepted"; row: ResultRow }
  | { status: "rejected"; reason: "duplicate" };

export type ResultsStore = {
  insert(occurrenceId: string, value: unknown, nowMs: number): InsertOutcome;
  get(occurrenceId: string): ResultRow | undefined;
  list(): ResultRow[];
};

export function createResultsStore(): ResultsStore {
  const rows = new Map<string, ResultRow>();
  return {
    insert(occurrenceId, value, nowMs) {
      if (rows.has(occurrenceId)) {
        return { status: "rejected", reason: "duplicate" };
      }
      const row: ResultRow = { occurrenceId, value, acceptedAtMs: nowMs };
      rows.set(occurrenceId, row);
      return { status: "accepted", row };
    },
    get(occurrenceId) {
      return rows.get(occurrenceId);
    },
    list() {
      return [...rows.values()];
    },
  };
}
