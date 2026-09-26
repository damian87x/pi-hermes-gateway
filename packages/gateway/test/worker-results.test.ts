import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Store } from "../dist/store.js";
import { createResultsStore } from "../dist/worker/results.js";

function results(t) {
  const dir = mkdtempSync(join(tmpdir(), "worker-results-"));
  const db = new Store(join(dir, "gateway.sqlite"));
  db.migrate();
  t.after(() => {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  });
  return createResultsStore(db);
}

test("worker-results accepts exactly one result row per occurrence", (t) => {
  const store = results(t);
  const outcome = store.insert("occ-1", { ok: true }, 1000);
  assert.equal(outcome.status, "accepted");
  const row = store.get("occ-1");
  assert.equal(row?.occurrenceId, "occ-1");
  assert.deepEqual(row?.value, { ok: true });
  assert.equal(store.list().length, 1);
});

test("worker-results rejects a second insert for the same occurrence", (t) => {
  const store = results(t);
  store.insert("occ-1", { ok: true }, 1000);
  const second = store.insert("occ-1", { ok: false }, 2000);
  assert.equal(second.status, "rejected");
  assert.equal(store.list().length, 1);
  assert.deepEqual(store.get("occ-1")?.value, { ok: true });
});

test("worker-results: claims exclude competing connections and cannot be overwritten by insert", (t) => {
  const dir = mkdtempSync(join(tmpdir(), "worker-claims-"));
  const first = new Store(join(dir, "gateway.sqlite"));
  first.migrate();
  const second = new Store(first.path);
  t.after(() => {
    second.close();
    first.close();
    rmSync(dir, { recursive: true, force: true });
  });
  const a = createResultsStore(first);
  const b = createResultsStore(second);
  assert.equal(a.claim("occ", 1, 2), "claimed");
  assert.equal(b.claim("occ", 2, 2), "duplicate");
  assert.deepEqual(b.insert("occ", "late", 2), { status: "rejected", reason: "duplicate" });
  assert.equal(b.get("occ"), undefined);
  a.complete("occ", { kind: "ok", text: "done" }, 3);
  assert.deepEqual(b.get("occ"), a.get("occ"));
  assert.equal(b.claim("occ", 4, 2), "duplicate");
});

test("worker-results: daily limit is shared across connections and counts every claim status", (t) => {
  const dir = mkdtempSync(join(tmpdir(), "worker-claims-"));
  const first = new Store(join(dir, "gateway.sqlite"));
  first.migrate();
  const second = new Store(first.path);
  t.after(() => {
    second.close();
    first.close();
    rmSync(dir, { recursive: true, force: true });
  });
  const a = createResultsStore(first);
  const b = createResultsStore(second);
  assert.equal(a.claim("occ-a", 1000, 1), "claimed");
  a.interrupt("occ-a");
  assert.equal(b.claim("occ-b", 2000, 1), "budget_exhausted");
  // Duplicates are rejected before budget, and denial leaves no claim behind.
  assert.equal(b.claim("occ-a", 2000, 0), "duplicate");
  assert.equal(first.db.prepare("SELECT COUNT(*) AS n FROM worker_claims").get().n, 1);
  assert.equal(b.claim("occ-b", 2000, 2), "claimed");
});

test("worker-results: daily limit uses UTC days, start-inclusive and end-exclusive", (t) => {
  const store = results(t);
  const day = Date.UTC(2026, 8, 26);
  const next = Date.UTC(2026, 8, 27);
  assert.equal(next - day, 86_400_000);
  // Start-inclusive: a claim at 00:00:00.000 UTC spends that day's limit.
  assert.equal(store.claim("day-first", day, 1), "claimed");
  assert.equal(store.claim("day-last", next - 1, 1), "budget_exhausted");
  // End-exclusive: that midnight claim does not spend the previous day's limit.
  assert.equal(store.claim("prev-last", day - 1, 1), "claimed");
  assert.equal(store.claim("next-first", next, 1), "claimed");
});

test("worker-results: uncommitted outer transactions cannot admit a worker", (t) => {
  const dir = mkdtempSync(join(tmpdir(), "worker-claims-"));
  const db = new Store(join(dir, "gateway.sqlite"));
  db.migrate();
  t.after(() => {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  });
  const store = createResultsStore(db);
  assert.throws(() => db.transaction(() => store.claim("occ", 1, 1)), /transaction/);
  assert.equal(store.claim("occ", 2, 1), "claimed");
});

test("worker-results: refuses in-memory and temporary stores", () => {
  for (const path of [":memory:", ""]) {
    const db = new Store(path);
    try {
      db.migrate();
      assert.throws(() => createResultsStore(db), /file-backed/);
    } finally {
      db.close();
    }
  }
});
