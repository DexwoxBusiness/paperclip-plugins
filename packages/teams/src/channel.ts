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

import { adaptiveCard, inputText, submitAction, textBlock, type AdaptiveCard, type CardAction, type CardElement } from "./adaptive-card.js";
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

/** The fields to render — the agent's list (capped), or a single default multiline answer field. */
export function effectiveChannelFields(post: Pick<ChannelPost, "fields">): AskField[] {
  const fields = (post.fields ?? []).filter((f) => f && typeof f.id === "string" && f.id.trim()).slice(0, MAX_CHANNEL_FIELDS);
  if (fields.length > 0) return fields;
  return [{ id: CHANNEL_DEFAULT_FIELD_ID, label: "Your update", multiline: true }];
}

/** A plain announcement card (no inputs, no actions) — e.g. a consolidated report the agent built. */
export function buildAnnouncementCard(text: string, opts: { heading?: string } = {}): AdaptiveCard {
  const body: CardElement[] = [];
  if (opts.heading) body.push(textBlock(sanitizeCardText(opts.heading, 200), { weight: "Bolder", size: "Large" }));
  body.push(textBlock(sanitizeCardText(text), { wrap: true }));
  return adaptiveCard(body);
}

/**
 * The interactive prompt card: the prompt, then a labeled editable input per field, and a single
 * "Send" button whose Submit carries the postId. All display text is Markdown-sanitized; prefills
 * are control-safe-stripped (an Input.Text value round-trips verbatim).
 */
export function buildChannelPromptCard(post: ChannelPost): AdaptiveCard {
  const body: CardElement[] = [textBlock(sanitizeCardText(post.prompt), { weight: "Bolder", wrap: true })];
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
  return adaptiveCard(body, actions);
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
