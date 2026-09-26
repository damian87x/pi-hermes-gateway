import { existsSync } from "node:fs";
import { createConnection } from "node:net";
import { join } from "node:path";
import { LIMITS, PROTOCOL_VERSION } from "pi-hermes-gateway-protocol";

export type CompanionError = {
  code: "daemon-unavailable";
  message: string;
};

export type CompanionResult =
  | { ok: true; available: true; body: unknown }
  | { ok: false; available: false; error: CompanionError };

const UNAVAILABLE: CompanionResult = {
  ok: false,
  available: false,
  error: { code: "daemon-unavailable", message: "gateway daemon is unavailable" },
};

export function socketPath(profileDir: string): string {
  return join(profileDir, "gateway.sock");
}

export function daemonAvailable(profileDir: string): boolean {
  return Boolean(profileDir) && existsSync(socketPath(profileDir));
}

function encodeFrame(obj: unknown): Uint8Array {
  const json = new TextEncoder().encode(JSON.stringify(obj));
  const buf = new Uint8Array(4 + json.length);
  const view = new DataView(buf.buffer);
  view.setUint32(0, json.length, false);
  buf.set(json, 4);
  return buf;
}

let reqSeq = 0;

function wire(method: string, body: unknown): unknown {
  reqSeq += 1;
  const nowMs = Date.now();
  return {
    protocolVersion: PROTOCOL_VERSION,
    requestId: `cmp-${reqSeq}-${nowMs}`,
    method,
    body,
    expiresAt: nowMs + 30_000,
  };
}

function rpc(profileDir: string, method: string, body: unknown): Promise<CompanionResult> {
  if (!daemonAvailable(profileDir)) return Promise.resolve(UNAVAILABLE);
  const path = socketPath(profileDir);
  return new Promise((resolve) => {
    let settled = false;
    const finish = (result: CompanionResult) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(result);
    };
    const timer = setTimeout(() => {
      sock.destroy();
      finish(UNAVAILABLE);
    }, 2000);
    const sock = createConnection(path, () => {
      sock.write(encodeFrame(wire(method, body)));
    });
    sock.once("error", () => {
      finish(UNAVAILABLE);
    });
    let acc = new Uint8Array(0);
    sock.on("data", (chunk: unknown) => {
      const more = chunk instanceof Uint8Array ? chunk : new TextEncoder().encode(String(chunk));
      const merged = new Uint8Array(acc.length + more.length);
      merged.set(acc, 0);
      merged.set(more, acc.length);
      acc = merged;
      if (acc.length < 4) return;
      const len = new DataView(acc.buffer, acc.byteOffset, 4).getUint32(0, false);
      if (len > LIMITS.maxFrameBytes || acc.length < 4 + len) return;
      try {
        const parsed = JSON.parse(new TextDecoder().decode(acc.slice(4, 4 + len))) as { ok?: unknown; body?: unknown };
        sock.end();
        if (parsed && parsed.ok === true) {
          finish({ ok: true, available: true, body: parsed.body });
          return;
        }
        finish({
          ok: false,
          available: false,
          error: {
            code: "daemon-unavailable",
            message: typeof parsed?.body === "string" ? parsed.body : "gateway daemon rejected the request",
          },
        });
      } catch {
        sock.end();
        finish(UNAVAILABLE);
      }
    });
  });
}

export function companionStatus(profileDir: string): Promise<CompanionResult> {
  return rpc(profileDir, "job.list", {});
}

export function companionEnqueue(
  profileDir: string,
  body: { route: unknown; text: string; notAfter: number },
): Promise<CompanionResult> {
  return rpc(profileDir, "delivery.enqueue", body);
}

export function companionJobCreate(profileDir: string, body: unknown): Promise<CompanionResult> {
  return rpc(profileDir, "job.create", body);
}

export function companionJobList(profileDir: string): Promise<CompanionResult> {
  return rpc(profileDir, "job.list", {});
}
