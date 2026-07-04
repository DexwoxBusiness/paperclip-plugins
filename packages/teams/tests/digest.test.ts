import { describe, expect, it } from "vitest";
import {
  activeAgentCount,
  buildDigestCard,
  coerceRollup,
  createDigestAccumulator,
  emptyRollup,
  formatCents,
  isEmptyRollup,
  topPerformer,
  type DigestStore,
} from "../src/digest.js";
import { extractCostCents } from "../src/event-adapters.js";
import { validateAdaptiveCard } from "../src/adaptive-card.js";

function makeStore(): DigestStore & { map: Map<string, unknown> } {
  const map = new Map<string, unknown>();
  return { map, get: async (k) => map.get(k) ?? null, set: async (k, v) => void map.set(k, v) };
}

describe("digest rollup (PCLIP-21)", () => {
  it("accumulates tasks, agents, and cost; peek reflects the running window", async () => {
    const acc = createDigestAccumulator(makeStore(), { now: () => 1000 });
    await acc.onIssueCreated();
    await acc.onIssueCreated();
    await acc.onTaskCompleted("Ada");
    await acc.onTaskCompleted("Ada");
    await acc.onTaskCompleted("Bob");
    await acc.onCostCents(150);
    await acc.onCostCents(99);
    const r = await acc.peek();
    expect(r).toMatchObject({ tasksCreated: 2, tasksCompleted: 3, totalCostCents: 249, costEventCount: 2 });
    expect(activeAgentCount(r)).toBe(2);
    expect(topPerformer(r)).toEqual({ name: "Ada", count: 2 });
  });

  it("total cost equals the sum of accumulated cost events (AC #3)", async () => {
    const acc = createDigestAccumulator(makeStore());
    const costs = [12, 34, 500, 7];
    for (const c of costs) await acc.onCostCents(c);
    expect((await acc.peek()).totalCostCents).toBe(costs.reduce((a, b) => a + b, 0));
  });

  it("serializes concurrent accumulation — no lost counts", async () => {
    const acc = createDigestAccumulator(makeStore());
    await Promise.all(Array.from({ length: 25 }, () => acc.onIssueCreated()));
    expect((await acc.peek()).tasksCreated).toBe(25);
  });

  it("readAndReset returns the window and starts a fresh one", async () => {
    const acc = createDigestAccumulator(makeStore(), { now: () => 5000 });
    await acc.onIssueCreated();
    await acc.onCostCents(200);
    const snap = await acc.readAndReset(6000);
    expect(snap).toMatchObject({ tasksCreated: 1, totalCostCents: 200 });
    const fresh = await acc.peek();
    expect(isEmptyRollup(fresh)).toBe(true);
    expect(fresh.windowStart).toBe(6000);
  });

  it("unknown agent falls back to 'unknown'; ties are name-stable", () => {
    const r = emptyRollup(0);
    r.agentCompletions = { Zed: 2, Ada: 2, Bob: 1 };
    expect(topPerformer(r)).toEqual({ name: "Ada", count: 2 }); // tie → lexicographic
  });

  it("coerceRollup repairs malformed persisted state", () => {
    expect(isEmptyRollup(coerceRollup(null, 10))).toBe(true);
    expect(isEmptyRollup(coerceRollup({ nonsense: true }, 10))).toBe(true);
    const r = coerceRollup({ windowStart: 1, tasksCreated: 3, agentCompletions: { Ada: 2, bad: "x" } }, 10);
    expect(r.tasksCreated).toBe(3);
    expect(r.agentCompletions).toEqual({ Ada: 2 });
  });

  it("formats cents as USD", () => {
    expect(formatCents(0)).toBe("$0.00");
    expect(formatCents(249)).toBe("$2.49");
    expect(formatCents(100000)).toBe("$1000.00");
  });
});

describe("digest card (PCLIP-21)", () => {
  it("builds a valid v1.5 card with the five stat groups", async () => {
    const acc = createDigestAccumulator(makeStore());
    await acc.onIssueCreated();
    await acc.onTaskCompleted("Ada");
    await acc.onCostCents(1234);
    const card = buildDigestCard(await acc.peek());
    expect(validateAdaptiveCard(card)).toEqual({ ok: true, errors: [] });
    const json = JSON.stringify(card);
    for (const label of ["Tasks completed", "Tasks created", "Active agents", "Total cost", "Top performer"]) {
      expect(json).toContain(label);
    }
    expect(json).toContain("$12.34"); // cost
    expect(json).toContain("Ada (1)"); // top performer
  });

  it("builds a compact 'no activity' card when the window is empty (AC #2)", () => {
    const card = buildDigestCard(emptyRollup(0));
    expect(validateAdaptiveCard(card)).toEqual({ ok: true, errors: [] });
    expect(JSON.stringify(card)).toContain("No agent activity");
    // no FactSet on the empty card
    expect(card.body.some((e) => e.type === "FactSet")).toBe(false);
  });
});

describe("extractCostCents (PCLIP-21)", () => {
  it("reads cents fields; converts a dollar amount; ignores missing", () => {
    expect(extractCostCents({ payload: { costCents: 250 } })).toBe(250);
    expect(extractCostCents({ payload: { cost_cents: 99 } })).toBe(99);
    expect(extractCostCents({ payload: { cost: { costCents: 5 } } })).toBe(5);
    expect(extractCostCents({ payload: { amount: 1.5 } })).toBe(150); // dollars → cents
    expect(extractCostCents({ payload: {} })).toBeUndefined();
  });
});
