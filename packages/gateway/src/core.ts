import {
  LIMITS,
  fail,
  ok,
  validateDeliveryRoute,
  validateWireRequest,
  type DeliveryRoute,
  type JobSchedule,
  type ProtocolError,
  type ProtocolResult,
  type StaticTextJobCreate,
  type WireRequest,
} from "pi-hermes-gateway-protocol";
import type { Clock } from "./clock.js";
import type { SendAdapter, SendReceipt } from "./adapter.js";
import { createFakeAdapter } from "./fake-adapter.js";
import { newId } from "./ids.js";
import { dailyInstantsInRange, onceInstant } from "./schedule.js";
import { Store, type DeliveryRow } from "./store.js";

export type ApproveResult = ProtocolResult<{ kind: "job" | "delivery"; id: string; status: string }>;

export function approvePending(store: Store, id: string, nowMs: number): ApproveResult {
  const job = store.getJob(id);
  if (job) {
    if (job.status !== "pending-approval") return fail("invalid_body", "job is not pending approval");
    store.setJobStatus(id, "active");
    store.insertAudit(nowMs, "job.approved", { jobId: id });
    return ok({ kind: "job", id, status: "active" });
  }
  const row = store.getDelivery(id);
  if (row) {
    if (row.status !== "pending-approval") return fail("invalid_body", "delivery is not pending approval");
    store.setDeliveryStatus(id, "queued");
    store.insertAudit(nowMs, "delivery.approved", { deliveryId: id });
    return ok({ kind: "delivery", id, status: "queued" });
  }
  return fail("invalid_body", "unknown id");
}

export type CatchUpPolicy = "skip" | "one-latest";

export type CrashPoint = "claim" | "dispatch-intent" | "mid-send" | "before-receipt";

export type GatewayConfig = {
  routes: DeliveryRoute[];
  catchUpPolicy: CatchUpPolicy;
  notAfterBoundMs: number;
  tickGraceMs: number;
  tokenBucketCapacity: number;
  tokenBucketRefillPerMs: number;
  dailyCapPerRoute: number;
};

export const TICK_GRACE_MARGIN_MS = 5_000;

export const DEFAULT_CONFIG: Omit<GatewayConfig, "routes"> = {
  catchUpPolicy: "skip",
  notAfterBoundMs: LIMITS.maxNotAfterMs,
  tickGraceMs: 60_000 + TICK_GRACE_MARGIN_MS,
  tokenBucketCapacity: 5,
  tokenBucketRefillPerMs: 5 / 60_000,
  dailyCapPerRoute: 20,
};

export type GatewayResponse =
  | { ok: true; requestId: string; body: unknown }
  | { ok: false; requestId?: string; error: ProtocolError };

function routeKey(route: DeliveryRoute): string {
  return `${route.profileId}/${route.adapterId}/${route.accountId}/${route.chatId}/${route.threadId ?? ""}`;
}

function sameRoute(a: DeliveryRoute, b: DeliveryRoute): boolean {
  return routeKey(a) === routeKey(b);
}

function utcDay(ms: number): string {
  return new Date(ms).toISOString().slice(0, 10);
}

export function jobNotAfter(scheduledInstantMs: number, boundMs: number): number {
  return scheduledInstantMs + boundMs;
}

class InjectedCrash extends Error {
  point: CrashPoint;
  constructor(point: CrashPoint) {
    super(`injected crash at ${point}`);
    this.point = point;
  }
}

function isPromiseLike(value: unknown): value is PromiseLike<SendReceipt> {
  return typeof value === "object" && value !== null && typeof (value as { then?: unknown }).then === "function";
}

type DispatchOutcome = "done" | "stop";

export class Gateway {
  readonly store: Store;
  readonly clock: Clock;
  readonly config: GatewayConfig;
  readonly adapter: SendAdapter;
  crashNext: CrashPoint | null = null;
  // Called once when the outbox halts, before its best-effort audit; must not depend on the store.
  onOutboxHalt: (() => void) | null = null;
  private closed = false;
  // Held by the single outbox drain from before its first send until it exits, including while it
  // waits on an async receipt; other kicks (even reentrant ones from adapter.send) only request a rerun.
  private outboxDraining = false;
  private outboxRerun = false;
  // Set when a dispatch or its receipt (sync or async), or the drain resumed after an async receipt, throws
  // (e.g. the receipt write fails). The outbox then sends nothing more in this process; reopen records the
  // dispatching row commit-unknown.
  private outboxHalted: { error: unknown } | null = null;

  constructor(opts: { store: Store; clock: Clock; config: GatewayConfig; adapter: SendAdapter }) {
    this.store = opts.store;
    this.clock = opts.clock;
    this.config = opts.config;
    this.adapter = opts.adapter;
    if (this.config.notAfterBoundMs < 1 || this.config.notAfterBoundMs > LIMITS.maxNotAfterMs) {
      throw new Error("notAfterBoundMs must be in (0, 24h]");
    }
  }

  get outboxHalt(): { error: unknown } | null {
    return this.outboxHalted;
  }

  // Does not wait for a pending send: its row stays dispatching and reopen records commit-unknown.
  close(): void {
    this.closed = true;
    this.store.close();
  }

  // protocol caller: validateDeliveryRoute — owner-route allowlist compare
  routeAllowed(input: unknown): ProtocolResult<DeliveryRoute> {
    const parsed = validateDeliveryRoute(input);
    if (!parsed.ok) return parsed;
    if (parsed.value.adapterId !== this.adapter.manifest.adapterId) {
      return fail("invalid_route", "route adapterId does not match the loaded adapter");
    }
    const allowed = this.config.routes.some((r) => sameRoute(r, parsed.value));
    if (!allowed) return fail("invalid_route", "route is not authorised");
    return ok(parsed.value);
  }

  unauthorizedError(): ProtocolError {
    return { code: "invalid_route", message: "route is not authorised" };
  }

  audit(kind: string, payload: unknown): void {
    this.store.insertAudit(this.clock.nowMs(), kind, payload);
  }

  handleRequest(input: unknown, frameByteLength: number): GatewayResponse {
    const nowMs = this.clock.nowMs();
    // protocol caller: validateWireRequest — IPC/in-process request admission
    const parsed = validateWireRequest(input, { nowMs, frameByteLength });
    if (!parsed.ok) {
      this.audit("request.rejected", { error: parsed.error });
      return { ok: false, error: parsed.error };
    }
    const req = parsed.value;
    const prior = this.store.getRequest(req.requestId);
    if (prior) {
      return JSON.parse(prior) as GatewayResponse;
    }
    if (req.method === "delivery.enqueue") {
      const existing = this.store.getDeliveryByRequestId(req.requestId);
      if (existing) {
        const response = this.okBody(req, { deliveryId: existing.delivery_id, status: existing.status });
        this.store.putRequest(req.requestId, JSON.stringify(response), nowMs);
        return response;
      }
    }
    // Not recorded in request_log: the halt is in-process, so the same request may be retried after restart.
    if (this.outboxHalted && (req.method === "delivery.enqueue" || req.method === "job.create")) {
      return {
        ok: false,
        requestId: req.requestId,
        error: { code: "outbox_halted", message: "outbox is halted; restart the gateway to recover" },
      };
    }
    if (req.method === "job.create") {
      // job row, audit and request_log commit together so a crash cannot leave a job without its dedup entry
      return this.store.transaction(() => {
        const response = this.dispatchMethod(req);
        this.store.putRequest(req.requestId, JSON.stringify(response), nowMs);
        return response;
      });
    }
    const response = this.dispatchMethod(req);
    this.store.putRequest(req.requestId, JSON.stringify(response), nowMs);
    return response;
  }

  private dispatchMethod(req: WireRequest): GatewayResponse {
    switch (req.method) {
      case "job.create":
        return this.jobCreate(req);
      case "job.list":
        return this.okBody(req, { jobs: this.store.listJobs() });
      case "job.pause":
        return this.jobStatus(req, "paused");
      case "job.resume":
        return this.jobStatus(req, "active");
      case "job.cancel":
        return this.jobStatus(req, "cancelled");
      case "job.inspect":
        return this.jobInspect(req);
      case "delivery.enqueue":
        return this.deliveryEnqueue(req);
      case "delivery.inspect":
        return this.deliveryInspect(req);
      default:
        return { ok: false, requestId: req.requestId, error: { code: "unknown_method", message: "unknown method" } };
    }
  }

  private okBody(req: WireRequest, body: unknown): GatewayResponse {
    return { ok: true, requestId: req.requestId, body };
  }

  private jobCreate(req: WireRequest): GatewayResponse {
    const body = req.body as StaticTextJobCreate;
    const route = this.routeAllowed(body.route);
    this.audit("job.create.attempt", { requestId: req.requestId, route: body.route });
    if (!route.ok) return { ok: false, requestId: req.requestId, error: this.unauthorizedError() };
    if (body.text.length > this.adapter.manifest.maxTextLength) {
      return {
        ok: false,
        requestId: req.requestId,
        error: { code: "text_too_long", message: "text exceeds adapter maxTextLength" },
      };
    }
    const jobId = newId("job");
    const now = this.clock.nowMs();
    this.store.insertJob({
      job_id: jobId,
      kind: body.kind,
      text: body.text,
      route_json: JSON.stringify(route.value),
      schedule_json: JSON.stringify(body.schedule),
      status: body.requireApproval ? "pending-approval" : "active",
      created_at_ms: now,
      watermark_ms: now,
    });
    this.audit("job.create", { jobId, requestId: req.requestId });
    return this.okBody(req, { jobId });
  }

  private jobStatus(req: WireRequest, status: string): GatewayResponse {
    const jobId = (req.body as { jobId: string }).jobId;
    const job = this.store.getJob(jobId);
    if (!job) return { ok: false, requestId: req.requestId, error: { code: "invalid_body", message: "unknown job" } };
    if (status === "paused" && job.status === "pending-approval") {
      return {
        ok: false,
        requestId: req.requestId,
        error: { code: "invalid_body", message: "job is pending approval" },
      };
    }
    if (status === "active" && job.status === "pending-approval") {
      return {
        ok: false,
        requestId: req.requestId,
        error: { code: "invalid_body", message: "job is pending approval" },
      };
    }
    if (status === "active" && job.status === "cancelled") {
      return {
        ok: false,
        requestId: req.requestId,
        error: { code: "invalid_body", message: "job is cancelled" },
      };
    }
    this.store.setJobStatus(jobId, status);
    this.audit(`job.${status}`, { jobId });
    return this.okBody(req, { jobId, status });
  }

  private jobInspect(req: WireRequest): GatewayResponse {
    const jobId = (req.body as { jobId: string }).jobId;
    const job = this.store.getJob(jobId);
    if (!job) return { ok: false, requestId: req.requestId, error: { code: "invalid_body", message: "unknown job" } };
    return this.okBody(req, { job, occurrences: this.store.listOccurrences(jobId) });
  }

  private deliveryEnqueue(req: WireRequest): GatewayResponse {
    // protocol caller: validateStaticDelivery — operator delivery.enqueue (via validateWireRequest → validateMethodBody)
    const body = req.body as { route: DeliveryRoute; text: string; notAfter: number; requireApproval?: boolean };
    this.audit("delivery.enqueue.attempt", { requestId: req.requestId, route: body.route });
    const route = this.routeAllowed(body.route);
    if (!route.ok) return { ok: false, requestId: req.requestId, error: this.unauthorizedError() };
    if (body.text.length > this.adapter.manifest.maxTextLength) {
      this.audit("delivery.enqueue.rejected", { reason: "text_too_long" });
      return {
        ok: false,
        requestId: req.requestId,
        error: { code: "text_too_long", message: "text exceeds adapter maxTextLength" },
      };
    }
    const fuse = this.consumeFuses(route.value);
    if (!fuse.ok) {
      this.audit("delivery.enqueue.rejected", { reason: fuse.error.code, route: route.value });
      return { ok: false, requestId: req.requestId, error: fuse.error };
    }
    const now = this.clock.nowMs();
    if (now >= body.notAfter) {
      const deliveryId = newId("dlv");
      this.store.insertDelivery({
        delivery_id: deliveryId,
        job_id: null,
        occurrence_id: null,
        source: "enqueue",
        route_json: JSON.stringify(route.value),
        text: body.text,
        not_after_ms: body.notAfter,
        status: "expired",
        request_id: req.requestId,
        created_at_ms: now,
        dispatch_intent: 0,
      });
      this.audit("delivery.expired", { deliveryId });
      return this.okBody(req, { deliveryId, status: "expired" });
    }
    const pending = body.requireApproval === true;
    const deliveryId = newId("dlv");
    this.store.insertDelivery({
      delivery_id: deliveryId,
      job_id: null,
      occurrence_id: null,
      source: "enqueue",
      route_json: JSON.stringify(route.value),
      text: body.text,
      not_after_ms: body.notAfter,
      status: pending ? "pending-approval" : "queued",
      request_id: req.requestId,
      created_at_ms: now,
      dispatch_intent: 0,
    });
    this.audit("delivery.enqueue", { deliveryId, requestId: req.requestId, requireApproval: pending });
    if (!pending) this.processOutbox();
    const row = this.store.getDelivery(deliveryId);
    return this.okBody(req, { deliveryId, status: row?.status ?? (pending ? "pending-approval" : "queued") });
  }

  approve(id: string): ApproveResult {
    return approvePending(this.store, id, this.clock.nowMs());
  }

  private deliveryInspect(req: WireRequest): GatewayResponse {
    const deliveryId = (req.body as { deliveryId: string }).deliveryId;
    const row = this.store.getDelivery(deliveryId);
    if (!row) return { ok: false, requestId: req.requestId, error: { code: "invalid_body", message: "unknown delivery" } };
    return this.okBody(req, { delivery: row });
  }

  consumeFuses(route: DeliveryRoute): ProtocolResult<true> {
    const now = this.clock.nowMs();
    const cap = this.config.tokenBucketCapacity;
    const refill = this.config.tokenBucketRefillPerMs;
    const existing = this.store.getAccountFuse(route.accountId);
    let tokens = existing?.tokens ?? cap;
    const updated = existing?.updated_at_ms ?? now;
    tokens = Math.min(cap, tokens + Math.max(0, now - updated) * refill);
    if (tokens < 1) {
      this.store.setAccountFuse(route.accountId, tokens, now);
      return fail("rate_limited", "per-account token bucket exhausted");
    }
    const key = routeKey(route);
    const day = utcDay(now);
    const used = this.store.getRouteDay(key, day);
    if (used >= this.config.dailyCapPerRoute) {
      return fail("rate_limited", "per-route daily cap exhausted");
    }
    this.store.setAccountFuse(route.accountId, tokens - 1, now);
    this.store.setRouteDay(key, day, used + 1);
    return ok(true);
  }

  expectedInstants(schedule: JobSchedule, afterMs: number, toMs: number): number[] {
    if (schedule.type === "once") {
      const at = onceInstant(schedule.atUtc);
      void afterMs;
      return at <= toMs ? [at] : [];
    }
    return dailyInstantsInRange({
      timeZone: schedule.timeZone,
      localTime: schedule.localTime,
      afterMs,
      toMs,
    });
  }

  tick(): void {
    // Watermarks stay put while halted, so restart applies the normal catch-up policy.
    if (this.outboxHalted) return;
    if (this.store.getMeta("quarantine") === "1") return;
    const now = this.clock.nowMs();
    for (const job of this.store.listJobs()) {
      if (job.status !== "active") continue;
      const schedule = JSON.parse(job.schedule_json) as JobSchedule;
      const instants = this.expectedInstants(schedule, job.watermark_ms, now);
      const unique = instants.filter((ms) => !this.store.findOccurrence(job.job_id, ms));
      const grace = this.config.tickGraceMs;
      const onTime: number[] = [];
      const missed: number[] = [];
      for (const ms of unique) {
        if (now - ms <= grace) onTime.push(ms);
        else missed.push(ms);
      }
      for (const ms of onTime) this.admitJobOccurrence(job.job_id, ms, job.text, JSON.parse(job.route_json) as DeliveryRoute);
      if (missed.length > 0) {
        missed.sort((a, b) => a - b);
        const skipMissed = this.config.catchUpPolicy === "skip" || onTime.length > 0;
        if (skipMissed) {
          for (const ms of missed) this.recordSkipped(job.job_id, ms, "missed");
        } else {
          for (const ms of missed.slice(0, -1)) this.recordSkipped(job.job_id, ms, "missed");
          const latest = missed[missed.length - 1];
          if (latest !== undefined) {
            this.admitJobOccurrence(job.job_id, latest, job.text, JSON.parse(job.route_json) as DeliveryRoute);
          }
        }
      }
      this.store.setWatermark(job.job_id, now);
    }
    this.processOutbox();
  }

  private recordSkipped(jobId: string, scheduledInstantMs: number, reason: string): void {
    if (this.store.findOccurrence(jobId, scheduledInstantMs)) return;
    const occurrenceId = newId("occ");
    this.store.insertOccurrence({
      occurrence_id: occurrenceId,
      job_id: jobId,
      scheduled_instant_ms: scheduledInstantMs,
      status: "skipped",
    });
    this.audit("occurrence.skipped", { jobId, occurrenceId, scheduledInstantMs, reason });
  }

  private refuseInvalidRoute(row?: DeliveryRow, extra?: Record<string, unknown>): void {
    if (row) {
      this.store.setDeliveryStatus(row.delivery_id, "failed");
      if (row.occurrence_id) this.store.setOccurrenceStatus(row.occurrence_id, "skipped");
      this.audit("delivery.send.rejected", { deliveryId: row.delivery_id, reason: "invalid_route", ...extra });
      return;
    }
    this.audit("delivery.send.rejected", { reason: "invalid_route", ...extra });
  }

  // The occurrence, its delivery and audit commit together: findOccurrence treats any occurrence row as
  // admitted, so a partial write would block every later tick from repairing it.
  private admitJobOccurrence(jobId: string, scheduledInstantMs: number, text: string, route: DeliveryRoute): void {
    this.store.transaction(() => this.insertJobOccurrence(jobId, scheduledInstantMs, text, route));
  }

  private insertJobOccurrence(jobId: string, scheduledInstantMs: number, text: string, route: DeliveryRoute): void {
    if (this.store.findOccurrence(jobId, scheduledInstantMs)) return;
    if (!this.routeAllowed(route).ok) {
      this.recordSkipped(jobId, scheduledInstantMs, "invalid_route");
      this.refuseInvalidRoute(undefined, { jobId, scheduledInstantMs });
      return;
    }
    const now = this.clock.nowMs();
    const notAfter = jobNotAfter(scheduledInstantMs, this.config.notAfterBoundMs);
    const occurrenceId = newId("occ");
    if (now >= notAfter) {
      this.store.insertOccurrence({
        occurrence_id: occurrenceId,
        job_id: jobId,
        scheduled_instant_ms: scheduledInstantMs,
        status: "expired",
      });
      this.audit("occurrence.expired", { jobId, occurrenceId, scheduledInstantMs, notAfter });
      return;
    }
    this.store.insertOccurrence({
      occurrence_id: occurrenceId,
      job_id: jobId,
      scheduled_instant_ms: scheduledInstantMs,
      status: "pending",
    });
    const deliveryId = newId("dlv");
    this.store.insertDelivery({
      delivery_id: deliveryId,
      job_id: jobId,
      occurrence_id: occurrenceId,
      source: "job",
      route_json: JSON.stringify(route),
      text,
      not_after_ms: notAfter,
      status: "queued",
      request_id: null,
      created_at_ms: now,
      dispatch_intent: 0,
    });
    this.audit("occurrence.admitted", { jobId, occurrenceId, deliveryId, scheduledInstantMs, notAfter });
  }

  processOutbox(): void {
    if (this.outboxHalted) return;
    if (this.outboxDraining) {
      this.outboxRerun = true;
      return;
    }
    this.outboxDraining = true;
    this.drainOutbox(null, 0);
  }

  // Caller holds outboxDraining. Synchronous receipts settle inline; an async receipt suspends the
  // drain, keeping ownership until it settles. Every other exit releases ownership.
  private drainOutbox(snapshot: DeliveryRow[] | null, start: number): void {
    let rows = snapshot;
    let index = start;
    let suspended = false;
    try {
      for (;;) {
        if (this.closed || !this.store.dispatchEnabled()) return;
        if (!rows) {
          rows = this.store.queuedDeliveries();
          index = 0;
          this.outboxRerun = false;
        }
        for (; index < rows.length; index += 1) {
          const row = this.store.getDelivery(rows[index]!.delivery_id);
          if (row?.status !== "queued") continue;
          const outcome = this.dispatchGuarded(row);
          if (outcome === "stop") return;
          if (outcome !== "done") {
            const remaining = rows;
            const next = index + 1;
            suspended = true;
            void outcome
              .then((settled) => {
                if (settled === "done") this.drainOutbox(remaining, next);
                else this.outboxDraining = false;
              })
              .catch((err: unknown) => this.haltOutbox(err));
            return;
          }
        }
        if (!this.outboxRerun) return;
        rows = null;
      }
    } finally {
      if (!suspended) this.outboxDraining = false;
    }
  }

  private haltOutbox(error: unknown): void {
    this.outboxHalted = { error };
    this.outboxDraining = false;
    if (this.closed) return;
    try {
      // A notifier typed () => void may still be async; observe its rejection without awaiting it.
      const notice: unknown = this.onOutboxHalt?.();
      if (isPromiseLike(notice)) void Promise.resolve(notice).catch(() => {});
    } catch {
      /* the notice is best-effort; the in-memory halt and the audit below do not depend on it */
    }
    try {
      this.audit("outbox.halted", { reason: "dispatch-failed" });
    } catch {
      /* the store is already failing; the in-memory halt still stops dispatch */
    }
  }

  private dispatchGuarded(row: DeliveryRow): DispatchOutcome | Promise<DispatchOutcome> {
    try {
      const settling = this.dispatchOne(row);
      if (!settling) return "done";
      return settling.then(
        () => "done",
        (err: unknown) => this.stopOnInjectedCrash(row, err),
      );
    } catch (err) {
      if (err instanceof InjectedCrash) return this.stopOnInjectedCrash(row, err);
      this.haltOutbox(err);
      return "stop";
    }
  }

  private stopOnInjectedCrash(row: DeliveryRow, err: unknown): "stop" {
    if (!(err instanceof InjectedCrash)) throw err;
    if (!this.closed) this.applyCrash(row, err.point);
    this.crashNext = null;
    return "stop";
  }

  private dispatchOne(row: DeliveryRow): Promise<void> | undefined {
    const now = this.clock.nowMs();
    this.audit("delivery.send.attempt", { deliveryId: row.delivery_id });
    if (this.crashNext === "claim") throw new InjectedCrash("claim");
    if (row.occurrence_id) {
      const occ = this.store.getOccurrence(row.occurrence_id);
      if (occ && (occ.status === "interrupted" || occ.status === "commit-unknown" || occ.status === "skipped")) {
        return;
      }
      if (occ) this.store.setOccurrenceStatus(occ.occurrence_id, "claimed");
    }
    if (now >= row.not_after_ms) {
      this.store.setDeliveryStatus(row.delivery_id, "expired");
      if (row.occurrence_id) this.store.setOccurrenceStatus(row.occurrence_id, "expired");
      this.audit("delivery.expired", { deliveryId: row.delivery_id, notAfter: row.not_after_ms });
      return;
    }
    const route = JSON.parse(row.route_json) as DeliveryRoute;
    if (!this.routeAllowed(route).ok) {
      this.refuseInvalidRoute(row);
      return;
    }
    if (row.source === "job") {
      const fuse = this.consumeFuses(route);
      if (!fuse.ok) {
        this.store.setDeliveryStatus(row.delivery_id, "failed");
        this.audit("delivery.send.rejected", { deliveryId: row.delivery_id, reason: fuse.error.code });
        return;
      }
    }
    if (row.text.length > this.adapter.manifest.maxTextLength) {
      this.store.setDeliveryStatus(row.delivery_id, "failed");
      this.audit("delivery.send.rejected", { deliveryId: row.delivery_id, reason: "text_too_long" });
      return;
    }
    if (this.crashNext === "dispatch-intent") throw new InjectedCrash("dispatch-intent");
    this.store.setDispatchIntent(row.delivery_id);
    if (this.crashNext === "mid-send") this.adapter.crashMidSend = true;
    if (!this.routeAllowed(route).ok) {
      this.refuseInvalidRoute(row);
      return;
    }
    let receipt: SendReceipt | PromiseLike<SendReceipt>;
    try {
      receipt = this.adapter.send({
        deliveryId: row.delivery_id,
        route,
        text: row.text,
      });
    } catch {
      if (this.crashNext === "mid-send") throw new InjectedCrash("mid-send");
      this.recordReceipt(row, { receiptLevel: "commit-unknown", reason: "adapter-threw" });
      return;
    }
    if (isPromiseLike(receipt)) {
      return Promise.resolve(receipt).then(
        (settled) => this.recordReceipt(row, settled),
        () => {
          if (this.crashNext === "mid-send") throw new InjectedCrash("mid-send");
          this.recordReceipt(row, { receiptLevel: "commit-unknown", reason: "adapter-rejected" });
        },
      );
    }
    this.recordReceipt(row, receipt);
  }

  private recordReceipt(row: DeliveryRow, receipt: SendReceipt | undefined): void {
    if (this.closed) return;
    if (this.crashNext === "before-receipt") throw new InjectedCrash("before-receipt");
    // Delivery, occurrence and audit commit together; on failure the row stays dispatching for the halt
    // and reopen records commit-unknown.
    this.store.transaction(() => this.writeReceipt(row, receipt));
  }

  private writeReceipt(row: DeliveryRow, receipt: SendReceipt | undefined): void {
    if (receipt?.receiptLevel !== "accepted") {
      this.store.setDeliveryStatus(row.delivery_id, "commit-unknown");
      if (row.occurrence_id) this.store.setOccurrenceStatus(row.occurrence_id, "commit-unknown");
      this.audit("delivery.commit-unknown", {
        deliveryId: row.delivery_id,
        reason: receipt?.reason ?? "unknown",
      });
      return;
    }
    this.store.setDeliveryStatus(row.delivery_id, "accepted");
    if (row.occurrence_id) this.store.setOccurrenceStatus(row.occurrence_id, "completed");
    this.audit("delivery.accepted", { deliveryId: row.delivery_id });
  }

  private applyCrash(row: DeliveryRow, point: CrashPoint): void {
    if (point === "claim") {
      if (row.occurrence_id) this.store.setOccurrenceStatus(row.occurrence_id, "interrupted");
      this.store.setDeliveryStatus(row.delivery_id, "failed");
      this.audit("crash.claim", { deliveryId: row.delivery_id });
      return;
    }
    this.store.setDispatchIntent(row.delivery_id);
    this.store.setDeliveryStatus(row.delivery_id, "commit-unknown");
    if (row.occurrence_id) this.store.setOccurrenceStatus(row.occurrence_id, "commit-unknown");
    this.audit(`crash.${point}`, { deliveryId: row.delivery_id });
  }

  restoreQuarantine(backupTimeMs: number, recoveryTimeMs = this.clock.nowMs()): void {
    this.store.applyRestoreQuarantine(backupTimeMs, recoveryTimeMs);
    for (const job of this.store.listJobs()) {
      const schedule = JSON.parse(job.schedule_json) as JobSchedule;
      const instants =
        schedule.type === "once"
          ? (() => {
              const at = onceInstant(schedule.atUtc);
              return at <= recoveryTimeMs ? [at] : [];
            })()
          : this.expectedInstants(schedule, backupTimeMs, recoveryTimeMs);
      for (const ms of instants) {
        const existing = this.store.findOccurrence(job.job_id, ms);
        if (!existing) {
          const occurrenceId = newId("occ");
          this.store.insertOccurrence({
            occurrence_id: occurrenceId,
            job_id: job.job_id,
            scheduled_instant_ms: ms,
            status: "skipped",
          });
          this.audit("occurrence.skipped", {
            jobId: job.job_id,
            occurrenceId,
            scheduledInstantMs: ms,
            reason: "restore",
          });
        } else if (existing.status === "pending" || existing.status === "claimed" || existing.status === "interrupted") {
          this.store.setOccurrenceStatus(existing.occurrence_id, "skipped");
          this.audit("occurrence.skipped", {
            jobId: job.job_id,
            occurrenceId: existing.occurrence_id,
            scheduledInstantMs: ms,
            reason: "restore",
          });
        }
      }
      this.store.setWatermark(job.job_id, recoveryTimeMs);
    }
    this.audit("restore.quarantine", { backupTimeMs, recoveryTimeMs });
  }

  resumeDispatch(): void {
    this.store.setMeta("dispatch_enabled", "1");
    this.store.setMeta("quarantine", "0");
    this.audit("dispatch.resume", {});
  }

  recoverStuckDispatching(): void {
    for (const row of this.store.listDeliveries()) {
      if (row.status !== "dispatching") continue;
      // All-or-nothing per row: a failed write leaves it dispatching so the next open repairs it.
      this.store.transaction(() => {
        this.store.setDeliveryStatus(row.delivery_id, "commit-unknown");
        if (row.occurrence_id) this.store.setOccurrenceStatus(row.occurrence_id, "commit-unknown");
        this.audit("crash.recover", { deliveryId: row.delivery_id, previousStatus: row.status });
      });
    }
  }
}

export function openGateway(opts: {
  dbPath: string;
  clock: Clock;
  routes: DeliveryRoute[];
  catchUpPolicy?: CatchUpPolicy;
  notAfterBoundMs?: number;
  tickGraceMs?: number;
  tokenBucketCapacity?: number;
  tokenBucketRefillPerMs?: number;
  dailyCapPerRoute?: number;
  adapter?: SendAdapter;
}): { gateway: Gateway; backedUpTo: string | null } {
  const store = new Store(opts.dbPath);
  try {
    const { backedUpTo } = store.migrate();
    const gateway = new Gateway({
      store,
      clock: opts.clock,
      adapter: opts.adapter ?? createFakeAdapter(),
      config: {
        routes: opts.routes,
        catchUpPolicy: opts.catchUpPolicy ?? DEFAULT_CONFIG.catchUpPolicy,
        notAfterBoundMs: opts.notAfterBoundMs ?? DEFAULT_CONFIG.notAfterBoundMs,
        tickGraceMs: opts.tickGraceMs ?? DEFAULT_CONFIG.tickGraceMs,
        tokenBucketCapacity: opts.tokenBucketCapacity ?? DEFAULT_CONFIG.tokenBucketCapacity,
        tokenBucketRefillPerMs: opts.tokenBucketRefillPerMs ?? DEFAULT_CONFIG.tokenBucketRefillPerMs,
        dailyCapPerRoute: opts.dailyCapPerRoute ?? DEFAULT_CONFIG.dailyCapPerRoute,
      },
    });
    gateway.recoverStuckDispatching();
    return { gateway, backedUpTo };
  } catch (err) {
    store.close();
    throw err;
  }
}
