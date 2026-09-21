import { createServer, createConnection, type Server, type Socket } from "node:net";
import { chmodSync, existsSync } from "node:fs";
import { LIMITS } from "pi-hermes-gateway-protocol";
import type { Gateway } from "./core.js";

function encodeFrame(obj: unknown): Uint8Array {
  const json = new TextEncoder().encode(JSON.stringify(obj));
  const buf = new Uint8Array(4 + json.length);
  const view = new DataView(buf.buffer);
  view.setUint32(0, json.length, false);
  buf.set(json, 4);
  return buf;
}

function attachReader(socket: Socket, onFrame: (payload: Uint8Array) => void): void {
  let acc = new Uint8Array(0);
  socket.on("data", (chunk: unknown) => {
    const more = chunk instanceof Uint8Array ? chunk : new TextEncoder().encode(String(chunk));
    const merged = new Uint8Array(acc.length + more.length);
    merged.set(acc, 0);
    merged.set(more, acc.length);
    acc = merged;
    while (acc.length >= 4) {
      const len = new DataView(acc.buffer, acc.byteOffset, 4).getUint32(0, false);
      if (len > LIMITS.maxFrameBytes) {
        socket.end();
        return;
      }
      if (acc.length < 4 + len) return;
      const payload = acc.slice(4, 4 + len);
      acc = acc.slice(4 + len);
      onFrame(payload);
    }
  });
}

export function listenIpc(socketPath: string, gateway: Gateway): Server {
  const server = createServer((sock) => {
    sock.on("error", () => {
      sock.destroy();
    });
    attachReader(sock, (payload) => {
      let parsed: unknown;
      try {
        parsed = JSON.parse(new TextDecoder().decode(payload));
      } catch {
        sock.write(encodeFrame({ ok: false, error: { code: "malformed", message: "request is not JSON" } }));
        return;
      }
      try {
        const response = gateway.handleRequest(parsed, payload.byteLength);
        sock.write(encodeFrame(response));
      } catch {
        try {
          sock.write(encodeFrame({ ok: false, error: { code: "internal", message: "request handler failed" } }));
        } catch {
          sock.end();
        }
      }
    });
  });
  server.on("error", () => {
    /* disconnects and accept faults must not exit the daemon */
  });
  server.listen(socketPath);
  const start = Date.now();
  while (!existsSync(socketPath) && Date.now() - start < 2000) {
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 10);
  }
  chmodSync(socketPath, 0o600);
  return server;
}

export function sendIpc(socketPath: string, request: unknown): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const sock = createConnection(socketPath, () => {
      sock.write(encodeFrame(request));
    });
    sock.once("error", reject);
    attachReader(sock, (payload) => {
      try {
        resolve(JSON.parse(new TextDecoder().decode(payload)));
      } catch (err) {
        reject(err);
      } finally {
        sock.end();
      }
    });
  });
}
