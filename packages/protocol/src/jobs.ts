import { fail, ok, type ProtocolResult } from "./errors.js";
import { LIMITS, LOCAL_TIME_PATTERN, METHODS, type Method } from "./limits.js";
import { isIanaTimeZone, isPlainObject, requireToken } from "./check.js";
import { validateStaticDelivery, type DeliveryRoute, type StaticDelivery, validateDeliveryRoute } from "./delivery.js";

export type OnceSchedule = { type: "once"; atUtc: string };
export type DailySchedule = { type: "daily"; localTime: string; timeZone: string };
export type JobSchedule = OnceSchedule | DailySchedule;

export type StaticTextJobCreate = {
  kind: "static-text";
  text: string;
  route: DeliveryRoute;
  schedule: JobSchedule;
};

export type JobIdBody = { jobId: string };
export type DeliveryIdBody = { deliveryId: string };

function requireJobId(body: Record<string, unknown>): ProtocolResult<JobIdBody> {
  const jobId = requireToken(body.jobId, "jobId", "invalid_body");
  if (!jobId.ok) return fail("invalid_body", jobId.error.message);
  return ok({ jobId: jobId.value });
}

function validateOnceSchedule(value: Record<string, unknown>): ProtocolResult<OnceSchedule> {
  if (typeof value.atUtc !== "string" || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{3})?Z$/.test(value.atUtc)) {
    return fail("invalid_body", "once schedule atUtc must be an ISO-8601 UTC timestamp ending in Z");
  }
  const ms = Date.parse(value.atUtc);
  if (!Number.isFinite(ms)) return fail("invalid_body", "once schedule atUtc is not parseable");
  return ok({ type: "once", atUtc: value.atUtc });
}

function validateDailySchedule(value: Record<string, unknown>): ProtocolResult<DailySchedule> {
  if (typeof value.localTime !== "string" || !LOCAL_TIME_PATTERN.test(value.localTime)) {
    return fail("invalid_body", "daily localTime must be HH:MM in 24-hour form");
  }
  if (typeof value.timeZone !== "string" || !isIanaTimeZone(value.timeZone)) {
    return fail("invalid_body", "daily timeZone must be a valid IANA name");
  }
  return ok({ type: "daily", localTime: value.localTime, timeZone: value.timeZone });
}

function validateJobCreate(body: Record<string, unknown>, nowMs: number): ProtocolResult<StaticTextJobCreate> {
  if (body.kind !== "static-text") {
    return fail("invalid_body", "v1 job.create kind must be static-text");
  }
  if (typeof body.text !== "string" || body.text.length === 0) {
    return fail("invalid_body", "text must be a non-empty string");
  }
  if (body.text.length > LIMITS.maxTextChars) {
    return fail("text_too_long", `text exceeds ${LIMITS.maxTextChars} UTF-16 code units`);
  }
  const route = validateDeliveryRoute(body.route);
  if (!route.ok) return route;
  if (!isPlainObject(body.schedule) || typeof body.schedule.type !== "string") {
    return fail("invalid_body", "schedule is required");
  }
  let schedule: ProtocolResult<JobSchedule>;
  if (body.schedule.type === "once") schedule = validateOnceSchedule(body.schedule);
  else if (body.schedule.type === "daily") schedule = validateDailySchedule(body.schedule);
  else return fail("invalid_body", "schedule.type must be once or daily");
  if (!schedule.ok) return schedule;
  void nowMs;
  return ok({
    kind: "static-text",
    text: body.text,
    route: route.value,
    schedule: schedule.value,
  });
}

export function validateMethodBody(
  method: string,
  body: unknown,
  opts: { nowMs: number },
): ProtocolResult<unknown> {
  if (!METHODS.includes(method as Method)) {
    return fail("unknown_method", `unknown method ${method}`);
  }
  if (!isPlainObject(body)) return fail("invalid_body", "body must be a plain object");
  switch (method) {
    case "job.create":
      return validateJobCreate(body, opts.nowMs);
    case "job.list":
      return ok({});
    case "job.pause":
    case "job.resume":
    case "job.cancel":
    case "job.inspect":
      return requireJobId(body);
    case "delivery.enqueue":
      return validateStaticDelivery(body, opts);
    case "delivery.inspect": {
      const deliveryId = requireToken(body.deliveryId, "deliveryId", "invalid_body");
      if (!deliveryId.ok) return fail("invalid_body", deliveryId.error.message);
      return ok({ deliveryId: deliveryId.value } satisfies DeliveryIdBody);
    }
    default:
      return fail("unknown_method", `unknown method ${method}`);
  }
}

export type { StaticDelivery };
