declare module "node:fs" {
  export function readFileSync(path: string, encoding: "utf8"): string;
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
