/**
 * Power Automate Workflows webhook delivery (PCLIP-18, v1).
 *
 * A single POST of the {@link WorkflowsMessage} envelope. Retries with backoff +
 * degraded-delivery observability are a separate item (PCLIP-22 / T5); v1 makes
 * one attempt and — critically (AC #4) — NEVER throws into the caller, so a Teams
 * / Power Automate outage can never block the core Paperclip flow that emitted
 * the event. The classified result is returned for logging and for T5 to build on.
 *
 * Latency SLA (AC #1, "within 30 s"): the pipeline is event -> adapter (sync) ->
 * card build (sync) -> this POST. The only unbounded step is the POST, and it is
 * bounded by `timeoutMs` (default 10s) via an AbortController — comfortably under
 * 30s. {@link safeDeliver} additionally measures per-delivery latency and logs an
 * SLA-exceeded warning if a (successful) delivery ever crosses `softDeadlineMs`.
 */

import type { WorkflowsMessage } from "./adaptive-card.js";

/** Host of the RETIRED O365 connector webhooks (disabled May 2026). */
const O365_CONNECTOR_HOST = /(^|\.)webhook\.office\.com$/i;

/** Soft end-to-end SLA for a notification card (AC #1). Enforcement is the client timeout. */
export const NOTIFICATION_SLA_MS = 30_000;

export interface FetchResponseLike {
  status: number;
  text(): Promise<string>;
}

export type FetchLike = (
  url: string,
  init: { method: string; headers: Record<string, string>; body: string; signal?: AbortSignal },
) => Promise<FetchResponseLike>;

/** Coarse outcome; `transient` marks a failure T5 should retry. */
export type DeliveryOutcome =
  | { ok: true; status: number }
  | { ok: false; status?: number; transient: boolean; error: string };

export interface WorkflowsClient {
  post(url: string, message: WorkflowsMessage): Promise<DeliveryOutcome>;
}

export interface WorkflowsClientDeps {
  fetchFn: FetchLike;
  /** Per-request deadline in ms (default 10s). */
  timeoutMs?: number;
}

export function createWorkflowsClient(deps: WorkflowsClientDeps): WorkflowsClient {
  const timeoutMs = deps.timeoutMs ?? 10_000;
  return {
    async post(url, message): Promise<DeliveryOutcome> {
      if (!url || !/^https?:\/\//.test(url)) {
        return { ok: false, transient: false, error: "no valid Workflows webhook URL configured" };
      }
      // Fail loudly on a legacy O365 connector URL: those webhooks were retired in
      // May 2026 and would silently never deliver — the classic migration mistake.
      let host = "";
      try {
        host = new URL(url).hostname;
      } catch {
        return { ok: false, transient: false, error: "malformed Workflows webhook URL" };
      }
      if (O365_CONNECTOR_HOST.test(host)) {
        return {
          ok: false,
          transient: false,
          error: "URL is a legacy O365 connector (webhook.office.com), retired May 2026 — use a Power Automate Workflows URL",
        };
      }
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeoutMs);
      try {
        const res = await deps.fetchFn(url, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(message),
          signal: controller.signal,
        });
        if (res.status >= 200 && res.status < 300) return { ok: true, status: res.status };
        // 4xx = permanent (bad envelope / revoked URL); 429 + 5xx = transient (T5 retries).
        const transient = res.status === 429 || res.status >= 500;
        return { ok: false, status: res.status, transient, error: `Workflows webhook returned ${res.status}` };
      } catch (e) {
        const aborted = controller.signal.aborted || (e instanceof Error && e.name === "AbortError");
        return { ok: false, transient: true, error: aborted ? `timed out after ${timeoutMs}ms` : "network error" };
      } finally {
        clearTimeout(timer);
      }
    },
  };
}

/**
 * Deliver a card message without ever throwing (AC #4). Failures are logged and
 * returned, never propagated — notifications must not break the core flow.
 */
export async function safeDeliver(
  client: WorkflowsClient,
  url: string,
  message: WorkflowsMessage,
  log: (message: string, fields?: Record<string, unknown>) => void,
  context: Record<string, unknown> = {},
  softDeadlineMs: number = NOTIFICATION_SLA_MS,
  now: () => number = Date.now,
): Promise<DeliveryOutcome> {
  const startedAt = now();
  try {
    const outcome = await client.post(url, message);
    const latencyMs = now() - startedAt;
    if (!outcome.ok) {
      log("teams notification delivery failed", { ...context, ...outcome, latencyMs });
    } else if (latencyMs > softDeadlineMs) {
      // Delivered, but slower than the AC #1 SLA — surface it for operators.
      log("teams notification delivery exceeded SLA", { ...context, latencyMs, softDeadlineMs });
    }
    return outcome;
  } catch (e) {
    // Defensive: post() is designed not to throw, but guarantee non-blocking anyway.
    const error = e instanceof Error ? e.message : String(e);
    log("teams notification delivery threw (swallowed)", { ...context, error, latencyMs: now() - startedAt });
    return { ok: false, transient: true, error };
  }
}

// ---------------------------------------------------------------------------
// Retries with exponential backoff (PCLIP-22 / T5)
// ---------------------------------------------------------------------------

/**
 * Retry policy for {@link deliverWithRetry}. All knobs are injectable so the
 * backoff schedule is deterministic under test (no real timers, no real random).
 */
export interface RetryPolicy {
  /**
   * Retries attempted AFTER the first try. Default 3, i.e. UP TO 4 TOTAL attempts
   * (1 initial + 3 retries) — this is what "retried ×3" / "retried up to 3 times"
   * (AC #1) means. Named for the count of *retries*, not total attempts, to avoid
   * the off-by-one; the exhausted-case test asserts exactly 4 calls.
   */
  maxRetries?: number;
  /** First backoff, doubled each retry. Default 500ms. */
  baseDelayMs?: number;
  /** Per-backoff ceiling before jitter. Default 8000ms. */
  maxDelayMs?: number;
  /** Backoff growth factor. Default 2. */
  factor?: number;
  /**
   * Whole-loop wall-clock budget (Codex): once cumulative elapsed reaches this, NO
   * further attempt is scheduled and the last transient failure is returned. Bounds
   * the total time an event callback can stay busy — without it, 4 attempts each up
   * to the client timeout (10s) plus backoff could run ~40s, past the 30s SLA.
   * Default = softDeadlineMs (the 30s notification SLA).
   */
  overallDeadlineMs?: number;
  /** Sleep hook (default real setTimeout). Injected in tests to avoid wall-clock waits. */
  sleep?: (ms: number) => Promise<void>;
  /** Jitter source in [0,1) (default Math.random). Injected in tests for determinism. */
  random?: () => number;
}

/** Outcome of a delivery that may have been retried. */
export interface RetriedDelivery {
  /** The FINAL attempt's outcome. */
  outcome: DeliveryOutcome;
  /** Total attempts made (1 = first try succeeded or failed permanently). */
  attempts: number;
  /** Retries performed (attempts - 1). */
  retried: number;
}

const defaultSleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Deliver a card, retrying ONLY transient failures (429/5xx/timeout/network) with
 * exponential backoff + full jitter (AC #1). A permanent failure (4xx, malformed
 * URL, retired O365 host) is returned immediately with NO retries (AC #2) — retrying
 * a 4xx just burns quota and delays the inevitable. Success short-circuits.
 *
 * Never throws (built on {@link safeDeliver}), so it stays inside the non-blocking
 * notification envelope. Backoff runs off the core Paperclip flow (event handlers
 * and the scheduled digest job are already fire-and-forget from the host's emit).
 *
 * Bounded THREE ways so a callback can't stay busy indefinitely: (1) at most
 * maxRetries+1 attempts, (2) each attempt bounded by the client's per-request
 * timeout, and (3) an overall wall-clock deadline — once elapsed reaches
 * overallDeadlineMs no further attempt is scheduled (Codex: 4×10s + backoff would
 * otherwise overrun the 30s SLA).
 *
 * Every attempt and retry is logged via `log` (ctx.logger), whose output the host
 * captures into the plugin health dashboard, and final outcomes are counted as
 * metrics by the caller — together these are the "plugin observability" the task
 * requires for retries + success/failure rates (AC #4).
 *
 * Backoff for retry k (1-based) = min(maxDelayMs, baseDelayMs · factor^(k-1)),
 * then multiplied by a [0.5,1.0) jitter factor so many plugins retrying a recovering
 * endpoint don't reconverge into a thundering herd. Jitter never yields 0 (the floor
 * is 0.5×) so a retry always actually waits; the sleep is also clamped to the
 * remaining deadline budget.
 */
export async function deliverWithRetry(
  client: WorkflowsClient,
  url: string,
  message: WorkflowsMessage,
  log: (message: string, fields?: Record<string, unknown>) => void,
  context: Record<string, unknown> = {},
  policy: RetryPolicy = {},
  softDeadlineMs: number = NOTIFICATION_SLA_MS,
  now: () => number = Date.now,
): Promise<RetriedDelivery> {
  const maxRetries = policy.maxRetries ?? 3;
  const baseDelayMs = policy.baseDelayMs ?? 500;
  const maxDelayMs = policy.maxDelayMs ?? 8_000;
  const factor = policy.factor ?? 2;
  const overallDeadlineMs = policy.overallDeadlineMs ?? softDeadlineMs;
  const sleep = policy.sleep ?? defaultSleep;
  const random = policy.random ?? Math.random;
  const startedAt = now();

  let attempt = 0;
  // Loop is bounded: it can only continue on a TRANSIENT failure with retries left
  // AND within the overall deadline — so it runs at most maxRetries+1 times and never
  // past the wall-clock budget, no unbounded retry on a hard-down endpoint.
  for (;;) {
    attempt += 1;
    const outcome = await safeDeliver(client, url, message, log, { ...context, attempt }, softDeadlineMs, now);
    if (outcome.ok) return { outcome, attempts: attempt, retried: attempt - 1 };
    if (!outcome.transient) return { outcome, attempts: attempt, retried: attempt - 1 }; // permanent → stop (AC #2)
    if (attempt > maxRetries) return { outcome, attempts: attempt, retried: attempt - 1 }; // retries exhausted
    // Stop if the wall-clock budget is spent — don't schedule an attempt we can't
    // afford (keeps total callback-busy time near the SLA, not ~40s).
    const elapsed = now() - startedAt;
    if (elapsed >= overallDeadlineMs) {
      log("teams delivery retry budget exhausted — returning last transient failure", {
        ...context,
        attempt,
        elapsedMs: elapsed,
        overallDeadlineMs,
      });
      return { outcome, attempts: attempt, retried: attempt - 1 };
    }
    const ceiling = Math.min(maxDelayMs, baseDelayMs * Math.pow(factor, attempt - 1));
    const jittered = Math.max(1, Math.round(ceiling * (0.5 + random() * 0.5)));
    // Never sleep past the remaining budget.
    const delayMs = Math.max(1, Math.min(jittered, overallDeadlineMs - elapsed));
    log("teams delivery retrying after transient failure", {
      ...context,
      attempt,
      nextRetryInMs: delayMs,
      status: outcome.status,
    });
    await sleep(delayMs);
  }
}

// ---------------------------------------------------------------------------
// Delivery metrics (PCLIP-22 AC #4 — success/failure rates in plugin observability)
// ---------------------------------------------------------------------------

/** How a (possibly retried) delivery ended, for metric tagging. */
export type DeliveryResultKind = "success" | "transient_exhausted" | "permanent";

export function classifyRetried(r: RetriedDelivery): DeliveryResultKind {
  if (r.outcome.ok) return "success";
  return r.outcome.transient ? "transient_exhausted" : "permanent";
}

/** A single metric point to hand to `ctx.metrics.write(name, value, tags)`. */
export interface MetricPoint {
  name: string;
  value: number;
  tags: Record<string, string>;
}

/**
 * Metric points for one delivery, tagged by event type + channel so operators can
 * chart success/failure RATES per event type and per channel (AC #4). Kept pure so
 * the exact names/tags are unit-asserted; the worker just forwards each to
 * `ctx.metrics.write`. Tag values are always strings (host contract).
 */
export function deliveryMetricPoints(r: RetriedDelivery, meta: { eventType: string; channel: string }): MetricPoint[] {
  const base = { event_type: meta.eventType, channel: meta.channel };
  const result = classifyRetried(r);
  const points: MetricPoint[] = [
    // One "total" per delivery tagged with the outcome → success rate = success/total.
    { name: "teams.delivery.total", value: 1, tags: { ...base, result } },
    { name: r.outcome.ok ? "teams.delivery.success" : "teams.delivery.failure", value: 1, tags: { ...base } },
  ];
  if (r.retried > 0) points.push({ name: "teams.delivery.retries", value: r.retried, tags: { ...base } });
  return points;
}
