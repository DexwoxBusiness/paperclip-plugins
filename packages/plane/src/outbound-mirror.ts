/**
 * Outbound mirror (PCLIP-4): reflect Paperclip issue status transitions and
 * comments back onto the mapped Plane work item, so humans see agent progress
 * where they already work.
 *
 * SDK-decoupled: the worker adapts raw Paperclip domain events
 * (`issue.updated`, `issue.comment.created`) into {@link OutboundEvent}, and this
 * module decides what to mirror and drives a durable retry queue. Ports:
 * PlaneClientPort (P7), the PCLIP-6 mapping, and a plugin-state-backed queue.
 *
 * Key behaviours:
 *  - Echo-loop guard (AC #3): a change authored by THIS plugin is an inbound
 *    sync (PCLIP-2) being applied in Paperclip — never mirror it back. Origin is
 *    tracked via the event actor (plugin writes carry actorType="plugin").
 *  - Real transitions only: a status is mirrored only when it actually changed,
 *    so a non-status edit that merely carries the current status never PATCHes
 *    Plane's state back over a value changed in Plane.
 *  - State mapping (AC #1): Paperclip status -> Plane state name, per config.
 *  - Attribution (AC #2): mirrored comments carry "via Paperclip" + the author,
 *    with both untrusted strings HTML-escaped (no XSS into Plane).
 *  - Durable retry (AC #4): the resolved action is persisted (outbox) before the
 *    network call; queue mutations are serialized (in-process lock) so concurrent
 *    enqueues/drains cannot lose an action; transient failures are retried with
 *    exponential backoff by a scheduled drain, so a Plane outage loses nothing.
 *  - Latency (AC #1, "within 1 minute"): the inline attempt is bounded by a
 *    delivery deadline (default 10s; the concrete PCLIP-7 client itself aborts at
 *    5s). A miss stays queued and the drain job (every minute) retries it, so the
 *    end-to-end mirror lands within one drain cycle — never blocked on a hung call.
 *  - Observability: dead-lettered actions (permanent failure / retries exhausted)
 *    are NOT silently dropped — they are persisted to a separate dead-letter key
 *    and logged at error level with the action detail, so a mis-mapped Plane state
 *    (bad_request/not_found) is diagnosable rather than a vanished update.
 */

import { PlaneApiError, type PlaneApiErrorKind, type PlaneClientPort } from "./plane-client.js";
import type { IdMappingStore } from "./id-mapping.js";

/** A Paperclip change adapted from a domain event, ready to evaluate. */
export interface OutboundEvent {
  kind: "status" | "comment";
  /** Paperclip issue UUID. */
  paperclipIssueId: string;
  /** Actor that caused the change (echo-loop guard). */
  actorType?: string;
  actorId?: string;
  /** New Paperclip status (for kind="status"). */
  newStatus?: string;
  /** Previous status, when the event provides it — mirror only on a real change. */
  oldStatus?: string;
  /** Comment body + author (for kind="comment"). */
  commentBody?: string;
  commentAuthor?: string;
}

export interface OutboundConfig {
  /** Paperclip status -> Plane state name. Unmapped statuses are skipped. */
  stateMap: Record<string, string>;
  /** This plugin's ID — used to detect self-authored (inbound) changes. */
  pluginId: string;
}

export type MirrorDecision =
  | { kind: "skip"; reason: "echo" | "unsupported" | "no-state-mapping" | "no-status-change" | "empty-comment" }
  | { kind: "state"; planeState: string }
  | { kind: "comment"; commentHtml: string };

/** Escape HTML special chars so untrusted text renders as text, never markup. */
export function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

/**
 * Attribution wrapper for a mirrored Plane comment (AC #2). The body and author
 * are UNTRUSTED (agent/user input) and are HTML-escaped before interpolation, so
 * a comment can never inject markup/script into Plane (XSS). The body is treated
 * as plain text; rich-text passthrough with sanitization is a future enhancement.
 */
export function attributeComment(body: string, author?: string): string {
  const who = author && author.trim() ? author.trim() : "Paperclip agent";
  return `<p>${escapeHtml(body.trim())}</p>\n<p><em>— ${escapeHtml(who)} via Paperclip</em></p>`;
}

/**
 * Decide what (if anything) to mirror for a Paperclip change. Pure over config;
 * echo guard, real-transition check, and state mapping live here (unit-testable).
 */
export function evaluateMirror(event: OutboundEvent, config: OutboundConfig): MirrorDecision {
  // AC #3 echo guard: skip changes this plugin authored (inbound sync origin).
  // Per-change origin IS the event actor: an inbound Plane->Paperclip sync
  // (PCLIP-2) is applied by THIS plugin through ctx.issues, so the host stamps
  // those writes actorType="plugin" + actorId=<our pluginId>. The host actor enum
  // is user | agent | system | plugin; no inbound-sync path produces any other
  // actor, so matching plugin+pluginId is the complete, intended origin check. A
  // change from a DIFFERENT plugin's id is NOT our echo and is mirrored normally.
  if (event.actorType === "plugin" && event.actorId === config.pluginId) {
    return { kind: "skip", reason: "echo" };
  }
  if (event.kind === "status") {
    const status = (event.newStatus ?? "").trim();
    if (!status) return { kind: "skip", reason: "no-status-change" };
    // Only a REAL transition mirrors: a non-status edit that carries the current
    // status must not PATCH Plane back over a state changed in Plane (Codex P2).
    if (event.oldStatus !== undefined && event.oldStatus.trim() === status) {
      return { kind: "skip", reason: "no-status-change" };
    }
    const planeState = config.stateMap[status];
    if (!planeState) return { kind: "skip", reason: "no-state-mapping" };
    return { kind: "state", planeState };
  }
  if (event.kind === "comment") {
    if (!event.commentBody || !event.commentBody.trim()) return { kind: "skip", reason: "empty-comment" };
    return { kind: "comment", commentHtml: attributeComment(event.commentBody, event.commentAuthor) };
  }
  return { kind: "skip", reason: "unsupported" };
}

// --------------------------------------------------------------------------
// Durable outbox queue (AC #4)
// --------------------------------------------------------------------------

/** A persisted, resolved mirror action awaiting delivery to Plane. */
export interface MirrorAction {
  id: string;
  /** Plane work item id/identifier the mapping resolved to. */
  planeRef: string;
  kind: "state" | "comment";
  planeState?: string;
  commentHtml?: string;
  attempts: number;
  /** Epoch ms when this item is next eligible for a delivery attempt. */
  nextAttemptAt: number;
  enqueuedAt: number;
}

export interface QueueStore {
  get(key: string): Promise<unknown>;
  set(key: string, value: unknown): Promise<void>;
}

/**
 * A permanently-failed action, preserved for operational visibility instead of
 * being silently dropped. `failureKind`/`failureMessage` capture WHY it could not
 * be delivered (e.g. a bad_request/not_found from a mis-mapped Plane state name).
 */
export interface DeadLetter extends MirrorAction {
  failedAt: number;
  failureKind: PlaneApiErrorKind | "unknown";
  failureMessage: string;
}

/** Transient error kinds are retried; everything else is a permanent failure. */
export function isTransient(kind: PlaneApiErrorKind): boolean {
  return kind === "unavailable" || kind === "rate_limited";
}

const DEFAULTS = {
  key: "outbound-queue",
  deadLetterKey: "outbound-deadletter",
  baseBackoffMs: 30_000, // 30s
  maxBackoffMs: 15 * 60_000, // 15 min
  maxAttempts: 12,
  capacity: 1000,
  deadLetterCapacity: 500,
};

export interface OutboundQueue {
  enqueue(item: Omit<MirrorAction, "id" | "attempts" | "nextAttemptAt" | "enqueuedAt">): Promise<MirrorAction>;
  /** Remove a delivered action by id. */
  remove(id: string): Promise<void>;
  /** Process all due items via `deliver`; returns counts + any newly dead-lettered actions. */
  drain(
    deliver: (a: MirrorAction) => Promise<void>,
    now?: number,
  ): Promise<{ delivered: number; retried: number; deadLettered: number; deadLetters: DeadLetter[] }>;
  list(): Promise<MirrorAction[]>;
  /** Inspect permanently-failed actions (operational visibility / manual replay). */
  listDeadLetters(): Promise<DeadLetter[]>;
}

/** Serialize async sections so read-modify-write on the store can't interleave. */
function createLock(): <T>(fn: () => Promise<T>) => Promise<T> {
  let tail: Promise<unknown> = Promise.resolve();
  return <T>(fn: () => Promise<T>): Promise<T> => {
    const result = tail.then(fn, fn);
    tail = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  };
}

export function createOutboundQueue(
  store: QueueStore,
  opts: Partial<typeof DEFAULTS> & { now?: () => number } = {},
): OutboundQueue {
  const cfg = { ...DEFAULTS, ...opts };
  const now = opts.now ?? Date.now;
  // Single out-of-process worker per plugin (verified deployment model), so an
  // in-process lock is a sufficient and correct mutex for queue mutations.
  const lock = createLock();
  let seq = 0;

  async function load(): Promise<MirrorAction[]> {
    const raw = await store.get(cfg.key);
    return Array.isArray(raw) ? (raw as MirrorAction[]) : [];
  }
  async function save(items: MirrorAction[]): Promise<void> {
    while (items.length > cfg.capacity) items.shift();
    await store.set(cfg.key, items);
  }
  async function loadDeadLetters(): Promise<DeadLetter[]> {
    const raw = await store.get(cfg.deadLetterKey);
    return Array.isArray(raw) ? (raw as DeadLetter[]) : [];
  }
  async function appendDeadLetters(newly: DeadLetter[]): Promise<void> {
    if (newly.length === 0) return;
    const all = [...(await loadDeadLetters()), ...newly];
    while (all.length > cfg.deadLetterCapacity) all.shift();
    await store.set(cfg.deadLetterKey, all);
  }
  function backoff(attempts: number): number {
    return Math.min(cfg.baseBackoffMs * 2 ** attempts, cfg.maxBackoffMs);
  }

  return {
    enqueue(item): Promise<MirrorAction> {
      return lock(async () => {
        const items = await load();
        const action: MirrorAction = {
          ...item,
          id: `${now()}-${++seq}`,
          attempts: 0,
          nextAttemptAt: now(),
          enqueuedAt: now(),
        };
        items.push(action);
        await save(items);
        return action;
      });
    },

    remove(id): Promise<void> {
      return lock(async () => {
        const items = await load();
        await save(items.filter((i) => i.id !== id));
      });
    },

    list(): Promise<MirrorAction[]> {
      return load();
    },

    listDeadLetters(): Promise<DeadLetter[]> {
      return loadDeadLetters();
    },

    drain(deliver, tick = now()): Promise<{ delivered: number; retried: number; deadLettered: number; deadLetters: DeadLetter[] }> {
      // The whole drain (load -> deliver -> save) runs under the lock so an
      // enqueue can't overwrite the drained snapshot. Inline single-action
      // delivery (handle) does its network call OUTSIDE the lock, so the hot
      // event path is not blocked by a background drain.
      return lock(async () => {
        const items = await load();
        const keep: MirrorAction[] = [];
        const deadLetters: DeadLetter[] = [];
        let delivered = 0;
        let retried = 0;
        for (const item of items) {
          if (item.nextAttemptAt > tick) {
            keep.push(item);
            continue;
          }
          try {
            await deliver(item);
            delivered++;
          } catch (e) {
            const isPlaneErr = e instanceof PlaneApiError;
            const transient = isPlaneErr ? isTransient(e.kind) : true;
            const attempts = item.attempts + 1;
            if (transient && attempts < cfg.maxAttempts) {
              keep.push({ ...item, attempts, nextAttemptAt: tick + backoff(attempts) });
              retried++;
            } else {
              // Permanent failure or retries exhausted: preserve it (don't drop
              // work silently) with the reason it failed, for operator triage.
              deadLetters.push({
                ...item,
                attempts,
                failedAt: tick,
                failureKind: isPlaneErr ? e.kind : "unknown",
                failureMessage: e instanceof Error ? e.message : String(e),
              });
            }
          }
        }
        await save(keep);
        await appendDeadLetters(deadLetters);
        return { delivered, retried, deadLettered: deadLetters.length, deadLetters };
      });
    },
  };
}

// --------------------------------------------------------------------------
// Handler: resolve mapping, enqueue (outbox), deliver the new action inline
// --------------------------------------------------------------------------

export interface OutboundMirrorDeps {
  idMapping: Pick<IdMappingStore, "resolveByPaperclipId">;
  plane: Pick<PlaneClientPort, "updateState" | "addComment">;
  queue: OutboundQueue;
  getConfig(): Promise<OutboundConfig>;
  log(message: string, fields?: Record<string, unknown>): void;
  /** Error-level log for permanent failures (dead-letters). Defaults to `log`. */
  logError?(message: string, fields?: Record<string, unknown>): void;
  /**
   * Upper bound (ms) on a single delivery attempt. The concrete PCLIP-7 client
   * self-aborts at 5s; this is a defensive net so the SDK-decoupled core can't be
   * hung by a port that doesn't bound itself. A breach is surfaced as a transient
   * `unavailable` error, so the action stays queued and the drain retries it.
   * Default 10s — comfortably inside the 1-minute mirror SLA (AC #1).
   */
  deliverDeadlineMs?: number;
}

/**
 * Bound a delivery promise. On timeout, reject with a transient PlaneApiError so
 * the caller treats it like any other outage (queue + retry), never a data loss.
 * NB: this cannot abort the underlying request; the concrete client's own
 * AbortController (5s) does that — this only stops the mirror WAITING forever.
 */
function withDeadline<T>(p: Promise<T>, ms: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new PlaneApiError("unavailable", undefined, `Outbound delivery exceeded ${ms}ms deadline`)),
      ms,
    );
    p.then(
      (v) => {
        clearTimeout(timer);
        resolve(v);
      },
      (e) => {
        clearTimeout(timer);
        reject(e);
      },
    );
  });
}

export type OutboundOutcome =
  | { kind: "skipped"; reason: string }
  | { kind: "queued"; delivered: boolean };

export interface OutboundMirrorHandler {
  handle(event: OutboundEvent): Promise<OutboundOutcome>;
  /** Deliver one queued action to Plane (used by the queue drain). */
  deliver(action: MirrorAction): Promise<void>;
  /** Drain due retries (called from a scheduled job). */
  drainDue(now?: number): Promise<{ delivered: number; retried: number; deadLettered: number }>;
}

export function createOutboundMirrorHandler(deps: OutboundMirrorDeps): OutboundMirrorHandler {
  const deadlineMs = deps.deliverDeadlineMs ?? 10_000;
  const logError = deps.logError ?? deps.log;

  async function deliverRaw(action: MirrorAction): Promise<void> {
    if (action.kind === "state" && action.planeState) {
      await deps.plane.updateState(action.planeRef, action.planeState);
    } else if (action.kind === "comment" && action.commentHtml) {
      await deps.plane.addComment(action.planeRef, action.commentHtml);
    }
  }
  // Every attempt (inline and drain) is deadline-bounded so the mirror never
  // blocks the hot event path or a drain cycle on a slow/hung port.
  function deliver(action: MirrorAction): Promise<void> {
    return withDeadline(deliverRaw(action), deadlineMs);
  }

  async function drainDue(now?: number) {
    const res = await deps.queue.drain(deliver, now);
    // Dead-lettering drops work — make each one observable + actionable, never a
    // single opaque count. A state update failing bad_request/not_found almost
    // always means the outboundStateMap points at a Plane state that doesn't
    // exist (typo / renamed / deleted), so we call that out explicitly.
    for (const dl of res.deadLetters) {
      const stateMapHint =
        dl.kind === "state" && (dl.failureKind === "bad_request" || dl.failureKind === "not_found")
          ? ` — the Plane state "${dl.planeState}" may not exist; check outboundStateMap`
          : "";
      logError(`outbound mirror dead-lettered a ${dl.kind} action (permanent failure or retries exhausted)${stateMapHint}`, {
        actionId: dl.id,
        kind: dl.kind,
        planeRef: dl.planeRef,
        planeState: dl.planeState,
        attempts: dl.attempts,
        failureKind: dl.failureKind,
        failureMessage: dl.failureMessage,
      });
    }
    return res;
  }

  return {
    deliver,
    drainDue,

    async handle(event: OutboundEvent): Promise<OutboundOutcome> {
      const config = await deps.getConfig();
      const decision = evaluateMirror(event, config);
      if (decision.kind === "skip") {
        deps.log("outbound mirror skipped", { reason: decision.reason, paperclipIssueId: event.paperclipIssueId });
        return { kind: "skipped", reason: decision.reason };
      }

      const mapped = await deps.idMapping.resolveByPaperclipId(event.paperclipIssueId);
      if (!mapped) {
        deps.log("outbound mirror skipped: no live Plane mapping", { paperclipIssueId: event.paperclipIssueId });
        return { kind: "skipped", reason: "no-mapping" };
      }

      // Outbox: persist the resolved action BEFORE the network call (AC #4), then
      // deliver ONLY this action inline. On success remove it; on failure it
      // stays queued and the scheduled drain retries it with backoff.
      const action = await deps.queue.enqueue(
        decision.kind === "state"
          ? { planeRef: mapped.planeId, kind: "state", planeState: decision.planeState }
          : { planeRef: mapped.planeId, kind: "comment", commentHtml: decision.commentHtml },
      );
      try {
        await deliver(action);
        await deps.queue.remove(action.id);
        return { kind: "queued", delivered: true };
      } catch (e) {
        deps.log("outbound mirror deferred to retry queue", {
          paperclipIssueId: event.paperclipIssueId,
          error: e instanceof PlaneApiError ? e.kind : "unknown",
        });
        return { kind: "queued", delivered: false };
      }
    },
  };
}
