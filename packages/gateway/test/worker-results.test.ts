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
  assert.equal(a.claim("occ", 1), true);
  assert.equal(b.claim("occ", 2), false);
  assert.deepEqual(b.insert("occ", "late", 2), { status: "rejected", reason: "duplicate" });
  assert.equal(b.get("occ"), undefined);
  a.complete("occ", { kind: "ok", text: "done" }, 3);
  assert.deepEqual(b.get("occ"), a.get("occ"));
  assert.equal(b.claim("occ", 4), false);
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
  assert.throws(() => db.transaction(() => store.claim("occ", 1)), /transaction/);
  assert.equal(store.claim("occ", 2), true);
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
