declare module "node:fs" {
  export type Dirent = {
    name: string;
    isFile(): boolean;
    isDirectory(): boolean;
  };
  export function readdirSync(path: string, options: { withFileTypes: true }): Dirent[];
  export function readdirSync(path: string): string[];
  export function readFileSync(path: string, encoding: "utf8"): string;
  export function writeFileSync(path: string, data: string, encoding: "utf8"): void;
  export function mkdirSync(path: string, options?: { recursive?: boolean }): string | undefined;
  export function rmSync(path: string, options?: { recursive?: boolean; force?: boolean }): void;
  export function existsSync(path: string): boolean;
}

declare module "node:path" {
  export function join(...parts: string[]): string;
}
