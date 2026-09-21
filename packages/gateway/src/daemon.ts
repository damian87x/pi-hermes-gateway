import type { DeliveryRoute } from "pi-hermes-gateway-protocol";
import {
  closeSync,
  copyFileSync,
  existsSync,
  fsyncSync,
  openSync,
  renameSync,
  statSync,
  unlinkSync,
} from "node:fs";
import { dirname } from "node:path";
import type { Server } from "node:net";
import { DatabaseSync } from "node:sqlite";
import type { Clock } from "./clock.js";
import { SystemClock } from "./clock.js";
import { DEFAULT_CONFIG, openGateway, TICK_GRACE_MARGIN_MS, type CatchUpPolicy, type Gateway } from "./core.js";
import { createFakeAdapter, type FakeAdapter } from "./fake-adapter.js";
import { acquireProfileLock, type HeldLock } from "./lock.js";
import { listenIpc } from "./ipc.js";
import { assertSocketMode, ensureProfileDir, profilePaths, unlinkOwnedSocket } from "./profile.js";
import { SCHEMA_VERSION, Store } from "./store.js";

export const DEFAULT_TICK_INTERVAL_MS = 60_000;

export type Daemon = {
  gateway: Gateway;
  adapter: FakeAdapter;
  stop(): void;
};

function unlinkIfExists(path: string): void {
  if (existsSync(path)) unlinkSync(path);
}

function sidecars(path: string): string[] {
  return [`${path}-wal`, `${path}-shm`];
}

function fsyncPath(path: string): void {
  const fd = openSync(path, "r");
  fsyncSync(fd);
  closeSync(fd);
}

function validateBackupReadOnly(backupPath: string): void {
  if (!existsSync(backupPath)) throw new Error("restore backup not found");
  const db = new DatabaseSync(backupPath, { readOnly: true });
  try {
    let version = 0;
    try {
      const row = db.prepare("PRAGMA user_version").get();
      version = typeof row?.user_version === "number" ? row.user_version : 0;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      throw new Error(message.includes("not a database") ? "file is not a database" : message);
    }
    if (version > SCHEMA_VERSION) {
      throw new Error(`schema version ${version} is newer than binary ${SCHEMA_VERSION}`);
    }
    const ic = db.prepare("PRAGMA quick_check").get();
    if (!ic || Object.values(ic)[0] !== "ok") {
      throw new Error("restore backup failed integrity check");
    }
  } finally {
    db.close();
  }
}

function recoverInterruptedRestore(dbPath: string): void {
  const aside = `${dbPath}.pre-restore`;
  if (existsSync(dbPath) || !existsSync(aside)) return;
  renameSync(aside, dbPath);
  for (const extra of ["-wal", "-shm"]) {
    if (existsSync(`${aside}${extra}`) && !existsSync(`${dbPath}${extra}`)) {
      renameSync(`${aside}${extra}`, `${dbPath}${extra}`);
    }
  }
}

function replaceDbWithBackup(dbPath: string, backupPath: string): void {
  validateBackupReadOnly(backupPath);
  const tempPath = `${dbPath}.restore-tmp`;
  unlinkIfExists(tempPath);
  for (const extra of sidecars(tempPath)) unlinkIfExists(extra);
  copyFileSync(backupPath, tempPath);
  const tmp = new Store(tempPath);
  try {
    tmp.migrate();
    tmp.setMeta("quarantine", "1");
    tmp.setMeta("dispatch_enabled", "0");
    tmp.db
      .prepare("UPDATE deliveries SET status = 'commit-unknown' WHERE status IN ('queued', 'dispatching')")
      .run();
  } finally {
    tmp.close();
  }
  for (const extra of sidecars(tempPath)) unlinkIfExists(extra);
  fsyncPath(tempPath);
  if (existsSync(dbPath)) {
    let aside = `${dbPath}.pre-restore`;
    if (existsSync(aside)) aside = `${dbPath}.pre-restore-${Date.now()}`;
    renameSync(dbPath, aside);
    for (const extra of ["-wal", "-shm"]) {
      if (existsSync(`${dbPath}${extra}`)) renameSync(`${dbPath}${extra}`, `${aside}${extra}`);
    }
  }
  renameSync(tempPath, dbPath);
  try {
    fsyncPath(dirname(dbPath));
  } catch {
    /* directory fsync is best-effort */
  }
}

export function startDaemon(opts: {
  profileDir: string;
  routes: DeliveryRoute[];
  clock?: Clock;
  catchUpPolicy?: CatchUpPolicy;
  bindSocket?: boolean;
  adapter?: FakeAdapter;
  restoreFromBackup?: string;
  backupTimeMs?: number;
  resumeDispatch?: boolean;
  tickIntervalMs?: number;
}): Daemon {
  ensureProfileDir(opts.profileDir);
  const paths = profilePaths(opts.profileDir);
  const lock = acquireProfileLock(paths.lockPath);
  let gateway: Gateway | undefined;
  try {
    if (opts.restoreFromBackup && opts.resumeDispatch) {
      throw new Error("restore and resume-dispatch cannot be combined");
    }
    const intervalMs = opts.tickIntervalMs ?? DEFAULT_TICK_INTERVAL_MS;
    if (intervalMs > DEFAULT_TICK_INTERVAL_MS || intervalMs < 1) {
      throw new Error("tick interval must be in (0, 60s]");
    }
    if (!opts.restoreFromBackup) recoverInterruptedRestore(paths.dbPath);
    if (opts.restoreFromBackup) replaceDbWithBackup(paths.dbPath, opts.restoreFromBackup);
    if (opts.bindSocket !== false) unlinkOwnedSocket(paths.socketPath);
    const adapter = opts.adapter ?? createFakeAdapter();
    const clock = opts.clock ?? new SystemClock();
    const tickGraceMs = Math.max(DEFAULT_CONFIG.tickGraceMs, intervalMs + TICK_GRACE_MARGIN_MS);
    const opened = openGateway({
      dbPath: paths.dbPath,
      clock,
      routes: opts.routes,
      adapter,
      tickGraceMs,
      ...(opts.catchUpPolicy ? { catchUpPolicy: opts.catchUpPolicy } : {}),
    });
    const gw = opened.gateway;
    gateway = gw;
    if (opts.restoreFromBackup) {
      const backupTimeMs = opts.backupTimeMs ?? statSync(opts.restoreFromBackup).mtimeMs;
      gw.restoreQuarantine(backupTimeMs, clock.nowMs());
    }
    if (opts.resumeDispatch) gw.resumeDispatch();
    let server: Server | undefined;
    if (opts.bindSocket !== false) {
      server = listenIpc(paths.socketPath, gw);
      assertSocketMode(paths.socketPath);
    }
    gw.tick();
    const timer = setInterval(() => {
      gw.tick();
    }, intervalMs);
    return {
      gateway: gw,
      adapter,
      stop() {
        clearInterval(timer);
        server?.close();
        gw.close();
        lock.release();
      },
    };
  } catch (err) {
    try {
      gateway?.close();
    } catch {
      /* ignore */
    }
    lock.release();
    throw err;
  }
}

export type { HeldLock };
