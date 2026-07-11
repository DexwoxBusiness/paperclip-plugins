/**
 * Generic "post to a channel" surface for ChatOS (T13) — pure, SDK-decoupled logic.
 *
 * A Paperclip agent uses `post_to_channel` to drop a message or an interactive prompt-card into a
 * Teams CHANNEL, `list_channel_members` to read the channel roster, and `get_channel_responses` to
 * read back who answered. Unlike `ask_person` (1:1, a single answer routed back to the agent), a
 * channel post can collect MANY submits — one per person — which the AGENT aggregates however it
 * likes.
 *
 * Deliberately scrum-agnostic: no standup / roster / non-responder vocabulary lives here. The plugin
 * only carries the message, reads the roster, and tracks who submitted. The agent decides the
 * cadence, who to expect, and how to consolidate. Mirrors the ask.ts conventions.
 */

import { adaptiveCard, inputText, submitAction, textBlock, type AdaptiveCard, type CardAction, type CardElement, type MsTeamsMentionEntity } from "./adaptive-card.js";
import { sanitizeCardText, sanitizeInputPrefill } from "./card-safety.js";
import { type AskField } from "./ask.js"; // reuse the structured-input shape (id/label/multiline/placeholder/prefill)

export type ChannelPostStatus = "open" | "closed";

/** One person's submit against a collecting channel post. */
export interface ChannelResponse {
  /** Who answered: `teams:{aadObjectId}` when known, else a channel-scoped id. */
  by: string;
  /** Their Teams display name (caller sanitizes before display). */
  byName?: string;
  /** field id -> submitted text. */
  values: Record<string, string>;
  atMs: number;
}

/** A channel post persisted in the ledger. `responses` maps each responder `by` -> their submit. */
export interface ChannelPost {
  id: string;
  /** The channel's stored conversation key the agent targeted. */
  channelRef: string;
  /** The requesting agent + company (from ToolRunContext) — the ownership scope. */
  agentId: string;
  companyId: string;
  /** Prompt / message text. */
  prompt: string;
  /** Optional structured inputs to collect (reuses the ask field shape). */
  fields?: AskField[];
  /** True => card carries inputs + Submit and responses are collected; false => plain announcement. */
  collect: boolean;
  /** The agent's own correlation key (e.g. `standup:2026-07-10-am`) so it can tie responses together. */
  correlationId?: string;
  status: ChannelPostStatus;
  createdAtMs: number;
  /** Keyed by responder `by` (one entry per person; a re-submit overwrites the prior one). */
  responses: Record<string, ChannelResponse>;
}

/** Caps mirroring the ask surface so an agent-supplied post can't build an oversized card. */
export const MAX_CHANNEL_FIELDS = 8;

// Submit payload discriminator + the input-id prefix that separates collected field values from the
// hidden action data in the merged `activity.value` bag. The discriminator ("chpost") is distinct
// from the ask surface ("ask"), so the two never collide even though both use the `f_` field prefix.
const CHANNEL_PC_ACTION = "chpost";
const FIELD_PREFIX = "f_";
/** The default single-field id used when the agent supplies no explicit `fields`. */
export const CHANNEL_DEFAULT_FIELD_ID = "answer";

export interface ChannelSubmitData {
  pcAction: typeof CHANNEL_PC_ACTION;
  postId: string;
  [key: string]: unknown;
}
function submitData(postId: string): ChannelSubmitData {
  return { pcAction: CHANNEL_PC_ACTION, postId };
}

/** A raw Teams member as returned by the connector roster read (superset-tolerant). */
export interface RawChannelMember {
  id?: string;
  aadObjectId?: string;
  objectId?: string;
  name?: string;
  givenName?: string;
  surname?: string;
  email?: string;
  userPrincipalName?: string;
  [k: string]: unknown;
}

/** Normalized member the agent gets back: a stable id, a display name, and a lowercased email. */
export interface ChannelMember {
  /** Entra object id (aadObjectId) when present, else the channel-scoped member id. */
  id: string;
  name: string;
  /** Lowercased for case-insensitive joins (Plane stores emails lowercased). "" when unknown. */
  email: string;
}

/**
 * Normalize a connector roster into stable `{id,name,email}`. Email is lowercased so an agent can
 * join it to Plane/others case-insensitively; a member with neither an Entra id nor a member id is
 * dropped (there is nothing to address them by). Pure over its input; tolerant of a non-array.
 */
export function normalizeMembers(raw: unknown): ChannelMember[] {
  if (!Array.isArray(raw)) return [];
  const out: ChannelMember[] = [];
  for (const m of raw) {
    if (!m || typeof m !== "object") continue;
    const r = m as RawChannelMember;
    const id = String(r.aadObjectId ?? r.objectId ?? r.id ?? "").trim();
    if (!id) continue;
    const email = String(r.email ?? r.userPrincipalName ?? "").trim().toLowerCase();
    const name = String(r.name ?? [r.givenName, r.surname].filter(Boolean).join(" ") ?? "").trim() || email || id;
    out.push({ id, name, email });
  }
  return out;
}

// --------------------------------------------------------------------------
// @-mentions (real Teams notifications inside a bot-posted Adaptive Card)
// --------------------------------------------------------------------------

/** A person to @-mention, resolved to a Teams mention id + display name. */
export interface ChannelMention {
  /** Teams mention id: the `29:…` member id (preferred), else the Entra Object ID / UPN. */
  id: string;
  name: string;
}

/** Cap the number of mentions so one post can't build an oversized entities list / notify-storm. */
export const MAX_MENTIONS = 20;

// Control chars (built from a string so the source stays ASCII).
const MENTION_CONTROL = new RegExp("[\\u0000-\\u001F\\u007F]", "g");

/** The name shown inside `<at>…</at>`: angle brackets + controls removed (they'd break the tag), capped. */
function atName(name: string): string {
  const cleaned = String(name ?? "").replace(/[<>]/g, "").replace(MENTION_CONTROL, " ").trim();
  return (cleaned.length > 64 ? cleaned.slice(0, 64) : cleaned) || "member";
}

/**
 * Resolve an agent-supplied list of people (emails OR ids from `list_channel_members`) against the
 * channel roster into real Teams mentions. Pure over the RAW connector roster so it is unit-testable.
 *
 * Matching is case-insensitive against a member's email/UPN, their Entra Object ID, and their `29:`
 * member id. The mention id itself prefers the `29:` member id (universally accepted), falling back
 * to the Entra Object ID. Deduped by mention id.
 *
 * No requested (non-blank) entry is ever silently dropped: each lands in exactly one bucket —
 *  - `resolved`   — matched a current member and within the {@link MAX_MENTIONS} cap (actually pinged),
 *  - `unresolved` — didn't match any current member (never guessed / fabricated),
 *  - `skipped`    — matched a real member but beyond the cap, so NOT pinged,
 *  - `duplicate`  — a repeat of a person already counted above (e.g. the same person by email AND id);
 *                   collapsed to one mention, so this entry did not add another (their ping status is
 *                   whatever their FIRST occurrence got — resolved or skipped).
 * The caller surfaces `unresolved` + `skipped` so a `posted:true` never hides an un-pinged person.
 */
export function resolveChannelMentions(
  rawMembers: unknown,
  requested: readonly string[],
): { resolved: ChannelMention[]; unresolved: string[]; skipped: string[]; duplicate: string[] } {
  const members = Array.isArray(rawMembers) ? rawMembers : [];
  const byKey = new Map<string, { id: string; name: string }>();
  for (const m of members) {
    if (!m || typeof m !== "object") continue;
    const r = m as RawChannelMember;
    // Mention id: the 29: member id is the classic, universally-accepted mention target.
    const mentionId = String(r.id ?? r.aadObjectId ?? r.objectId ?? "").trim();
    if (!mentionId) continue;
    const name = String(r.name ?? [r.givenName, r.surname].filter(Boolean).join(" ") ?? "").trim() || mentionId;
    const entry = { id: mentionId, name };
    for (const key of [r.email, r.userPrincipalName, r.aadObjectId, r.objectId, r.id]) {
      const k = String(key ?? "").trim().toLowerCase();
      if (k) byKey.set(k, entry);
    }
  }
  const resolved: ChannelMention[] = [];
  const unresolved: string[] = [];
  const skipped: string[] = [];
  const duplicate: string[] = [];
  const seen = new Set<string>();
  for (const req of requested) {
    const key = String(req ?? "").trim().toLowerCase();
    if (!key) continue; // blank input is not an addressable request (the tool also pre-filters these)
    const hit = byKey.get(key);
    if (!hit) {
      unresolved.push(String(req));
      continue;
    }
    if (seen.has(hit.id)) {
      duplicate.push(String(req)); // repeat of an already-counted person — surfaced, never silently dropped
      continue;
    }
    seen.add(hit.id);
    if (resolved.length >= MAX_MENTIONS) {
      skipped.push(String(req)); // valid member, but over the cap — surfaced, never silently dropped
      continue;
    }
    resolved.push({ id: hit.id, name: atName(hit.name) });
  }
  return { resolved, unresolved, skipped, duplicate };
}

/**
 * Build the `<at>…</at>` runs + matching `msteams.entities` for a set of mentions, or null when there
 * is nothing to mention. The entity `text` is byte-identical to the run in the card body (Teams
 * requires the exact match), so both come from the same {@link atName}-cleaned display name.
 */
function renderMentions(mentions: readonly ChannelMention[] | undefined): { atRuns: string; entities: MsTeamsMentionEntity[] } | null {
  if (!mentions || mentions.length === 0) return null;
  const runs: string[] = [];
  const entities: MsTeamsMentionEntity[] = [];
  const seen = new Set<string>();
  for (const m of mentions) {
    const id = String(m?.id ?? "").trim();
    if (!id || seen.has(id)) continue;
    seen.add(id);
    const name = atName(m.name);
    const at = `<at>${name}</at>`;
    runs.push(at);
    entities.push({ type: "mention", text: at, mentioned: { id, name } });
  }
  return entities.length ? { atRuns: runs.join(" "), entities } : null;
}

/** A subtle "cc:" TextBlock carrying the mention runs. Its text is built from `<at>` tags directly
 * (NOT via sanitizeCardText, which would escape the angle brackets), with names already cleaned. */
function mentionLine(atRuns: string): CardElement {
  return textBlock(`cc: ${atRuns}`, { wrap: true, isSubtle: true, spacing: "Medium" });
}

/** The fields to render — the agent's list (capped), or a single default multiline answer field. */
export function effectiveChannelFields(post: Pick<ChannelPost, "fields">): AskField[] {
  const fields = (post.fields ?? []).filter((f) => f && typeof f.id === "string" && f.id.trim()).slice(0, MAX_CHANNEL_FIELDS);
  if (fields.length > 0) return fields;
  return [{ id: CHANNEL_DEFAULT_FIELD_ID, label: "Your update", multiline: true }];
}

/** A plain announcement card (no inputs, no actions) — e.g. a consolidated report the agent built.
 * When `mentions` are supplied, a subtle "cc:" line of real @-mentions is appended and the matching
 * `msteams.entities` are stamped on the card so Teams notifies each mentioned person. */
export function buildAnnouncementCard(text: string, opts: { heading?: string; mentions?: ChannelMention[] } = {}): AdaptiveCard {
  const body: CardElement[] = [];
  if (opts.heading) body.push(textBlock(sanitizeCardText(opts.heading, 200), { weight: "Bolder", size: "Large" }));
  body.push(textBlock(sanitizeCardText(text), { wrap: true }));
  const mentions = renderMentions(opts.mentions);
  if (mentions) body.push(mentionLine(mentions.atRuns));
  const card = adaptiveCard(body);
  if (mentions) card.msteams = { ...card.msteams, entities: mentions.entities };
  return card;
}

/**
 * The interactive prompt card: the prompt, then a labeled editable input per field, and a single
 * "Send" button whose Submit carries the postId. All display text is Markdown-sanitized; prefills
 * are control-safe-stripped (an Input.Text value round-trips verbatim).
 */
export function buildChannelPromptCard(post: ChannelPost, opts: { mentions?: ChannelMention[] } = {}): AdaptiveCard {
  const body: CardElement[] = [textBlock(sanitizeCardText(post.prompt), { weight: "Bolder", wrap: true })];
  const mentions = renderMentions(opts.mentions);
  if (mentions) body.push(mentionLine(mentions.atRuns)); // after the prompt, before the inputs
  for (const f of effectiveChannelFields(post)) {
    body.push(textBlock(sanitizeCardText(f.label || f.id, 120), { weight: "Bolder", spacing: "Medium", isSubtle: true }));
    body.push(
      inputText(`${FIELD_PREFIX}${f.id}`, {
        value: sanitizeInputPrefill(f.prefill),
        isMultiline: f.multiline ?? false,
        placeholder: f.placeholder ? sanitizeCardText(f.placeholder, 120) : undefined,
      }),
    );
  }
  const actions: CardAction[] = [submitAction("Send", submitData(post.id))];
  const card = adaptiveCard(body, actions);
  if (mentions) card.msteams = { ...card.msteams, entities: mentions.entities };
  return card;
}

/** The card shown once the agent closes a collecting post (inputs + actions removed). */
export function buildChannelClosedCard(post: ChannelPost, opts: { note?: string } = {}): AdaptiveCard {
  return adaptiveCard([
    textBlock(sanitizeCardText(opts.note || "✅ This round is closed.", 200), { weight: "Bolder" }),
    textBlock(sanitizeCardText(post.prompt), { isSubtle: true, wrap: true }),
  ]);
}

/**
 * Parse an inbound Action.Submit value into a channel-post response, or null when the activity is
 * not one of our channel submits. Collects every `f_*` input into `values` keyed by the field id
 * (prefix stripped), trimmed. Returns null when there is no postId or no non-empty value.
 */
export function parseChannelSubmit(value: unknown): { postId: string; values: Record<string, string> } | null {
  if (!value || typeof value !== "object") return null;
  const v = value as Record<string, unknown>;
  if (v.pcAction !== CHANNEL_PC_ACTION) return null;
  const postId = typeof v.postId === "string" ? v.postId.trim() : "";
  if (!postId) return null;
  const values: Record<string, string> = {};
  for (const [key, raw] of Object.entries(v)) {
    if (!key.startsWith(FIELD_PREFIX)) continue;
    const text = typeof raw === "string" ? raw.trim() : "";
    if (text) values[key.slice(FIELD_PREFIX.length)] = text;
  }
  if (Object.keys(values).length === 0) return null; // empty submit — nothing collected
  return { postId, values };
}
