import type { DeliveryRoute } from "pi-hermes-gateway-protocol";
import { copyFileSync, existsSync, statSync, unlinkSync } from "node:fs";
import type { Server } from "node:net";
import type { Clock } from "./clock.js";
import { SystemClock } from "./clock.js";
import { openGateway, type CatchUpPolicy, type Gateway } from "./core.js";
import { createFakeAdapter, type FakeAdapter } from "./fake-adapter.js";
import { acquireProfileLock, type HeldLock } from "./lock.js";
import { listenIpc } from "./ipc.js";
import { assertSocketMode, ensureProfileDir, profilePaths, unlinkOwnedSocket } from "./profile.js";

export const DEFAULT_TICK_INTERVAL_MS = 60_000;

export type Daemon = {
  gateway: Gateway;
  adapter: FakeAdapter;
  stop(): void;
};

function replaceDbWithBackup(dbPath: string, backupPath: string): void {
  if (!existsSync(backupPath)) throw new Error("restore backup not found");
  copyFileSync(backupPath, dbPath);
  for (const extra of [`${dbPath}-wal`, `${dbPath}-shm`]) {
    if (existsSync(extra)) unlinkSync(extra);
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
    if (opts.restoreFromBackup) replaceDbWithBackup(paths.dbPath, opts.restoreFromBackup);
    if (opts.bindSocket !== false) unlinkOwnedSocket(paths.socketPath);
    const adapter = opts.adapter ?? createFakeAdapter();
    const clock = opts.clock ?? new SystemClock();
    const opened = openGateway({
      dbPath: paths.dbPath,
      clock,
      routes: opts.routes,
      adapter,
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
    const intervalMs = opts.tickIntervalMs ?? DEFAULT_TICK_INTERVAL_MS;
    if (intervalMs > DEFAULT_TICK_INTERVAL_MS || intervalMs < 1) {
      throw new Error("tick interval must be in (0, 60s]");
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
