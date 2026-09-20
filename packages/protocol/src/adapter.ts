import { fail, ok, type ProtocolResult } from "./errors.js";
import {
  ADAPTER_API_VERSION,
  KNOWN_CAPABILITIES,
  LIMITS,
  RECEIPT_LEVELS,
  type Capability,
  type ReceiptLevel,
} from "./limits.js";
import { isPlainObject, requireInteger, requireToken } from "./check.js";

export type AdapterManifest = {
  adapterId: string;
  adapterApiVersion: number;
  capabilities: Capability[];
  configSchemaVersion: number;
  maxTextLength: number;
  receiptLevels: ReceiptLevel[];
};

const knownCapabilitySet = new Set<string>(KNOWN_CAPABILITIES);
const receiptLevelSet = new Set<string>(RECEIPT_LEVELS);

export function isAdapterApiCompatible(adapterApiVersion: number, hostApiVersion: number): boolean {
  return (
    Number.isInteger(adapterApiVersion) &&
    Number.isInteger(hostApiVersion) &&
    adapterApiVersion === hostApiVersion
  );
}

export function validateAdapterManifest(input: unknown): ProtocolResult<AdapterManifest> {
  if (!isPlainObject(input)) return fail("malformed", "adapter manifest must be an object");

  const adapterId = requireToken(input.adapterId, "adapterId", "invalid_adapter_id");
  if (!adapterId.ok) return adapterId;

  const apiVersion = requireInteger(
    input.adapterApiVersion,
    "unsupported_adapter_api_version",
    "adapterApiVersion must be an integer",
  );
  if (!apiVersion.ok) return apiVersion;
  if (!isAdapterApiCompatible(apiVersion.value, ADAPTER_API_VERSION)) {
    return fail(
      "unsupported_adapter_api_version",
      `adapterApiVersion ${apiVersion.value} is incompatible with host ${ADAPTER_API_VERSION}`,
    );
  }

  if (!Array.isArray(input.capabilities) || input.capabilities.length === 0) {
    return fail("invalid_capability", "capabilities must be a non-empty array of known strings");
  }
  const seenCaps = new Set<string>();
  const capabilities: Capability[] = [];
  for (const cap of input.capabilities) {
    if (typeof cap !== "string" || !knownCapabilitySet.has(cap)) {
      return fail("invalid_capability", `unknown capability ${String(cap)}`);
    }
    if (seenCaps.has(cap)) return fail("duplicate_capability", `duplicate capability ${cap}`);
    seenCaps.add(cap);
    capabilities.push(cap as Capability);
  }

  const configSchemaVersion = requireInteger(
    input.configSchemaVersion,
    "invalid_manifest",
    "configSchemaVersion must be a positive integer",
  );
  if (!configSchemaVersion.ok) return configSchemaVersion;
  if (configSchemaVersion.value < 1) {
    return fail("invalid_manifest", "configSchemaVersion must be a positive integer");
  }

  const maxTextLength = requireInteger(
    input.maxTextLength,
    "invalid_manifest",
    "maxTextLength must be an integer",
  );
  if (!maxTextLength.ok) return maxTextLength;
  if (maxTextLength.value < 1 || maxTextLength.value > LIMITS.maxTextChars) {
    return fail(
      "invalid_manifest",
      `maxTextLength must be between 1 and ${LIMITS.maxTextChars} UTF-16 code units`,
    );
  }

  if (!Array.isArray(input.receiptLevels) || input.receiptLevels.length === 0) {
    return fail("invalid_manifest", "receiptLevels must be a non-empty array");
  }
  const seenLevels = new Set<string>();
  const receiptLevels: ReceiptLevel[] = [];
  for (const level of input.receiptLevels) {
    if (typeof level !== "string" || !receiptLevelSet.has(level)) {
      return fail("invalid_manifest", `unknown receipt level ${String(level)}`);
    }
    if (seenLevels.has(level)) return fail("invalid_manifest", `duplicate receipt level ${level}`);
    seenLevels.add(level);
    receiptLevels.push(level as ReceiptLevel);
  }
  if (!seenLevels.has("accepted")) {
    return fail("invalid_manifest", "receiptLevels must include accepted");
  }

  return ok({
    adapterId: adapterId.value,
    adapterApiVersion: apiVersion.value,
    capabilities,
    configSchemaVersion: configSchemaVersion.value,
    maxTextLength: maxTextLength.value,
    receiptLevels,
  });
}
