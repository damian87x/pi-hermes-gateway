import type { DeliveryRoute } from "pi-hermes-gateway-protocol";
import {
  closeSync,
  copyFileSync,
  existsSync,
  fsyncSync,
  openSync,
  readFileSync,
  renameSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { dirname } from "node:path";
import type { Server } from "node:net";
import { DatabaseSync } from "node:sqlite";
import type { Clock } from "./clock.js";
import { SystemClock } from "./clock.js";
import type { SendAdapter } from "./adapter.js";
import { DEFAULT_CONFIG, openGateway, TICK_GRACE_MARGIN_MS, type CatchUpPolicy, type Gateway } from "./core.js";
import { createFakeAdapter } from "./fake-adapter.js";
import { acquireProfileLock, type HeldLock } from "./lock.js";
import { listenIpc } from "./ipc.js";
import { assertSocketMode, ensureProfileDir, profilePaths, unlinkOwnedSocket } from "./profile.js";
import { SCHEMA_VERSION } from "./store.js";

export const DEFAULT_TICK_INTERVAL_MS = 60_000;

export type Daemon = {
  gateway: Gateway;
  adapter: SendAdapter;
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

function journalPath(dbPath: string): string {
  return `${dbPath}.restore-journal`;
}

function writeRestoreJournal(dbPath: string, aside: string): void {
  const journal = journalPath(dbPath);
  const tmp = `${journal}.tmp`;
  writeFileSync(tmp, aside);
  fsyncPath(tmp);
  renameSync(tmp, journal);
  try {
    fsyncPath(dirname(dbPath));
  } catch {
    /* directory fsync is best-effort */
  }
}

function checkpointLiveWal(dbPath: string): void {
  if (!existsSync(dbPath)) return;
  try {
    const db = new DatabaseSync(dbPath);
    try {
      db.exec("PRAGMA wal_checkpoint(TRUNCATE);");
    } finally {
      db.close();
    }
  } catch {
    /* torn live DB must not block a validated backup swap */
  }
}

function recoverInterruptedRestore(dbPath: string): void {
  const journal = journalPath(dbPath);
  if (!existsSync(journal)) return;
  if (existsSync(dbPath)) {
    unlinkIfExists(journal);
    return;
  }
  const aside = readFileSync(journal, "utf8").trim();
  if (!aside || !existsSync(aside)) {
    unlinkIfExists(journal);
    return;
  }
  renameSync(aside, dbPath);
  for (const extra of ["-wal", "-shm"]) {
    if (existsSync(`${aside}${extra}`) && !existsSync(`${dbPath}${extra}`)) {
      renameSync(`${aside}${extra}`, `${dbPath}${extra}`);
    }
  }
  unlinkIfExists(journal);
}

export type RestoreMaterialize = {
  clock: Clock;
  routes: DeliveryRoute[];
  catchUpPolicy?: CatchUpPolicy;
  backupTimeMs?: number;
  tickGraceMs?: number;
};

function finishRestorePending(gw: Gateway, clock: Clock): void {
  const backupTimeMs = Number(gw.store.getMeta("backup_time_ms") ?? 0);
  const recoveryTimeMs = Number(gw.store.getMeta("recovery_time_ms") ?? clock.nowMs());
  gw.restoreQuarantine(backupTimeMs, recoveryTimeMs);
  gw.store.setMeta("restore_pending", "0");
}

export function replaceDbWithBackup(dbPath: string, backupPath: string, materialize: RestoreMaterialize): void {
  validateBackupReadOnly(backupPath);
  const tempPath = `${dbPath}.restore-tmp`;
  unlinkIfExists(tempPath);
  for (const extra of sidecars(tempPath)) unlinkIfExists(extra);
  copyFileSync(backupPath, tempPath);
  const backupTimeMs = materialize.backupTimeMs ?? statSync(backupPath).mtimeMs;
  const recoveryTimeMs = materialize.clock.nowMs();
  const { gateway: tmpGw } = openGateway({
    dbPath: tempPath,
    clock: materialize.clock,
    routes: materialize.routes,
    adapter: createFakeAdapter(),
    ...(materialize.catchUpPolicy ? { catchUpPolicy: materialize.catchUpPolicy } : {}),
    ...(materialize.tickGraceMs !== undefined ? { tickGraceMs: materialize.tickGraceMs } : {}),
  });
  try {
    tmpGw.store.setMeta("restore_pending", "1");
    tmpGw.store.setMeta("backup_time_ms", String(backupTimeMs));
    tmpGw.store.setMeta("recovery_time_ms", String(recoveryTimeMs));
    tmpGw.restoreQuarantine(backupTimeMs, recoveryTimeMs);
    tmpGw.store.setMeta("restore_pending", "0");
  } finally {
    tmpGw.close();
  }
  for (const extra of sidecars(tempPath)) unlinkIfExists(extra);
  fsyncPath(tempPath);
  checkpointLiveWal(dbPath);
  if (existsSync(dbPath)) {
    let aside = `${dbPath}.pre-restore`;
    if (existsSync(aside)) aside = `${dbPath}.pre-restore-${Date.now()}`;
    writeRestoreJournal(dbPath, aside);
    renameSync(dbPath, aside);
    for (const extra of ["-wal", "-shm"]) {
      if (existsSync(`${dbPath}${extra}`)) renameSync(`${dbPath}${extra}`, `${aside}${extra}`);
    }
  }
  renameSync(tempPath, dbPath);
  unlinkIfExists(journalPath(dbPath));
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
  adapter?: SendAdapter;
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
    const adapter = opts.adapter ?? createFakeAdapter();
    for (const route of opts.routes) {
      if (route.adapterId !== adapter.manifest.adapterId) {
        throw new Error(`route adapterId ${route.adapterId} does not match adapter ${adapter.manifest.adapterId}`);
      }
    }
    const clock = opts.clock ?? new SystemClock();
    const tickGraceMs = Math.max(DEFAULT_CONFIG.tickGraceMs, intervalMs + TICK_GRACE_MARGIN_MS);
    if (!opts.restoreFromBackup) recoverInterruptedRestore(paths.dbPath);
    if (opts.restoreFromBackup) {
      replaceDbWithBackup(paths.dbPath, opts.restoreFromBackup, {
        clock,
        routes: opts.routes,
        tickGraceMs,
        ...(opts.catchUpPolicy ? { catchUpPolicy: opts.catchUpPolicy } : {}),
        ...(opts.backupTimeMs !== undefined ? { backupTimeMs: opts.backupTimeMs } : {}),
      });
    }
    if (opts.bindSocket !== false) unlinkOwnedSocket(paths.socketPath);
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
    if (gw.store.getMeta("restore_pending") === "1") {
      if (opts.resumeDispatch) throw new Error("restore materialization pending");
      finishRestorePending(gw, clock);
    } else if (opts.restoreFromBackup && gw.store.getMeta("backup_time_ms") == null) {
      const backupTimeMs = opts.backupTimeMs ?? statSync(opts.restoreFromBackup).mtimeMs;
      gw.restoreQuarantine(backupTimeMs, clock.nowMs());
    }
    if (opts.resumeDispatch) {
      if (gw.store.getMeta("restore_pending") === "1") throw new Error("restore materialization pending");
      gw.resumeDispatch();
    }
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
