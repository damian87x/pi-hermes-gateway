import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PROTOCOL_VERSION, type DeliveryRoute } from "pi-hermes-gateway-protocol";
import { openGateway, TestClock, type CatchUpPolicy, type Gateway } from "../dist/index.js";
import { createFakeAdapter } from "../dist/fake-adapter.js";

export const ROUTE: DeliveryRoute = {
  profileId: "profile-a",
  adapterId: "fake",
  accountId: "acct-1",
  chatId: "chat-1",
};

export function tmpDir(): string {
  return mkdtempSync(join(tmpdir(), "gw-s1-"));
}

export function cleanup(dir: string): void {
  rmSync(dir, { recursive: true, force: true });
}

export function openTestGw(opts?: {
  clock?: TestClock;
  catchUpPolicy?: CatchUpPolicy;
  dailyCapPerRoute?: number;
  tokenBucketCapacity?: number;
  tokenBucketRefillPerMs?: number;
  notAfterBoundMs?: number;
  routes?: DeliveryRoute[];
  dir?: string;
}): { gw: Gateway; clock: TestClock; dir: string; adapter: ReturnType<typeof createFakeAdapter> } {
  const dir = opts?.dir ?? tmpDir();
  const clock = opts?.clock ?? new TestClock(Date.UTC(2026, 0, 1, 10, 0, 0));
  const adapter = createFakeAdapter();
  const { gateway } = openGateway({
    dbPath: join(dir, "gateway.sqlite"),
    clock,
    routes: opts?.routes ?? [ROUTE],
    catchUpPolicy: opts?.catchUpPolicy,
    dailyCapPerRoute: opts?.dailyCapPerRoute,
    tokenBucketCapacity: opts?.tokenBucketCapacity,
    tokenBucketRefillPerMs: opts?.tokenBucketRefillPerMs,
    notAfterBoundMs: opts?.notAfterBoundMs,
    adapter,
  });
  return { gw: gateway, clock, dir, adapter };
}

let reqSeq = 0;
export function wire(method: string, body: unknown, nowMs: number, requestId?: string): unknown {
  reqSeq += 1;
  return {
    protocolVersion: PROTOCOL_VERSION,
    requestId: requestId ?? `req-${reqSeq}-${nowMs}`,
    method,
    body,
    expiresAt: nowMs + 30_000,
  };
}

export function frameLen(value: unknown): number {
  return new TextEncoder().encode(JSON.stringify(value)).byteLength;
}

export function handle(gw: Gateway, method: string, body: unknown, nowMs: number, requestId?: string) {
  const req = wire(method, body, nowMs, requestId);
  return gw.handleRequest(req, frameLen(req));
}

export type Deferred<T> = { promise: Promise<T>; resolve(value: T): void; reject(err: unknown): void };

export function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  let reject!: (err: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

// Lets pending adapter receipts and the gateway's outbox continuation run to completion.
export async function flushAsync(rounds = 5): Promise<void> {
  for (let i = 0; i < rounds; i += 1) await new Promise((resolve) => setImmediate(resolve));
}

// Records unhandled rejections raised while `fn` runs and its async work settles.
export async function collectUnhandledRejections(fn: () => Promise<void>): Promise<unknown[]> {
  const seen: unknown[] = [];
  const onRejection = (reason: unknown) => {
    seen.push(reason);
  };
  process.on("unhandledRejection", onRejection);
  try {
    await fn();
    await flushAsync();
  } finally {
    process.off("unhandledRejection", onRejection);
  }
  return seen;
}
