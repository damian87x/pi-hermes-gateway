import assert from "node:assert/strict";
import { test } from "node:test";
import {
  ADAPTER_API_VERSION,
  LIMITS,
  isAdapterApiCompatible,
  validateAdapterManifest,
} from "../dist/index.js";

function validManifest(overrides: Record<string, unknown> = {}) {
  return {
    adapterId: "fake-file",
    adapterApiVersion: ADAPTER_API_VERSION,
    capabilities: ["send.text"],
    configSchemaVersion: 1,
    maxTextLength: 4096,
    receiptLevels: ["accepted"],
    ...overrides,
  };
}

test("accepts a declared M1 text adapter manifest", () => {
  const result = validateAdapterManifest(validManifest());
  assert.equal(result.ok, true);
  if (result.ok) {
    assert.deepEqual(result.value.capabilities, ["send.text"]);
    assert.deepEqual(result.value.receiptLevels, ["accepted"]);
  }
});

test("rejects unsupported adapter API versions", () => {
  const result = validateAdapterManifest(validManifest({ adapterApiVersion: ADAPTER_API_VERSION + 1 }));
  assert.equal(result.ok, false);
  if (!result.ok) assert.equal(result.error.code, "unsupported_adapter_api_version");
  assert.equal(isAdapterApiCompatible(ADAPTER_API_VERSION + 1, ADAPTER_API_VERSION), false);
  assert.equal(isAdapterApiCompatible(ADAPTER_API_VERSION, ADAPTER_API_VERSION), true);
});

test("rejects duplicate capability definitions", () => {
  const result = validateAdapterManifest(validManifest({ capabilities: ["send.text", "send.text"] }));
  assert.equal(result.ok, false);
  if (!result.ok) assert.equal(result.error.code, "duplicate_capability");
});

test("rejects unknown capability definitions", () => {
  const result = validateAdapterManifest(validManifest({ capabilities: ["send.text", "launch.missiles"] }));
  assert.equal(result.ok, false);
  if (!result.ok) assert.equal(result.error.code, "invalid_capability");
});

test("rejects empty capability lists", () => {
  const result = validateAdapterManifest(validManifest({ capabilities: [] }));
  assert.equal(result.ok, false);
  if (!result.ok) assert.equal(result.error.code, "invalid_capability");
});

test("rejects duplicate receipt levels", () => {
  const result = validateAdapterManifest(validManifest({ receiptLevels: ["accepted", "accepted"] }));
  assert.equal(result.ok, false);
  if (!result.ok) assert.equal(result.error.code, "invalid_manifest");
});

test("requires accepted receipt level", () => {
  const result = validateAdapterManifest(validManifest({ receiptLevels: ["confirmed"] }));
  assert.equal(result.ok, false);
  if (!result.ok) assert.equal(result.error.code, "invalid_manifest");
});

test("rejects maxTextLength outside protocol bounds", () => {
  const tooBig = validateAdapterManifest(validManifest({ maxTextLength: LIMITS.maxTextChars + 1 }));
  assert.equal(tooBig.ok, false);
  if (!tooBig.ok) assert.equal(tooBig.error.code, "invalid_manifest");
  const tooSmall = validateAdapterManifest(validManifest({ maxTextLength: 0 }));
  assert.equal(tooSmall.ok, false);
});

test("rejects invalid adapterId", () => {
  const result = validateAdapterManifest(validManifest({ adapterId: "" }));
  assert.equal(result.ok, false);
  if (!result.ok) assert.equal(result.error.code, "invalid_adapter_id");
});
