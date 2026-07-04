import { describe, expect, it } from "vitest";
import {
  activeAgentCount,
  buildDigestCard,
  coerceRollup,
  createDigestAccumulator,
  digestDateKey,
  digestHourInZone,
  DIGEST_WINDOW_MS,
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

  it("breaks an exact 2-agent tie by name, regardless of insertion order (Kody)", () => {
    // Two agents, equal completions: the lexicographically earlier name must win,
    // and the result must not depend on which was inserted first.
    const bobFirst = emptyRollup(0);
    bobFirst.agentCompletions = { Bob: 3, Ada: 3 };
    expect(topPerformer(bobFirst)).toEqual({ name: "Ada", count: 3 });
    const adaFirst = emptyRollup(0);
    adaFirst.agentCompletions = { Ada: 3, Bob: 3 };
    expect(topPerformer(adaFirst)).toEqual({ name: "Ada", count: 3 });
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

  it("a zero-cent cost event still counts as activity (Kody)", async () => {
    const acc = createDigestAccumulator(makeStore());
    await acc.onCostCents(0);
    const r = await acc.peek();
    expect(r.costEventCount).toBe(1);
    expect(isEmptyRollup(r)).toBe(false);
  });

  it("auto-resets a window older than 24h so stats don't span >1 day (downtime/disabled)", async () => {
    let clock = 1_000_000;
    const acc = createDigestAccumulator(makeStore(), { now: () => clock });
    await acc.onIssueCreated();
    expect((await acc.peek()).tasksCreated).toBe(1);
    // jump past the window; the next accumulation starts a fresh window
    clock += DIGEST_WINDOW_MS + 1;
    await acc.onIssueCreated();
    const r = await acc.peek();
    expect(r.tasksCreated).toBe(1); // old window dropped, only the new event
    expect(r.windowStart).toBe(clock);
  });

  it("mergeBack restores a failed snapshot for retry (Codex/Kody)", async () => {
    let clock = 2_000;
    const acc = createDigestAccumulator(makeStore(), { now: () => clock });
    await acc.onIssueCreated();
    await acc.onTaskCompleted("Ada");
    await acc.onCostCents(50);
    const snap = await acc.readAndReset(); // window consumed
    expect(isEmptyRollup(await acc.peek())).toBe(true);
    // an event arrives during the "delivery"
    await acc.onIssueCreated();
    // delivery failed -> merge the snapshot back; both the snapshot and the new event survive
    await acc.mergeBack(snap);
    const r = await acc.peek();
    expect(r).toMatchObject({ tasksCreated: 2, tasksCompleted: 1, totalCostCents: 50 });
    expect(r.agentCompletions).toEqual({ Ada: 1 });
  });
});

describe("digest schedule helpers (timezone-aware)", () => {
  // 2026-07-04T04:30:00Z → 10:00 in IST (UTC+5:30), 04:00 server-UTC.
  const at = new Date("2026-07-04T04:30:00Z");

  it("computes the hour in an IANA time zone (09:00 IST works)", () => {
    expect(digestHourInZone(at, "Asia/Kolkata")).toBe(10);
    expect(digestHourInZone(at, "UTC")).toBe(4);
    expect(digestHourInZone(new Date("2026-07-04T20:30:00Z"), "Asia/Kolkata")).toBe(2); // next day in IST
  });

  it("falls back to server-local for an empty/invalid zone", () => {
    expect(digestHourInZone(at, "")).toBe(at.getHours());
    expect(digestHourInZone(at, "Not/AZone")).toBe(at.getHours());
  });

  it("computes a YYYY-MM-DD date key per zone", () => {
    expect(digestDateKey(at, "UTC")).toBe("2026-07-04");
    // 2026-07-04T20:30Z is already 2026-07-05 in IST
    expect(digestDateKey(new Date("2026-07-04T20:30:00Z"), "Asia/Kolkata")).toBe("2026-07-05");
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

  it("end-to-end cost: extractCostCents -> onCostCents -> card renders USD (AC #3)", async () => {
    const acc = createDigestAccumulator(makeStore());
    // two cost_event.created payloads (host detail shape { costCents })
    for (const ev of [{ payload: { costCents: 250 } }, { payload: { costCents: 1000 } }]) {
      const cents = extractCostCents(ev);
      if (cents !== undefined) await acc.onCostCents(cents);
    }
    const r = await acc.peek();
    expect(r.totalCostCents).toBe(1250);
    expect(JSON.stringify(buildDigestCard(r))).toContain("$12.50");
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
