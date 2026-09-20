export const PROTOCOL_VERSION = 1;
export const ADAPTER_API_VERSION = 1;

export const LIMITS = {
  maxFrameBytes: 65536,
  maxPayloadBytes: 32768,
  maxTextChars: 4096,
  maxRequestIdChars: 128,
  maxRouteFieldChars: 256,
  maxMethodChars: 64,
  maxRequestTtlMs: 60_000,
  maxNotAfterMs: 24 * 60 * 60 * 1000,
} as const;

export const METHODS = [
  "job.create",
  "job.list",
  "job.pause",
  "job.resume",
  "job.cancel",
  "job.inspect",
  "delivery.enqueue",
  "delivery.inspect",
] as const;

export type Method = (typeof METHODS)[number];

export const KNOWN_CAPABILITIES = ["send.text"] as const;
export type Capability = (typeof KNOWN_CAPABILITIES)[number];

export const RECEIPT_LEVELS = ["accepted", "confirmed"] as const;
export type ReceiptLevel = (typeof RECEIPT_LEVELS)[number];

export const REQUEST_ID_PATTERN = /^[A-Za-z0-9._:-]{1,128}$/;
export const ROUTE_FIELD_PATTERN = /^[A-Za-z0-9._:@-]{1,256}$/;
export const LOCAL_TIME_PATTERN = /^([01]\d|2[0-3]):[0-5]\d$/;
