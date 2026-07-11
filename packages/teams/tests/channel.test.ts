import { describe, expect, it } from "vitest";
import { validateAdaptiveCard } from "../src/adaptive-card.js";
import {
  buildAnnouncementCard,
  buildChannelClosedCard,
  buildChannelPromptCard,
  CHANNEL_DEFAULT_FIELD_ID,
  effectiveChannelFields,
  MAX_CHANNEL_FIELDS,
  MAX_MENTIONS,
  normalizeMembers,
  parseChannelSubmit,
  resolveChannelMentions,
  type ChannelPost,
} from "../src/channel.js";

function post(overrides: Partial<ChannelPost> = {}): ChannelPost {
  return {
    id: "chpost-1",
    channelRef: "19:abc@thread.tacv2",
    agentId: "agent-1",
    companyId: "co-1",
    prompt: "Morning standup — what's your plan?",
    collect: true,
    status: "open",
    createdAtMs: 0,
    responses: {},
    ...overrides,
  };
}

describe("normalizeMembers", () => {
  it("maps aadObjectId/name/email, lowercases email, tolerates the raw connector shape", () => {
    const raw = [
      { id: "29:xyz", aadObjectId: "AAD-1", name: "Diwakar M", email: "Diwakar.MA@Dexwox.com" },
      { id: "29:pqr", objectId: "AAD-2", givenName: "Ferin", surname: "C", userPrincipalName: "ferin.c@dexwox.com" },
    ];
    expect(normalizeMembers(raw)).toEqual([
      { id: "AAD-1", name: "Diwakar M", email: "diwakar.ma@dexwox.com" },
      { id: "AAD-2", name: "Ferin C", email: "ferin.c@dexwox.com" },
    ]);
  });
  it("falls back id: aadObjectId → objectId → id; name: name → given+surname → email → id", () => {
    expect(normalizeMembers([{ id: "29:only" }])).toEqual([{ id: "29:only", name: "29:only", email: "" }]);
    expect(normalizeMembers([{ aadObjectId: "AAD", email: "x@y.com" }])).toEqual([{ id: "AAD", name: "x@y.com", email: "x@y.com" }]);
  });
  it("drops members with no addressable id; tolerates a non-array", () => {
    expect(normalizeMembers([{ name: "no id" }, null, "nope"])).toEqual([]);
    expect(normalizeMembers(undefined)).toEqual([]);
    expect(normalizeMembers({} as unknown)).toEqual([]);
  });
});

describe("effectiveChannelFields", () => {
  it("defaults to a single multiline answer field when none supplied", () => {
    expect(effectiveChannelFields({ fields: undefined })).toEqual([{ id: CHANNEL_DEFAULT_FIELD_ID, label: "Your update", multiline: true }]);
  });
  it("filters id-less fields and caps at MAX_CHANNEL_FIELDS", () => {
    const many = Array.from({ length: MAX_CHANNEL_FIELDS + 3 }, (_, i) => ({ id: `f${i}`, label: `L${i}` }));
    const withBad = [{ label: "no id" } as { id: string; label: string }, ...many];
    const out = effectiveChannelFields({ fields: withBad });
    expect(out).toHaveLength(MAX_CHANNEL_FIELDS);
    expect(out[0].id).toBe("f0");
  });
});

describe("buildChannelPromptCard", () => {
  it("is a schema-valid v1.5 card: prompt + input per field + a Send Submit carrying the postId", () => {
    const card = buildChannelPromptCard(post({ fields: [{ id: "plan", label: "Today's plan", multiline: true }] }));
    expect(validateAdaptiveCard(card).ok).toBe(true);
    // exactly one Submit action, titled Send
    expect(card.actions).toHaveLength(1);
    expect(card.actions?.[0].type).toBe("Action.Submit");
    expect(card.actions?.[0].title).toBe("Send");
    // the submit data is the chpost discriminator + this post's id
    expect((card.actions?.[0].data as Record<string, unknown>).pcAction).toBe("chpost");
    expect((card.actions?.[0].data as Record<string, unknown>).postId).toBe("chpost-1");
    // an Input.Text is rendered for the field, id prefixed f_
    expect(JSON.stringify(card.body)).toContain('"f_plan"');
  });
});

describe("buildAnnouncementCard", () => {
  it("renders heading + text and carries NO actions (nothing to submit)", () => {
    const card = buildAnnouncementCard("All 8 replied ✅", { heading: "Evening report" });
    expect(validateAdaptiveCard(card).ok).toBe(true);
    expect(card.actions).toBeUndefined();
    expect(JSON.stringify(card.body)).toContain("Evening report");
  });
});

describe("buildChannelClosedCard", () => {
  it("is valid and carries no actions", () => {
    const card = buildChannelClosedCard(post());
    expect(validateAdaptiveCard(card).ok).toBe(true);
    expect(card.actions).toBeUndefined();
  });
});

describe("parseChannelSubmit", () => {
  it("parses a chpost submit: strips the f_ prefix, trims, keeps non-empty values", () => {
    expect(parseChannelSubmit({ pcAction: "chpost", postId: "chpost-1", f_plan: "  ship X  ", f_blockers: "" })).toEqual({
      postId: "chpost-1",
      values: { plan: "ship X" },
    });
  });
  it("returns null for a non-channel submit, a missing postId, or an empty submit", () => {
    expect(parseChannelSubmit({ pcAction: "ask", requestId: "x", f_a: "y" })).toBeNull(); // ask discriminator, not ours
    expect(parseChannelSubmit({ pcAction: "chpost", f_a: "y" })).toBeNull(); // no postId
    expect(parseChannelSubmit({ pcAction: "chpost", postId: "chpost-1", f_a: "   " })).toBeNull(); // nothing non-empty
    expect(parseChannelSubmit(null)).toBeNull();
    expect(parseChannelSubmit("nope")).toBeNull();
  });
});

// A roster row as the Teams connector returns it: a 29: member id + an Entra id + email.
const roster = [
  { id: "29:diwakar", aadObjectId: "aad-diwakar", name: "Diwakar MA", email: "Diwakar.MA@dexwox.com" },
  { id: "29:ferin", aadObjectId: "aad-ferin", name: "Ferin C", userPrincipalName: "ferin.c@dexwox.com" },
  { id: "29:guest", name: "External Guest" }, // no email / aad — still mentionable by 29: id
];

describe("resolveChannelMentions", () => {
  it("matches by email case-insensitively and mentions by the 29: member id", () => {
    const { resolved, unresolved } = resolveChannelMentions(roster, ["diwakar.ma@DEXWOX.com"]);
    expect(unresolved).toEqual([]);
    expect(resolved).toEqual([{ id: "29:diwakar", name: "Diwakar MA" }]);
  });

  it("matches by UPN, by Entra object id, and by the 29: id", () => {
    expect(resolveChannelMentions(roster, ["ferin.c@dexwox.com"]).resolved[0].id).toBe("29:ferin");
    expect(resolveChannelMentions(roster, ["aad-diwakar"]).resolved[0].id).toBe("29:diwakar");
    expect(resolveChannelMentions(roster, ["29:guest"]).resolved[0]).toEqual({ id: "29:guest", name: "External Guest" });
  });

  it("reports unknown people as unresolved (never fabricates a mention)", () => {
    const { resolved, unresolved } = resolveChannelMentions(roster, ["nobody@dexwox.com", "ferin.c@dexwox.com"]);
    expect(resolved.map((m) => m.id)).toEqual(["29:ferin"]);
    expect(unresolved).toEqual(["nobody@dexwox.com"]);
  });

  it("dedupes when the same person is requested twice (email + id)", () => {
    const { resolved } = resolveChannelMentions(roster, ["diwakar.ma@dexwox.com", "aad-diwakar", "29:diwakar"]);
    expect(resolved).toEqual([{ id: "29:diwakar", name: "Diwakar MA" }]);
  });

  it("returns everything unresolved when the roster is unreadable (non-array)", () => {
    expect(resolveChannelMentions(null, ["x@y.com"])).toEqual({ resolved: [], unresolved: ["x@y.com"] });
    expect(resolveChannelMentions(undefined, [])).toEqual({ resolved: [], unresolved: [] });
  });

  it("caps the number of mentions at MAX_MENTIONS", () => {
    const big = Array.from({ length: MAX_MENTIONS + 5 }, (_, i) => ({ id: `29:u${i}`, email: `u${i}@x.com`, name: `U${i}` }));
    const req = big.map((m) => m.email);
    expect(resolveChannelMentions(big, req).resolved).toHaveLength(MAX_MENTIONS);
  });
});

describe("channel cards with @-mentions", () => {
  const mentions = [
    { id: "29:diwakar", name: "Diwakar MA" },
    { id: "29:ferin", name: "Ferin C" },
  ];

  it("announcement card renders <at> runs + matching msteams.entities and stays valid", () => {
    const card = buildAnnouncementCard("Hi team", { mentions });
    expect(validateAdaptiveCard(card).ok).toBe(true);
    // one entity per mention, each mentioning the correct id
    expect(card.msteams?.entities).toEqual([
      { type: "mention", text: "<at>Diwakar MA</at>", mentioned: { id: "29:diwakar", name: "Diwakar MA" } },
      { type: "mention", text: "<at>Ferin C</at>", mentioned: { id: "29:ferin", name: "Ferin C" } },
    ]);
    // the entity.text must appear byte-identical in a body TextBlock (Teams requires the exact match)
    const cc = card.body.find((b) => typeof b.text === "string" && (b.text as string).startsWith("cc:"));
    expect(cc?.text).toBe("cc: <at>Diwakar MA</at> <at>Ferin C</at>");
  });

  it("prompt card keeps its inputs + Send and adds the mention line + entities", () => {
    const card = buildChannelPromptCard(post(), { mentions });
    expect(validateAdaptiveCard(card).ok).toBe(true);
    expect(card.actions?.[0]).toMatchObject({ type: "Action.Submit", title: "Send" });
    expect(card.body.some((b) => b.type === "Input.Text")).toBe(true);
    expect(card.msteams?.entities).toHaveLength(2);
  });

  it("no mentions → no entities (unchanged, backward-compatible card)", () => {
    expect(buildAnnouncementCard("Hi", {}).msteams?.entities).toBeUndefined();
    expect(buildChannelPromptCard(post()).msteams?.entities).toBeUndefined();
    expect(buildAnnouncementCard("Hi", { mentions: [] }).msteams?.entities).toBeUndefined();
  });

  it("strips angle brackets from a display name so a crafted name can't break the <at> tag", () => {
    const card = buildAnnouncementCard("hi", { mentions: [{ id: "29:x", name: "Ev<il>Name" }] });
    expect(card.msteams?.entities?.[0]).toEqual({ type: "mention", text: "<at>EvilName</at>", mentioned: { id: "29:x", name: "EvilName" } });
    expect(validateAdaptiveCard(card).ok).toBe(true);
  });
});
