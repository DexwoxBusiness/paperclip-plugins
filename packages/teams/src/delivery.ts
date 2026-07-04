/**
 * Power Automate Workflows webhook delivery (PCLIP-18, v1).
 *
 * A single POST of the {@link WorkflowsMessage} envelope. Retries with backoff +
 * degraded-delivery observability are a separate item (PCLIP-22 / T5); v1 makes
 * one attempt and — critically (AC #4) — NEVER throws into the caller, so a Teams
 * / Power Automate outage can never block the core Paperclip flow that emitted
 * the event. The classified result is returned for logging and for T5 to build on.
 */

import type { WorkflowsMessage } from "./adaptive-card.js";

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
): Promise<DeliveryOutcome> {
  try {
    const outcome = await client.post(url, message);
    if (!outcome.ok) {
      log("teams notification delivery failed", { ...context, ...outcome });
    }
    return outcome;
  } catch (e) {
    // Defensive: post() is designed not to throw, but guarantee non-blocking anyway.
    const error = e instanceof Error ? e.message : String(e);
    log("teams notification delivery threw (swallowed)", { ...context, error });
    return { ok: false, transient: true, error };
  }
}
