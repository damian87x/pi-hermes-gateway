declare module "node:path" {
  export function resolve(...parts: string[]): string;
}

declare function setTimeout(handler: () => void, ms: number): unknown;
declare function clearTimeout(id: unknown): void;
