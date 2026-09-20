export type ProtocolError = {
  code: string;
  message: string;
};

export type ProtocolResult<T> =
  | { ok: true; value: T }
  | { ok: false; error: ProtocolError };

export function ok<T>(value: T): ProtocolResult<T> {
  return { ok: true, value };
}

export function fail<T>(code: string, message: string): ProtocolResult<T> {
  return { ok: false, error: { code, message } };
}
