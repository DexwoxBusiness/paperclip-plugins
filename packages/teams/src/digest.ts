/**
 * Daily digest (PCLIP-21, T4). A once-a-day Adaptive Card summarising the last
 * window's agent activity: tasks completed, tasks created, active agents, total
 * cost, and top performer.
 *
 * Stats are ACCUMULATED from domain events during the window (not queried): the
 * plugin ctx exposes no cost read API, and AC #3 requires the total to match the
 * accumulated `cost_event.created` values — so cost (and, for consistency, the
 * other counters) are summed as events arrive and persisted in plugin state. Cost
 * is stored in CENTS (the host's `cost_events.cost_cents`) and rendered as USD.
 *
 * Pure + SDK-decoupled: the rollup math and card building are unit-tested; the
 * worker owns the event subscriptions, the schedule, and delivery.
 */

import { adaptiveCard, factSet, textBlock, type AdaptiveCard } from "./adaptive-card.js";

export interface DigestRollup {
  /** Epoch ms when this window started (last reset). */
  windowStart: number;
  tasksCreated: number;
  tasksCompleted: number;
  /** Sum of cost_event.created cost, in cents (AC #3). */
  totalCostCents: number;
  costEventCount: number;
  /** Per-agent completion tally → active-agent count + top performer. */
  agentCompletions: Record<string, number>;
}

export function emptyRollup(now: number): DigestRollup {
  return { windowStart: now, tasksCreated: 0, tasksCompleted: 0, totalCostCents: 0, costEventCount: 0, agentCompletions: {} };
}

/** Coerce persisted JSON back into a well-formed rollup (defensive against shape drift). */
export function coerceRollup(raw: unknown, now: number): DigestRollup {
  const r = (raw ?? {}) as Partial<DigestRollup>;
  if (typeof r.windowStart !== "number") return emptyRollup(now);
  const completions = r.agentCompletions && typeof r.agentCompletions === "object" ? r.agentCompletions : {};
  const clean: Record<string, number> = {};
  for (const [k, v] of Object.entries(completions)) if (typeof v === "number" && v > 0) clean[k] = v;
  return {
    windowStart: r.windowStart,
    tasksCreated: numOr0(r.tasksCreated),
    tasksCompleted: numOr0(r.tasksCompleted),
    totalCostCents: numOr0(r.totalCostCents),
    costEventCount: numOr0(r.costEventCount),
    agentCompletions: clean,
  };
}

function numOr0(v: unknown): number {
  return typeof v === "number" && Number.isFinite(v) ? v : 0;
}

export function isEmptyRollup(r: DigestRollup): boolean {
  return (
    r.tasksCreated === 0 &&
    r.tasksCompleted === 0 &&
    r.totalCostCents === 0 &&
    Object.keys(r.agentCompletions).length === 0
  );
}

/** Distinct agents that completed work in the window ("active agents"). */
export function activeAgentCount(r: DigestRollup): number {
  return Object.keys(r.agentCompletions).length;
}

/** Agent with the most completions; ties broken by name for stable output. */
export function topPerformer(r: DigestRollup): { name: string; count: number } | undefined {
  let best: { name: string; count: number } | undefined;
  for (const [name, count] of Object.entries(r.agentCompletions)) {
    if (!best || count > best.count || (count === best.count && name < best.name)) best = { name, count };
  }
  return best;
}

export function formatCents(cents: number): string {
  return `$${(cents / 100).toFixed(2)}`;
}

// --------------------------------------------------------------------------
// Card
// --------------------------------------------------------------------------

/** Build the digest card. Zero activity → a compact "no activity" card (AC #2). */
export function buildDigestCard(r: DigestRollup): AdaptiveCard {
  if (isEmptyRollup(r)) {
    return adaptiveCard([
      textBlock("📊 Daily digest", { size: "Large", weight: "Bolder" }),
      textBlock("No agent activity in the last 24 hours.", { isSubtle: true }),
    ]);
  }
  const top = topPerformer(r);
  return adaptiveCard([
    textBlock("📊 Daily digest — last 24 hours", { size: "Large", weight: "Bolder" }),
    factSet([
      { title: "Tasks completed", value: String(r.tasksCompleted) },
      { title: "Tasks created", value: String(r.tasksCreated) },
      { title: "Active agents", value: String(activeAgentCount(r)) },
      { title: "Total cost", value: formatCents(r.totalCostCents) },
      { title: "Top performer", value: top ? `${top.name} (${top.count})` : "—" },
    ]),
  ]);
}

// --------------------------------------------------------------------------
// Store-backed accumulator (serialized read-modify-write)
// --------------------------------------------------------------------------

export interface DigestStore {
  get(key: string): Promise<unknown>;
  set(key: string, value: unknown): Promise<void>;
}

export const DIGEST_ROLLUP_KEY = "digest:rollup";

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

export interface DigestAccumulator {
  onIssueCreated(): Promise<void>;
  onTaskCompleted(agent?: string): Promise<void>;
  onCostCents(cents: number): Promise<void>;
  /** Read the current window without mutating (tests / previews). */
  peek(now?: number): Promise<DigestRollup>;
  /** Return the current window and start a fresh one (called by the digest job). */
  readAndReset(now?: number): Promise<DigestRollup>;
}

/**
 * Accumulate the daily rollup in plugin state. Every mutation is serialized by an
 * in-process lock so concurrent events can't clobber the read-modify-write (valid
 * for the single out-of-process worker model). readAndReset atomically snapshots
 * the window and starts a new one, so events during card delivery are not lost.
 */
export function createDigestAccumulator(store: DigestStore, opts: { now?: () => number } = {}): DigestAccumulator {
  const now = opts.now ?? Date.now;
  const lock = createLock();

  async function load(at: number): Promise<DigestRollup> {
    return coerceRollup(await store.get(DIGEST_ROLLUP_KEY), at);
  }
  function mutate(fn: (r: DigestRollup) => void): Promise<void> {
    return lock(async () => {
      const at = now();
      const r = await load(at);
      fn(r);
      await store.set(DIGEST_ROLLUP_KEY, r);
    });
  }

  return {
    onIssueCreated() {
      return mutate((r) => {
        r.tasksCreated += 1;
      });
    },
    onTaskCompleted(agent) {
      return mutate((r) => {
        r.tasksCompleted += 1;
        const key = (agent ?? "").trim() || "unknown";
        r.agentCompletions[key] = (r.agentCompletions[key] ?? 0) + 1;
      });
    },
    onCostCents(cents) {
      return mutate((r) => {
        if (!Number.isFinite(cents)) return;
        r.totalCostCents += cents;
        r.costEventCount += 1;
      });
    },
    peek(at = now()) {
      return load(at);
    },
    readAndReset(at = now()) {
      return lock(async () => {
        const r = await load(at);
        await store.set(DIGEST_ROLLUP_KEY, emptyRollup(at));
        return r;
      });
    },
  };
}
