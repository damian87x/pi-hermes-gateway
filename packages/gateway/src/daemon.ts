import type { DeliveryRoute } from "pi-hermes-gateway-protocol";
import type { Server } from "node:net";
import type { Clock } from "./clock.js";
import { TestClock } from "./clock.js";
import { openGateway, type CatchUpPolicy, type Gateway } from "./core.js";
import { createFakeAdapter, type FakeAdapter } from "./fake-adapter.js";
import { acquireProfileLock, type HeldLock } from "./lock.js";
import { listenIpc } from "./ipc.js";
import { assertSocketMode, ensureProfileDir, profilePaths, unlinkOwnedSocket } from "./profile.js";

export type Daemon = {
  gateway: Gateway;
  adapter: FakeAdapter;
  stop(): void;
};

export function startDaemon(opts: {
  profileDir: string;
  routes: DeliveryRoute[];
  clock?: Clock;
  catchUpPolicy?: CatchUpPolicy;
  bindSocket?: boolean;
  adapter?: FakeAdapter;
}): Daemon {
  ensureProfileDir(opts.profileDir);
  const paths = profilePaths(opts.profileDir);
  const lock = acquireProfileLock(paths.lockPath);
  if (opts.bindSocket !== false) unlinkOwnedSocket(paths.socketPath);
  const adapter = opts.adapter ?? createFakeAdapter();
  const clock = opts.clock ?? new TestClock(Date.now());
  const { gateway } = openGateway({
    dbPath: paths.dbPath,
    clock,
    routes: opts.routes,
    adapter,
    ...(opts.catchUpPolicy ? { catchUpPolicy: opts.catchUpPolicy } : {}),
  });
  let server: Server | undefined;
  if (opts.bindSocket !== false) {
    server = listenIpc(paths.socketPath, gateway);
    assertSocketMode(paths.socketPath);
  }
  gateway.tick();
  return {
    gateway,
    adapter,
    stop() {
      server?.close();
      gateway.close();
      lock.release();
    },
  };
}

export type { HeldLock };
