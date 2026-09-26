import assert from "node:assert/strict";
import { test } from "node:test";
import gatewayCompanion from "../dist/extension.js";

test("gateway_status reports worker unavailable without starting a daemon", async () => {
  const original = process.env.PI_HERMES_GATEWAY_PROFILE;
  delete process.env.PI_HERMES_GATEWAY_PROFILE;
  const tools = new Map<string, { execute: (...args: unknown[]) => Promise<unknown> }>();
  gatewayCompanion({
    on() {},
    registerTool(tool) { tools.set(tool.name, tool); },
  });
  try {
    const result = await tools.get("gateway_status")!.execute();
    assert.match(JSON.stringify(result), /daemon-unavailable/);
  } finally {
    if (original === undefined) delete process.env.PI_HERMES_GATEWAY_PROFILE;
    else process.env.PI_HERMES_GATEWAY_PROFILE = original;
  }
});
