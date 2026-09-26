import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";
import { Store, SCHEMA_VERSION } from "../dist/store.js";

function versionOneStore() {
  const dir = mkdtempSync(join(tmpdir(), "worker-migration-"));
  const store = new Store(join(dir, "gateway.sqlite"));
  // V2 only adds worker_claims; remove it to retain the complete production v1 schema.
  const { backedUpTo } = store.migrate();
  rmSync(backedUpTo);
  store.db.exec("DROP TABLE worker_claims; PRAGMA user_version = 1;");
  // Retain a second connection and disable checkpoints to leave real WAL-only data.
  store.db.exec("PRAGMA wal_autocheckpoint = 0;");
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

test("worker-claims migration: three processes upgrade v1 without overwriting its WAL backup with v2", async () => {
  const { dir, store, reader, backup } = versionOneStore();
  const script = `
    import { existsSync, writeFileSync } from "node:fs";
    import { Store } from ${JSON.stringify(new URL("../dist/store.js", import.meta.url).href)};
    const [path, dir, id] = process.argv.slice(1);
    const store = new Store(path);
    const userVersion = store.userVersion.bind(store);
    let firstRead = true;
    const sleeper = new Int32Array(new SharedArrayBuffer(4));
    const waitFor = (ready) => {
      const deadline = Date.now() + 5000;
      while (!ready()) {
        if (Date.now() > deadline) throw new Error("migration barrier timed out");
        Atomics.wait(sleeper, 0, 0, 5);
      }
    };
    store.userVersion = () => {
      const version = userVersion();
      if (firstRead) {
        firstRead = false;
        writeFileSync(dir + "/ready-" + id, "");
        // All three see v1; process 2 resumes only after a competitor migrates.
        waitFor(() => [0, 1, 2].every((i) => existsSync(dir + "/ready-" + i)));
        if (id === "2") waitFor(() => existsSync(dir + "/migrated"));
      }
      return version;
    };
    try {
      const result = store.migrate();
      writeFileSync(dir + "/migrated", "");
      process.stdout.write(JSON.stringify(result));
    } finally {
      store.close();
    }
  `;
  try {
    const outcomes = await Promise.all([0, 1, 2].map((id) => new Promise((resolve, reject) => {
      const child = spawn(process.execPath, ["--input-type=module", "-e", script, store.path, dir, String(id)], {
        stdio: ["ignore", "pipe", "pipe"],
        timeout: 10000,
      });
      let stdout = "";
      let stderr = "";
      child.stdout.on("data", (data) => { stdout += data; });
      child.stderr.on("data", (data) => { stderr += data; });
      child.once("error", reject);
      child.once("close", (code) => resolve({ code, stdout, stderr }));
    })));
    const snapshot = new DatabaseSync(backup, { readOnly: true });
    try {
      assert.deepEqual({
        exitCodes: outcomes.map((outcome) => outcome.code),
        backupVersion: snapshot.prepare("PRAGMA user_version").get().user_version,
      }, { exitCodes: [0, 0, 0], backupVersion: 1 }, JSON.stringify(outcomes));
      assert.equal(snapshot.prepare("SELECT v FROM meta WHERE k = 'wal-only'").get().v, "preserved");
      assert.equal(snapshot.prepare("SELECT name FROM sqlite_master WHERE name = 'worker_claims'").get(), undefined);
      assert.equal(snapshot.prepare("PRAGMA integrity_check").get().integrity_check, "ok");
    } finally {
      snapshot.close();
    }
    assert.equal(outcomes.filter((outcome) => JSON.parse(outcome.stdout).backedUpTo === backup).length, 1);
    assert.equal(store.userVersion(), 2);
    assert.equal(store.getMeta("wal-only"), "preserved");
    assert.equal(store.db.prepare("SELECT count(*) AS n FROM worker_claims").get().n, 0);
    assert.equal(store.db.prepare("PRAGMA integrity_check").get().integrity_check, "ok");
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

test("worker-claims migration: VACUUM failure under writer lock preserves v1 and prior backup, cleans up, and allows retry", (t) => {
  const { dir, store, reader, backup } = versionOneStore();
  const tables = ["meta", "jobs", "occurrences", "deliveries", "audit", "request_log", "fuse_account", "fuse_route_day", "sqlite_sequence"];
  const readState = (db) => ({
    version: db.prepare("PRAGMA user_version").get().user_version,
    schema: db.prepare("SELECT type, name, tbl_name, sql FROM sqlite_master ORDER BY type, name").all(),
    rows: tables.map((table) => db.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all()),
  });
  try {
    const originalMain = readFileSync(store.path);
    store.db.exec(`
      BEGIN;
      INSERT INTO jobs VALUES('job', 'once', 'work', '{"kind":"fake"}', '{"atMs":100}', 'active', 1, 0);
      INSERT INTO occurrences VALUES('occ', 'job', 100, 'pending');
      INSERT INTO deliveries VALUES('delivery', 'job', 'occ', 'worker', '{"kind":"fake"}', 'result', 200, 'queued', 'request', 1, 0);
      INSERT INTO audit(at_ms, kind, payload_json) VALUES(1, 'created', '{"jobId":"job"}');
      INSERT INTO request_log VALUES('request', '{"ok":true}', 1);
      INSERT INTO fuse_account VALUES('account', 3.5, 1);
      INSERT INTO fuse_route_day VALUES('route', '2026-09-26', 2);
      COMMIT;
    `);
    // Committed rows are visible to another connection, but not written to the main file.
    const originalState = readState(store.db);
    assert.deepEqual(readState(reader), originalState);
    assert.deepEqual(readFileSync(store.path), originalMain);
    const originalWal = readFileSync(`${store.path}-wal`);
    reader.prepare("VACUUM INTO ?").run(backup);
    const originalBackup = readFileSync(backup);
    reader.exec("PRAGMA busy_timeout = 0");

    let snapshotAttempts = 0;
    const prepare = DatabaseSync.prototype.prepare;
    t.mock.method(DatabaseSync.prototype, "prepare", function (sql) {
      const statement = prepare.call(this, sql);
      if (sql === "VACUUM INTO ?") {
        const run = statement.run.bind(statement);
        t.mock.method(statement, "run", (snapshot) => {
          snapshotAttempts++;
          assert.notEqual(this, store.db, "snapshot uses a separate connection");
          assert.throws(() => reader.exec("BEGIN IMMEDIATE"), /database is locked/);
          assert.deepEqual(readState(store.db), originalState, "no schema writes before snapshot");
          // Force a real SQLite VACUUM error, leaving a file for migration cleanup.
          writeFileSync(snapshot, originalBackup);
          return run(snapshot);
        });
      }
      return statement;
    });
    assert.throws(() => store.migrate(), /output file already exists/);
    assert.equal(snapshotAttempts, 1, "must fail during snapshot, not BEGIN IMMEDIATE");
    assert.deepEqual(readState(store.db), originalState);
    assert.deepEqual(readState(reader), originalState);
    assert.deepEqual(readFileSync(store.path), originalMain);
    assert.deepEqual(readFileSync(`${store.path}-wal`), originalWal);
    assert.deepEqual(readFileSync(backup), originalBackup);
    assert.equal(readdirSync(dir).some((name) => name.includes(".tmp-")), false);
    reader.exec("BEGIN IMMEDIATE; ROLLBACK;"); // Failure released the writer lock.

    t.mock.restoreAll();
    assert.deepEqual(store.migrate(), { backedUpTo: backup });
    assert.equal(store.userVersion(), SCHEMA_VERSION);
    assert.deepEqual(readState(store.db).rows, originalState.rows);
    assert.equal(store.db.prepare("SELECT count(*) AS n FROM worker_claims").get().n, 0);
    assert.equal(store.db.prepare("PRAGMA integrity_check").get().integrity_check, "ok");
    const snapshot = new DatabaseSync(backup, { readOnly: true });
    try {
      assert.deepEqual(readState(snapshot), originalState);
      assert.equal(snapshot.prepare("PRAGMA integrity_check").get().integrity_check, "ok");
    } finally {
      snapshot.close();
    }
    assert.deepEqual(store.migrate(), { backedUpTo: null });
    assert.equal(readdirSync(dir).some((name) => name.includes(".tmp-")), false);
  } finally {
    t.mock.restoreAll();
    reader.close();
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
