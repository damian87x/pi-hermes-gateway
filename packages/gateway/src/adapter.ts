import type { AdapterManifest, DeliveryRoute } from "pi-hermes-gateway-protocol";

export type SendEnvelope = {
  deliveryId: string;
  route: DeliveryRoute;
  text: string;
};

export type SendReceipt = {
  receiptLevel: "accepted" | "commit-unknown";
  providerMessageId?: string;
  reason?: string;
};

// A Promise receipt settles the delivery later; a rejection is treated like a commit-unknown receipt.
export type SendAdapter = {
  manifest: AdapterManifest;
  send(envelope: SendEnvelope): SendReceipt | Promise<SendReceipt>;
  crashMidSend?: boolean;
};

export function isSendAdapter(value: unknown): value is SendAdapter {
  if (typeof value !== "object" || value === null) return false;
  const rec = value as { manifest?: unknown; send?: unknown };
  if (typeof rec.send !== "function") return false;
  if (typeof rec.manifest !== "object" || rec.manifest === null) return false;
  const manifest = rec.manifest as { adapterId?: unknown; maxTextLength?: unknown };
  return typeof manifest.adapterId === "string" && typeof manifest.maxTextLength === "number";
}
