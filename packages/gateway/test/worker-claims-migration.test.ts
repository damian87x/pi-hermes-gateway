import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";
import { Store, SCHEMA_VERSION } from "../dist/store.js";

function versionOneStore() {
  const dir = mkdtempSync(join(tmpdir(), "worker-migration-"));
  const store = new Store(join(dir, "gateway.sqlite"));
  // Retain a second connection and disable checkpoints to leave real WAL-only data.
  store.db.exec("PRAGMA wal_autocheckpoint = 0; CREATE TABLE meta(k TEXT PRIMARY KEY, v TEXT NOT NULL); PRAGMA user_version = 1;");
  store.db.exec("PRAGMA wal_checkpoint(TRUNCATE)");
  const reader = new DatabaseSync(store.path);
  store.setMeta("wal-only", "preserved");
  assert.ok(statSync(`${store.path}-wal`).size > 0);
  return { dir, store, reader, backup: `${store.path}.pre-migrate-v1-to-v${SCHEMA_VERSION}.bak` };
}

test("worker-claims migration: v1 WAL data is preserved in backup and upgraded DB", () => {
  const { dir, store, reader, backup } = versionOneStore();
  try {
    writeFileSync(backup, "previous backup");
    assert.equal(store.migrate().backedUpTo, backup);
    assert.equal(store.userVersion(), 2);
    assert.equal(store.getMeta("wal-only"), "preserved");
    const snapshot = new DatabaseSync(backup, { readOnly: true });
    try {
      assert.equal(snapshot.prepare("PRAGMA user_version").get().user_version, 1);
      assert.equal(snapshot.prepare("SELECT v FROM meta WHERE k = 'wal-only'").get().v, "preserved");
      assert.equal(snapshot.prepare("PRAGMA integrity_check").get().integrity_check, "ok");
    } finally {
      snapshot.close();
    }
    store.db.prepare("INSERT INTO worker_claims(occurrence_id, status, claimed_at_ms) VALUES('occ', 'claimed', 1)").run();
    assert.deepEqual(store.migrate(), { backedUpTo: null });
    assert.equal(readdirSync(dir).some((name) => name.includes(".tmp-")), false);
  } finally {
    reader.close();
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("worker-claims migration: backup publication failure leaves v1 and prior backup intact", () => {
  const { dir, store, reader, backup } = versionOneStore();
  try {
    mkdirSync(backup);
    writeFileSync(join(backup, "prior"), "keep");
    assert.throws(() => store.migrate(), /EISDIR|ENOTEMPTY|EEXIST/);
    assert.equal(store.userVersion(), 1);
    assert.equal(store.getMeta("wal-only"), "preserved");
    assert.equal(readFileSync(join(backup, "prior"), "utf8"), "keep");
    assert.equal(readdirSync(dir).some((name) => name.includes(".tmp-")), false);
    assert.equal(store.db.prepare("SELECT name FROM sqlite_master WHERE name = 'worker_claims'").get(), undefined);
  } finally {
    reader.close();
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("worker-claims migration: failed snapshot preserves an existing backup file", () => {
  const { dir, store, reader, backup } = versionOneStore();
  try {
    writeFileSync(backup, "previous backup");
    store.db.exec("PRAGMA query_only = ON");
    assert.throws(() => store.migrate(), /readonly/);
    assert.equal(store.userVersion(), 1);
    assert.equal(store.getMeta("wal-only"), "preserved");
    assert.equal(readFileSync(backup, "utf8"), "previous backup");
    assert.equal(readdirSync(dir).some((name) => name.includes(".tmp-")), false);
  } finally {
    reader.close();
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
