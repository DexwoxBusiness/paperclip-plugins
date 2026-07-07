/**
 * Generic "ask a person" surface (PCLIP-43 / T12) — pure, SDK-decoupled logic.
 *
 * A Paperclip agent calls the `ask_person` tool with a person, a prompt, and optional structured
 * fields; the plugin posts an Adaptive Card to that person's 1:1 conversation and, when they
 * answer, routes the response back to the requesting agent via `ctx.agents.invoke`. This module
 * holds the pure pieces (request shape, card builders, submit parsing, response formatting); the
 * worker owns tool registration, the proactive post, `agents.invoke`, state, and the bot routing.
 *
 * Deliberately scrum-agnostic: no standup/planning/grooming vocabulary lives here. The agent
 * decides what a question means and when to re-ask; the plugin only carries it and tracks answers.
 */

import { adaptiveCard, inputText, submitAction, textBlock, type AdaptiveCard, type CardAction, type CardElement } from "./adaptive-card.js";
import { sanitizeCardText, sanitizeInputPrefill } from "./card-safety.js";

export type AskStatus = "open" | "answered" | "cancelled";

/** One structured input the agent wants collected. Rendered as an Input.Text (v1). */
export interface AskField {
  /** Stable field key the agent gets back in the response map. */
  id: string;
  label: string;
  multiline?: boolean;
  placeholder?: string;
  /** Optional prefilled value (control-safe-stripped, verbatim otherwise). */
  prefill?: string;
}

/** A request persisted in the ledger. `response` maps each field id → the submitted text. */
export interface AskRequest {
  id: string;
  /** Opaque Teams person / 1:1 conversation key the agent supplied (v1 — no Plane mapping yet). */
  personRef: string;
  /** The requesting agent + company (from ToolRunContext) — the route-back target. */
  agentId: string;
  companyId: string;
  prompt: string;
  fields?: AskField[];
  /** The agent's own correlation key (e.g. `plane:<id>`) so it can tie the answer to a work item. */
  correlationId?: string;
  status: AskStatus;
  createdAtMs: number;
  answeredAtMs?: number;
  /** Who answered: `teams:{aadObjectId}` when known. */
  answeredBy?: string;
  response?: Record<string, string>;
}

/** Caps mirroring the escalation surface so an agent-supplied ask can't build an oversized card. */
export const MAX_ASK_FIELDS = 8;

// Submit payload discriminator + the input-id prefix that separates collected field values from
// the hidden action data in the merged `activity.value` bag.
const ASK_PC_ACTION = "ask";
const FIELD_PREFIX = "f_";
/** The default single-field id used when the agent supplies no explicit `fields`. */
export const ASK_DEFAULT_FIELD_ID = "answer";

export interface AskSubmitData {
  pcAction: typeof ASK_PC_ACTION;
  requestId: string;
  [key: string]: unknown;
}

function submitData(requestId: string): AskSubmitData {
  return { pcAction: ASK_PC_ACTION, requestId };
}

/** The fields to render — the agent's list (capped), or a single default multiline answer field. */
export function effectiveFields(request: Pick<AskRequest, "fields">): AskField[] {
  const fields = (request.fields ?? []).filter((f) => f && typeof f.id === "string" && f.id.trim()).slice(0, MAX_ASK_FIELDS);
  if (fields.length > 0) return fields;
  return [{ id: ASK_DEFAULT_FIELD_ID, label: "Your answer", multiline: true }];
}

/**
 * The ask card: the prompt, then a labeled editable input per field, and a single "Send" button.
 * All display text is Markdown-sanitized; prefills are control-safe-stripped (not Markdown-escaped,
 * since an Input.Text value is round-tripped verbatim).
 */
export function buildAskCard(request: AskRequest): AdaptiveCard {
  const body: CardElement[] = [textBlock(sanitizeCardText(request.prompt), { weight: "Bolder", wrap: true })];
  for (const f of effectiveFields(request)) {
    body.push(textBlock(sanitizeCardText(f.label || f.id, 120), { weight: "Bolder", spacing: "Medium", isSubtle: true }));
    body.push(
      inputText(`${FIELD_PREFIX}${f.id}`, {
        value: sanitizeInputPrefill(f.prefill),
        isMultiline: f.multiline ?? false,
        placeholder: f.placeholder ? sanitizeCardText(f.placeholder, 120) : undefined,
      }),
    );
  }
  const actions: CardAction[] = [submitAction("Send", submitData(request.id))];
  return adaptiveCard(body, actions);
}

/** The card shown once answered — actions removed, a short confirmation + the prompt echoed. */
export function buildAskAnsweredCard(request: AskRequest, opts: { byName?: string } = {}): AdaptiveCard {
  // byName is a Teams display name — sanitize it (Markdown injection guard), like the escalation card.
  const by = opts.byName ? ` by ${sanitizeCardText(opts.byName, 120)}` : "";
  return adaptiveCard([
    textBlock(`✅ Answered${by}`, { weight: "Bolder" }),
    textBlock(sanitizeCardText(request.prompt), { isSubtle: true, wrap: true }),
  ]);
}

/** The card shown when the agent cancels an outstanding ask (actions removed). */
export function buildAskCancelledCard(request: AskRequest): AdaptiveCard {
  return adaptiveCard([
    textBlock("🚫 No longer needed", { weight: "Bolder" }),
    textBlock(sanitizeCardText(request.prompt), { isSubtle: true, wrap: true }),
  ]);
}

/**
 * Parse an inbound Action.Submit value into an ask answer, or null when the activity is not one of
 * our ask submits. Collects every `f_*` input into `values` keyed by the field id (prefix stripped),
 * trimmed. Returns null when there is no requestId or no non-empty value (nothing was answered).
 */
export function parseAskSubmit(value: unknown): { requestId: string; values: Record<string, string> } | null {
  if (!value || typeof value !== "object") return null;
  const v = value as Record<string, unknown>;
  if (v.pcAction !== ASK_PC_ACTION) return null;
  const requestId = typeof v.requestId === "string" ? v.requestId.trim() : "";
  if (!requestId) return null;
  const values: Record<string, string> = {};
  for (const [key, raw] of Object.entries(v)) {
    if (!key.startsWith(FIELD_PREFIX)) continue;
    const text = typeof raw === "string" ? raw.trim() : "";
    if (text) values[key.slice(FIELD_PREFIX.length)] = text;
  }
  if (Object.keys(values).length === 0) return null; // empty submit — nothing to route back
  return { requestId, values };
}

/**
 * Format the collected answers into the text routed back to the agent. A single default-field
 * answer renders as just its value; multiple fields render as "label: value" lines (label falls
 * back to the field id). Sanitized so the agent's prompt can't be built into a control string.
 */
export function formatAskResponse(request: AskRequest, values: Record<string, string>): string {
  const fields = effectiveFields(request);
  const entries = Object.entries(values);
  if (entries.length === 1 && entries[0][0] === ASK_DEFAULT_FIELD_ID) {
    return sanitizeCardText(entries[0][1]);
  }
  return entries
    .map(([id, val]) => {
      const label = fields.find((f) => f.id === id)?.label ?? id;
      return `${sanitizeCardText(label, 120)}: ${sanitizeCardText(val)}`;
    })
    .join("\n");
}
