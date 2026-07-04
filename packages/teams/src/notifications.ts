/**
 * Normalized Teams notifications + per-event-type card builders + budget-threshold
 * dedupe (PCLIP-18, v1).
 *
 * The worker adapts raw Paperclip domain events (issue.created,
 * agent.task_completed, approval.created, agent.run.failed,
 * budget.soft/hard_threshold_crossed) into a {@link TeamsNotification}; this
 * module turns each into a v1.5 Adaptive Card. Pure + SDK-decoupled so every
 * card is schema-validated in tests (AC #2).
 *
 * Deep-link buttons are intentionally OMITTED here — a card only carries an
 * Action.OpenUrl when the worker supplies a `link`, which arrives with PCLIP-20
 * (T3). v1 cards are notification-only.
 */

import { adaptiveCard, factSet, openUrlAction, textBlock, type AdaptiveCard } from "./adaptive-card.js";

export type TeamsNotification =
  | { kind: "issue-created"; issueIdentifier?: string; title: string; projectName?: string; link?: string }
  | { kind: "issue-done"; issueIdentifier?: string; title: string; agentName?: string; link?: string }
  | {
      kind: "approval";
      approvalId: string;
      title: string;
      requester: string;
      budget?: string;
      issueIdentifier?: string;
      issueTitle?: string;
      link?: string;
    }
  | { kind: "agent-error"; agentName?: string; issueIdentifier?: string; error: string; link?: string }
  | {
      kind: "budget-threshold";
      budgetId: string;
      budgetName?: string;
      threshold: number;
      spent?: string;
      limit?: string;
      link?: string;
    };

/** Which configured channel a notification routes to (T2/PCLIP-19 refines this). */
export type ChannelKind = "approvals" | "errors" | "pipeline" | "default";

/** Coarse routing hint per notification (T1 always resolves to the default URL). */
export function channelFor(n: TeamsNotification): ChannelKind {
  switch (n.kind) {
    case "approval":
      return "approvals";
    case "agent-error":
      return "errors";
    case "issue-created":
    case "issue-done":
      return "pipeline";
    case "budget-threshold":
      return "default";
  }
}

function header(emoji: string, title: string): ReturnType<typeof textBlock> {
  return textBlock(`${emoji} ${title}`, { size: "Large", weight: "Bolder" });
}

function withLink(card: AdaptiveCard, link?: string): AdaptiveCard {
  if (!link) return card;
  return adaptiveCard(card.body, [openUrlAction("View in Paperclip", link)]);
}

/** Build the v1.5 Adaptive Card for a notification. */
export function buildNotificationCard(n: TeamsNotification): AdaptiveCard {
  switch (n.kind) {
    case "issue-created": {
      const card = adaptiveCard([
        header("🆕", "Issue created"),
        textBlock(n.title, { weight: "Bolder", size: "Medium" }),
        factSet([
          { title: "Issue", value: n.issueIdentifier ?? "" },
          { title: "Project", value: n.projectName ?? "" },
        ]),
      ]);
      return withLink(card, n.link);
    }
    case "issue-done": {
      const card = adaptiveCard([
        header("✅", "Issue done"),
        textBlock(n.title, { weight: "Bolder", size: "Medium" }),
        factSet([
          { title: "Issue", value: n.issueIdentifier ?? "" },
          { title: "Completed by", value: n.agentName ?? "" },
        ]),
      ]);
      return withLink(card, n.link);
    }
    case "approval": {
      // AC #1: title, requester, budget, and issue fields.
      const card = adaptiveCard([
        header("🔔", "Approval requested"),
        textBlock(n.title, { weight: "Bolder", size: "Medium" }),
        factSet([
          { title: "Requester", value: n.requester },
          { title: "Budget", value: n.budget ?? "" },
          { title: "Issue", value: n.issueIdentifier ?? "" },
          { title: "Issue title", value: n.issueTitle ?? "" },
        ]),
      ]);
      return withLink(card, n.link);
    }
    case "agent-error": {
      const card = adaptiveCard([
        header("🛑", "Agent error"),
        factSet([
          { title: "Agent", value: n.agentName ?? "" },
          { title: "Issue", value: n.issueIdentifier ?? "" },
        ]),
        textBlock(n.error, { wrap: true, color: "Attention" }),
      ]);
      return withLink(card, n.link);
    }
    case "budget-threshold": {
      const card = adaptiveCard([
        header("💸", `Budget ${n.threshold}% reached`),
        factSet([
          { title: "Budget", value: n.budgetName ?? n.budgetId },
          { title: "Spent", value: n.spent ?? "" },
          { title: "Limit", value: n.limit ?? "" },
        ]),
      ]);
      return withLink(card, n.link);
    }
  }
}

// --------------------------------------------------------------------------
// Budget-threshold dedupe (AC #3 — one card per threshold)
// --------------------------------------------------------------------------

export interface DedupeStore {
  get(key: string): Promise<unknown>;
  set(key: string, value: unknown): Promise<void>;
}

export function thresholdKey(budgetId: string, threshold: number): string {
  return `budget-threshold:${budgetId}:${threshold}`;
}

/** Serialize check-then-set so two concurrent crossings can't both post. */
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

export type BudgetPostResult = "posted" | "deduped" | "skipped";

export interface BudgetDedupe {
  /**
   * Post a budget-threshold card at most once per (budget, threshold). The whole
   * check -> deliver -> mark sequence is serialized by an in-process lock, and the
   * threshold is recorded as seen ONLY after `deliver` reports SUCCESS. So a
   * crossing that happens before the Workflows URL is configured, or during a
   * transient Teams outage, is NOT suppressed — a later crossing still posts once
   * delivery succeeds. Returns "posted" (delivered + marked), "deduped" (already
   * posted before), or "skipped" (invalid input, or delivery did not succeed).
   */
  postOnce(budgetId: string, threshold: number, deliver: () => Promise<boolean>, now?: number): Promise<BudgetPostResult>;
}

/**
 * Dedupe budget-threshold cards per (budgetId, threshold), persisted in plugin
 * state so a restart doesn't re-post. Marking-after-success (not before) means a
 * failed/skipped delivery leaves the threshold un-marked and retryable on the next
 * crossing — the dedupe never swallows the one and only card (Codex).
 */
export function createBudgetDedupe(store: DedupeStore): BudgetDedupe {
  const lock = createLock();
  return {
    postOnce(budgetId, threshold, deliver, now = Date.now()): Promise<BudgetPostResult> {
      return lock(async () => {
        if (!budgetId || !Number.isFinite(threshold)) return "skipped";
        const key = thresholdKey(budgetId, threshold);
        if (await store.get(key)) return "deduped";
        const delivered = await deliver();
        if (!delivered) return "skipped"; // do NOT mark — allow a retry on a later crossing
        await store.set(key, { postedAt: now });
        return "posted";
      });
    },
  };
}
