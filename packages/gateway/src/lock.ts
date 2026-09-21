import { chmodSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";

export type HeldLock = {
  release(): void;
};

function lockedError(): Error {
  const err = new Error("profile lock held");
  (err as Error & { code: string }).code = "profile_locked";
  return err;
}

/** Node-only exclusive lock via SQLite. Process death releases the lock. */
export function acquireProfileLock(lockPath: string): HeldLock {
  let db: DatabaseSync;
  try {
    db = new DatabaseSync(lockPath);
  } catch {
    throw lockedError();
  }
  try {
    db.exec("PRAGMA busy_timeout = 0;");
    db.exec("PRAGMA journal_mode = DELETE;");
    db.exec("PRAGMA locking_mode = EXCLUSIVE;");
    db.exec("BEGIN EXCLUSIVE;");
    db.exec("CREATE TABLE IF NOT EXISTS lock_owner (k INTEGER PRIMARY KEY)");
    db.prepare("INSERT OR REPLACE INTO lock_owner(k) VALUES (1)").run();
  } catch {
    try {
      db.close();
    } catch {
      /* ignore */
    }
    throw lockedError();
  }
  try {
    chmodSync(lockPath, 0o600);
  } catch {
    /* lock is held; mode is best-effort */
  }
  return {
    release() {
      try {
        db.exec("COMMIT");
      } catch {
        /* ignore */
      }
      try {
        db.close();
      } catch {
        /* ignore */
      }
    },
  };
}
