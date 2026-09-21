declare class TextEncoder {
  encode(s: string): Uint8Array;
}

declare class AbortSignal {
  readonly aborted: boolean;
  static timeout(ms: number): AbortSignal;
}

declare function fetch(
  input: string,
  init?: {
    method?: string;
    headers?: Record<string, string>;
    body?: string;
    signal?: AbortSignal;
  },
): Promise<{
  status: number;
  ok: boolean;
  json(): Promise<unknown>;
  text(): Promise<string>;
}>;

declare module "node:sqlite" {
  export class DatabaseSync {
    constructor(path: string, options?: { readOnly?: boolean });
    close(): void;
    exec(sql: string): void;
    prepare(sql: string): StatementSync;
  }
  export class StatementSync {
    run(...params: unknown[]): { changes: number; lastInsertRowid: number | bigint };
    get(...params: unknown[]): undefined | Record<string, unknown>;
    all(...params: unknown[]): Record<string, unknown>[];
  }
}

declare module "node:path" {
  export function join(...parts: string[]): string;
}

declare module "node:http" {
  export type IncomingMessage = {
    method?: string;
    url?: string;
    headers: { host?: string | string[] };
  };
  export type ServerResponse = {
    statusCode: number;
    setHeader(name: string, value: string | number): void;
    end(data?: string | Uint8Array): void;
  };
  export type Server = {
    listen(port: number, host: string, cb?: () => void): Server;
    close(cb?: (err?: Error) => void): void;
    address(): string | { port: number; address: string } | null;
    on(ev: string, fn: (...args: unknown[]) => void): void;
    once(ev: string, fn: (...args: unknown[]) => void): void;
    off(ev: string, fn: (...args: unknown[]) => void): void;
  };
  export function createServer(
    listener: (req: IncomingMessage, res: ServerResponse) => void,
  ): Server;
}
