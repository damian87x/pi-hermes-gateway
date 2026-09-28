export const NOW = Date.UTC(2026, 8, 20, 17, 0, 0);

export function utf8Bytes(value: unknown): number {
  return new TextEncoder().encode(typeof value === "string" ? value : JSON.stringify(value)).byteLength;
}

export function frameFor(request: unknown): number {
  return utf8Bytes(request);
}
