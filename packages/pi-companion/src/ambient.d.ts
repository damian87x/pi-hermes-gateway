declare class TextEncoder {
  encode(s: string): Uint8Array;
}
declare class TextDecoder {
  decode(s: Uint8Array | string): string;
}

declare module "node:fs" {
  export function existsSync(path: string): boolean;
  export function readFileSync(path: string, encoding: "utf8"): string;
}

declare module "node:path" {
  export function join(...parts: string[]): string;
}

declare module "node:process" {
  const process: {
    env: Record<string, string | undefined>;
  };
  export default process;
}

declare module "node:net" {
  export type Socket = {
    on(ev: string, fn: (...args: unknown[]) => void): void;
    once(ev: string, fn: (...args: unknown[]) => void): void;
    write(data: string | Uint8Array): boolean;
    end(): void;
    destroy(): void;
  };
  export function createConnection(path: string, cb?: () => void): Socket;
}

declare function setTimeout(handler: () => void, ms: number): unknown;
declare function clearTimeout(id: unknown): void;
