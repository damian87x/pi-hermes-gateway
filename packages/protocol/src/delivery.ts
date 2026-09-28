import { fail, ok, type ProtocolResult } from "./errors.js";
import { LIMITS } from "./limits.js";
import { isPlainObject, requireInteger, requireToken } from "./check.js";

export type DeliveryRoute = {
  profileId: string;
  adapterId: string;
  accountId: string;
  chatId: string;
  threadId?: string;
};

export type StaticDelivery = {
  route: DeliveryRoute;
  text: string;
  notAfter: number;
  requireApproval: boolean;
};

export function validateDeliveryRoute(input: unknown): ProtocolResult<DeliveryRoute> {
  if (!isPlainObject(input)) return fail("invalid_route", "route must be an object");
  const profileId = requireToken(input.profileId, "profileId", "invalid_route");
  if (!profileId.ok) return profileId;
  const adapterId = requireToken(input.adapterId, "adapterId", "invalid_route");
  if (!adapterId.ok) return adapterId;
  const accountId = requireToken(input.accountId, "accountId", "invalid_route");
  if (!accountId.ok) return accountId;
  const chatId = requireToken(input.chatId, "chatId", "invalid_route");
  if (!chatId.ok) return chatId;

  const route: DeliveryRoute = {
    profileId: profileId.value,
    adapterId: adapterId.value,
    accountId: accountId.value,
    chatId: chatId.value,
  };
  if (input.threadId !== undefined) {
    const threadId = requireToken(input.threadId, "threadId", "invalid_route");
    if (!threadId.ok) return threadId;
    route.threadId = threadId.value;
  }
  return ok(route);
}

export function validateStaticDelivery(
  input: unknown,
  opts: { nowMs: number },
): ProtocolResult<StaticDelivery> {
  const nowMs = requireInteger(opts.nowMs, "malformed", "nowMs must be an integer unix millisecond timestamp");
  if (!nowMs.ok) return nowMs;
  if (!isPlainObject(input)) return fail("malformed", "delivery must be an object");
  const route = validateDeliveryRoute(input.route);
  if (!route.ok) return route;
  if (typeof input.text !== "string" || input.text.length === 0) {
    return fail("invalid_body", "text must be a non-empty string");
  }
  if (input.text.length > LIMITS.maxTextChars) {
    return fail(
      "text_too_long",
      `text exceeds ${LIMITS.maxTextChars} UTF-16 code units (ECMAScript string length)`,
    );
  }
  if (typeof input.notAfter !== "number" || !Number.isInteger(input.notAfter)) {
    return fail("invalid_not_after", "notAfter must be an integer unix millisecond timestamp");
  }
  if (input.notAfter <= nowMs.value || input.notAfter > nowMs.value + LIMITS.maxNotAfterMs) {
    return fail(
      "invalid_not_after",
      `notAfter must be > now and <= now + ${LIMITS.maxNotAfterMs}ms (24h)`,
    );
  }
  if (input.requireApproval !== undefined && typeof input.requireApproval !== "boolean") {
    return fail("invalid_body", "requireApproval must be a boolean");
  }
  return ok({
    route: route.value,
    text: input.text,
    notAfter: input.notAfter,
    requireApproval: input.requireApproval === true,
  });
}
