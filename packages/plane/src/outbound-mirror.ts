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
 *  - State mapping (AC #1): Paperclip status -> Plane state name, per config.
 *  - Attribution (AC #2): mirrored comments carry "via Paperclip" + the author.
 *  - Durable retry (AC #4): the resolved action is persisted (outbox) before the
 *    network call; transient failures are retried with exponential backoff by a
 *    scheduled drain, so a Plane outage never loses a change.
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
  | { kind: "skip"; reason: "echo" | "unsupported" | "no-state-mapping" | "empty-comment" }
  | { kind: "state"; planeState: string }
  | { kind: "comment"; commentHtml: string };

/** Attribution wrapper so a mirrored Plane comment shows its Paperclip origin (AC #2). */
export function attributeComment(body: string, author?: string): string {
  const who = author && author.trim() ? author.trim() : "Paperclip agent";
  const safeBody = body.trim();
  return `${safeBody}\n<p><em>— ${who} via Paperclip</em></p>`;
}

/**
 * Decide what (if anything) to mirror for a Paperclip change. Pure over config;
 * the echo-loop guard and state mapping live here so they are unit-testable.
 */
export function evaluateMirror(event: OutboundEvent, config: OutboundConfig): MirrorDecision {
  // AC #3 echo guard: skip changes this plugin authored (inbound sync origin).
  if (event.actorType === "plugin" && event.actorId === config.pluginId) {
    return { kind: "skip", reason: "echo" };
  }
  if (event.kind === "status") {
    const status = (event.newStatus ?? "").trim();
    const planeState = status ? config.stateMap[status] : undefined;
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

/** Transient error kinds are retried; everything else is a permanent failure. */
export function isTransient(kind: PlaneApiErrorKind): boolean {
  return kind === "unavailable" || kind === "rate_limited";
}

const DEFAULTS = {
  key: "outbound-queue",
  baseBackoffMs: 30_000, // 30s
  maxBackoffMs: 15 * 60_000, // 15 min
  maxAttempts: 12,
  capacity: 1000,
};

export interface OutboundQueue {
  enqueue(item: Omit<MirrorAction, "id" | "attempts" | "nextAttemptAt" | "enqueuedAt">): Promise<MirrorAction>;
  /** Process all due items via `deliver`; returns counts. Safe to call repeatedly. */
  drain(deliver: (a: MirrorAction) => Promise<void>, now?: number): Promise<{ delivered: number; retried: number; deadLettered: number }>;
  list(): Promise<MirrorAction[]>;
}

export function createOutboundQueue(
  store: QueueStore,
  opts: Partial<typeof DEFAULTS> & { now?: () => number } = {},
): OutboundQueue {
  const cfg = { ...DEFAULTS, ...opts };
  const now = opts.now ?? Date.now;
  let seq = 0;

  async function load(): Promise<MirrorAction[]> {
    const raw = await store.get(cfg.key);
    return Array.isArray(raw) ? (raw as MirrorAction[]) : [];
  }
  async function save(items: MirrorAction[]): Promise<void> {
    // Bounded: drop the oldest beyond capacity (defensive; a healthy queue drains).
    while (items.length > cfg.capacity) items.shift();
    await store.set(cfg.key, items);
  }

  function backoff(attempts: number): number {
    return Math.min(cfg.baseBackoffMs * 2 ** attempts, cfg.maxBackoffMs);
  }

  return {
    async enqueue(item): Promise<MirrorAction> {
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
    },

    async list(): Promise<MirrorAction[]> {
      return load();
    },

    async drain(deliver, tick = now()): Promise<{ delivered: number; retried: number; deadLettered: number }> {
      const items = await load();
      const keep: MirrorAction[] = [];
      let delivered = 0;
      let retried = 0;
      let deadLettered = 0;
      for (const item of items) {
        if (item.nextAttemptAt > tick) {
          keep.push(item); // not due yet
          continue;
        }
        try {
          await deliver(item);
          delivered++; // success -> drop from queue
        } catch (e) {
          const transient = e instanceof PlaneApiError ? isTransient(e.kind) : true; // unknown -> treat as transient
          const attempts = item.attempts + 1;
          if (transient && attempts < cfg.maxAttempts) {
            keep.push({ ...item, attempts, nextAttemptAt: tick + backoff(attempts) });
            retried++;
          } else {
            deadLettered++; // permanent, or exhausted retries -> drop (logged by caller)
          }
        }
      }
      await save(keep);
      return { delivered, retried, deadLettered };
    },
  };
}

// --------------------------------------------------------------------------
// Handler: resolve mapping, enqueue (outbox), attempt inline
// --------------------------------------------------------------------------

export interface OutboundMirrorDeps {
  idMapping: Pick<IdMappingStore, "resolveByPaperclipId">;
  plane: Pick<PlaneClientPort, "updateState" | "addComment">;
  queue: OutboundQueue;
  getConfig(): Promise<OutboundConfig>;
  log(message: string, fields?: Record<string, unknown>): void;
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
  async function deliver(action: MirrorAction): Promise<void> {
    if (action.kind === "state" && action.planeState) {
      await deps.plane.updateState(action.planeRef, action.planeState);
    } else if (action.kind === "comment" && action.commentHtml) {
      await deps.plane.addComment(action.planeRef, action.commentHtml);
    }
  }

  return {
    deliver,

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

      // Outbox: persist the resolved action BEFORE the network call, so a Plane
      // outage cannot lose it (AC #4). Then attempt an inline drain.
      await deps.queue.enqueue(
        decision.kind === "state"
          ? { planeRef: mapped.planeId, kind: "state", planeState: decision.planeState }
          : { planeRef: mapped.planeId, kind: "comment", commentHtml: decision.commentHtml },
      );
      const res = await this.drainDue();
      return { kind: "queued", delivered: res.delivered > 0 };
    },

    async drainDue(now?: number) {
      const res = await deps.queue.drain(deliver, now);
      if (res.deadLettered > 0) {
        deps.log("outbound mirror dead-lettered actions (permanent failure or retries exhausted)", { count: res.deadLettered });
      }
      return res;
    },
  };
}
