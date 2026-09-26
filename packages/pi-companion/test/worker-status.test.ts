import assert from "node:assert/strict";
import { test } from "node:test";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import gatewayCompanion from "../dist/extension.js";

test("gateway_status reports worker unavailable without starting a daemon", async () => {
  const original = process.env.PI_HERMES_GATEWAY_PROFILE;
  const profileDir = mkdtempSync(join(tmpdir(), "gateway-worker-status-"));
  process.env.PI_HERMES_GATEWAY_PROFILE = profileDir;
  const tools = new Map<string, { execute: (...args: unknown[]) => Promise<unknown> }>();
  gatewayCompanion({
    on() {},
    registerTool(tool) { tools.set(tool.name, tool); },
  });
  try {
    const result = await tools.get("gateway_status")!.execute() as {
      content: Array<{ type: string; text: string }>;
    };
    assert.deepEqual(JSON.parse(result.content[0].text), {
      ok: false,
      available: false,
      error: { code: "daemon-unavailable", message: "gateway daemon is unavailable" },
    });
    assert.equal(existsSync(join(profileDir, "gateway.sock")), false);
  } finally {
    if (original === undefined) delete process.env.PI_HERMES_GATEWAY_PROFILE;
    else process.env.PI_HERMES_GATEWAY_PROFILE = original;
    rmSync(profileDir, { recursive: true, force: true });
  }
});

test("gateway_status distinguishes a daemon rejection from unavailability", async () => {
  const original = process.env.PI_HERMES_GATEWAY_PROFILE;
  const profileDir = mkdtempSync(join(tmpdir(), "gateway-worker-rejection-"));
  process.env.PI_HERMES_GATEWAY_PROFILE = profileDir;
  const socketPath = join(profileDir, "gateway.sock");
  const server = createServer((socket) => {
    socket.on("data", () => {
      const payload = new TextEncoder().encode(JSON.stringify({ ok: false, body: "rejected" }));
      const frame = new Uint8Array(4 + payload.length);
      new DataView(frame.buffer).setUint32(0, payload.length, false);
      frame.set(payload, 4);
      socket.end(frame);
    });
  });
  await new Promise<void>((resolve) => server.listen(socketPath, resolve));
  const tools = new Map<string, { execute: (...args: unknown[]) => Promise<unknown> }>();
  gatewayCompanion({ on() {}, registerTool(tool) { tools.set(tool.name, tool); } });
  try {
    const result = await tools.get("gateway_status")!.execute() as {
      content: Array<{ type: string; text: string }>;
    };
    assert.deepEqual(JSON.parse(result.content[0].text), {
      ok: false,
      available: true,
      error: { code: "daemon-rejected", message: "rejected" },
    });
  } finally {
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    if (original === undefined) delete process.env.PI_HERMES_GATEWAY_PROFILE;
    else process.env.PI_HERMES_GATEWAY_PROFILE = original;
    rmSync(profileDir, { recursive: true, force: true });
  }
});
