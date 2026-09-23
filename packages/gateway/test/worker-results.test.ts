import assert from "node:assert/strict";
import { test } from "node:test";
import { createResultsStore } from "../dist/worker/results.js";

test("worker-results accepts exactly one result row per occurrence", () => {
  const store = createResultsStore();
  const outcome = store.insert("occ-1", { ok: true }, 1000);
  assert.equal(outcome.status, "accepted");
  const row = store.get("occ-1");
  assert.equal(row?.occurrenceId, "occ-1");
  assert.deepEqual(row?.value, { ok: true });
  assert.equal(store.list().length, 1);
});

test("worker-results rejects a second insert for the same occurrence", () => {
  const store = createResultsStore();
  store.insert("occ-1", { ok: true }, 1000);
  const second = store.insert("occ-1", { ok: false }, 2000);
  assert.equal(second.status, "rejected");
  assert.equal(store.list().length, 1);
  assert.deepEqual(store.get("occ-1")?.value, { ok: true });
});
