import process from "node:process";
import {
  companionEnqueue,
  companionJobCreate,
  companionJobList,
  companionStatus,
  daemonAvailable,
} from "./client.js";

export type CompanionHost = {
  on(event: string, handler: (...args: unknown[]) => unknown): void;
  registerTool?: (tool: {
    name: string;
    description: string;
    parameters: unknown;
    execute: (...args: unknown[]) => Promise<unknown>;
  }) => void;
};

export function resolveProfileDir(env: Record<string, string | undefined> = process.env): string {
  return env.PI_HERMES_GATEWAY_PROFILE ?? "";
}

function textResult(payload: unknown): { content: Array<{ type: "text"; text: string }> } {
  return { content: [{ type: "text", text: JSON.stringify(payload) }] };
}

export default function gatewayCompanion(pi: CompanionHost): void {
  pi.on("session_start", async () => {
    const profileDir = resolveProfileDir();
    if (!daemonAvailable(profileDir)) return;
    await companionStatus(profileDir);
  });
  pi.registerTool?.({
    name: "gateway_status",
    description: "Report local gateway daemon availability. Does not start a daemon.",
    parameters: { type: "object", properties: {} },
    async execute() {
      return textResult(await companionStatus(resolveProfileDir()));
    },
  });
  pi.registerTool?.({
    name: "gateway_enqueue",
    description: "Enqueue an owner-route static delivery through the local gateway daemon.",
    parameters: {
      type: "object",
      properties: {
        route: { type: "object" },
        text: { type: "string" },
        notAfter: { type: "number" },
      },
    },
    async execute(_id: unknown, params: unknown) {
      const body = params as { route: unknown; text: string; notAfter: number };
      return textResult(await companionEnqueue(resolveProfileDir(), body));
    },
  });
  pi.registerTool?.({
    name: "gateway_job_create",
    description: "Create an owner-route static-text job through the local gateway daemon.",
    parameters: { type: "object", properties: { body: { type: "object" } } },
    async execute(_id: unknown, params: unknown) {
      const rec = params as { body?: unknown };
      return textResult(await companionJobCreate(resolveProfileDir(), rec.body ?? params));
    },
  });
  pi.registerTool?.({
    name: "gateway_job_list",
    description: "List jobs from the local gateway daemon.",
    parameters: { type: "object", properties: {} },
    async execute() {
      return textResult(await companionJobList(resolveProfileDir()));
    },
  });
}
