declare class TextEncoder {
  encode(s: string): Uint8Array;
}
declare class TextDecoder {
  decode(s: Uint8Array | string): string;
}

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

declare module "node:fs" {
  export function mkdirSync(path: string, opts?: { recursive?: boolean; mode?: number }): string | undefined;
  export function writeFileSync(
    path: string,
    data: string | Uint8Array,
    opts?: { flag?: string; mode?: number } | string,
  ): void;
  export function readFileSync(path: string, encoding: "utf8"): string;
  export function copyFileSync(src: string, dest: string): void;
  export function chmodSync(path: string, mode: number): void;
  export function statSync(path: string): {
    uid: number;
    gid: number;
    mode: number;
    mtimeMs: number;
    isDirectory(): boolean;
    isSocket(): boolean;
    isFile(): boolean;
  };
  export function existsSync(path: string): boolean;
  export function realpathSync(path: string): string;
  export function unlinkSync(path: string): void;
  export function rmSync(path: string, opts?: { recursive?: boolean; force?: boolean }): void;
  export function mkdtempSync(prefix: string): string;
  export function renameSync(oldPath: string, newPath: string): void;
  export function openSync(path: string, flags: string): number;
  export function fsyncSync(fd: number): void;
  export function closeSync(fd: number): void;
}

declare module "node:path" {
  export const sep: string;
  export function join(...parts: string[]): string;
  export function dirname(path: string): string;
  export function basename(path: string): string;
  export function resolve(...parts: string[]): string;
  export function isAbsolute(path: string): boolean;
}

declare module "node:os" {
  export function tmpdir(): string;
  export function homedir(): string;
  export function userInfo(): { username: string; uid: number; gid: number; homedir: string };
}

declare module "node:crypto" {
  export function randomBytes(size: number): { toString(enc: "hex"): string };
}

declare module "node:child_process" {
  export type ChildProcess = {
    stdin: { write(s: string): void; end(): void } | null;
    stdout: { on(ev: string, fn: (c: Uint8Array | string) => void): void } | null;
    stderr: { on(ev: string, fn: (c: Uint8Array | string) => void): void } | null;
    on(ev: "exit" | "error" | "spawn", fn: (...args: unknown[]) => void): void;
    once(ev: "exit" | "error", fn: (...args: unknown[]) => void): void;
    kill(sig?: string): boolean;
    pid?: number;
    exitCode: number | null;
  };
  export function spawn(
    cmd: string,
    args: string[],
    opts?: { stdio?: unknown; cwd?: string; env?: Record<string, string | undefined> },
  ): ChildProcess;
  export function spawnSync(
    cmd: string,
    args: string[],
    opts?: { encoding?: "utf8"; cwd?: string; timeout?: number; env?: Record<string, string | undefined> },
  ): { status: number | null; stdout: string; stderr: string };
  export function execFileSync(
    cmd: string,
    args: string[],
    opts?: {
      encoding?: "utf8";
      cwd?: string;
      timeout?: number;
      env?: Record<string, string | undefined>;
      stdio?: unknown;
    },
  ): string;
}

declare module "node:net" {
  export type Socket = {
    on(ev: string, fn: (...args: unknown[]) => void): void;
    once(ev: string, fn: (...args: unknown[]) => void): void;
    write(data: string | Uint8Array, cb?: (err?: Error | null) => void): boolean;
    end(): void;
    destroy(): void;
  };
  export type Server = {
    listen(path: string, cb?: () => void): void;
    close(cb?: () => void): void;
    on(ev: string, fn: (...args: unknown[]) => void): void;
    address(): string | { port: number } | null;
  };
  export function createServer(handler?: (socket: Socket) => void): Server;
  export function createConnection(path: string, cb?: () => void): Socket;
}

declare module "node:process" {
  const process: {
    getuid(): number;
    getgid(): number;
    exit(code: number): never;
    argv: string[];
    execPath: string;
    env: Record<string, string | undefined>;
    versions: { node: string; sqlite?: string };
    cwd(): string;
    on(ev: string, fn: (...args: unknown[]) => void): void;
    stdout: { write(s: string): void };
    stderr: { write(s: string): void };
    kill(pid: number, signal?: number | string): boolean;
  };
  export default process;
}

declare module "node:url" {
  export function fileURLToPath(url: string | URL): string;
  export function pathToFileURL(path: string): URL;
}

interface ImportMeta {
  url: string;
}

declare module "node:assert/strict" {
  const assert: {
    equal(a: unknown, b: unknown, msg?: string): void;
    deepEqual(a: unknown, b: unknown, msg?: string): void;
    ok(a: unknown, msg?: string): void;
    match(a: string, b: RegExp): void;
    throws(fn: () => unknown, rec?: unknown): void;
    rejects(fn: Promise<unknown> | (() => Promise<unknown>), rec?: unknown): Promise<void>;
  };
  export default assert;
}

declare module "node:test" {
  export function test(name: string, fn: () => unknown | Promise<unknown>): void;
  export function test(
    name: string,
    opts: { timeout?: number },
    fn: () => unknown | Promise<unknown>,
  ): void;
  export function before(fn: () => unknown | Promise<unknown>): void;
  export function after(fn: () => unknown | Promise<unknown>): void;
}

declare function setInterval(handler: () => void, ms: number): unknown;
declare function clearInterval(id: unknown): void;
declare function setTimeout(handler: () => void, ms: number): unknown;
