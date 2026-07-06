/**
 * Adaptive Card builders + the Power Automate Workflows envelope (PCLIP-18, v1).
 *
 * Teams renders Adaptive Cards up to ~v1.5, so every card is stamped
 * version "1.5" and uses only <=1.5 element/action types.
 *
 * CRITICAL delivery contract (verified against Microsoft Learn + migration
 * guidance): the legacy O365-connector webhooks were retired May 2026. Power
 * Automate **Workflows** webhooks reject a bare card with HTTP 400 — the card
 * MUST be wrapped in a message envelope:
 *   { type: "message", attachments: [{
 *       contentType: "application/vnd.microsoft.card.adaptive",
 *       contentUrl: null, content: <AdaptiveCard> }] }
 * See {@link toWorkflowsMessage}.
 *
 * SDK-decoupled: pure functions over normalized inputs, so cards are built and
 * schema-validated in unit tests without the plugin runtime.
 */

import { ADAPTIVE_CARD_VERSION } from "./constants.js";

const ADAPTIVE_CARD_SCHEMA = "http://adaptivecards.io/schemas/adaptive-card.json";
const CARD_CONTENT_TYPE = "application/vnd.microsoft.card.adaptive";

/** A minimal, permissive Adaptive Card element (Teams-supported subset). */
export interface CardElement {
  type: string;
  [key: string]: unknown;
}

/** An Adaptive Card action (v1: Action.OpenUrl only; Action.Execute is v2/PCLIP-24). */
export interface CardAction {
  type: string;
  title?: string;
  url?: string;
  [key: string]: unknown;
}

export interface AdaptiveCard {
  $schema: string;
  type: "AdaptiveCard";
  version: string;
  body: CardElement[];
  actions?: CardAction[];
  msteams?: { width?: string };
}

/** The Workflows webhook message envelope (bare cards are 400'd). */
export interface WorkflowsMessage {
  type: "message";
  attachments: Array<{
    contentType: string;
    contentUrl: null;
    content: AdaptiveCard;
  }>;
}

// --------------------------------------------------------------------------
// Element helpers
// --------------------------------------------------------------------------

export function textBlock(
  text: string,
  opts: { size?: string; weight?: string; color?: string; wrap?: boolean; isSubtle?: boolean; spacing?: string } = {},
): CardElement {
  return { type: "TextBlock", text, wrap: opts.wrap ?? true, ...opts };
}

export interface Fact {
  title: string;
  value: string;
}

export function factSet(facts: Fact[]): CardElement {
  // Drop facts with an empty value so a missing field never renders a blank row.
  return { type: "FactSet", facts: facts.filter((f) => f.value !== undefined && f.value !== null && `${f.value}`.trim() !== "") };
}

export function openUrlAction(title: string, url: string): CardAction {
  return { type: "Action.OpenUrl", title, url };
}

/**
 * Input.Text — an editable field whose value is returned in the submit activity's `value` under
 * `id` (merged with the triggering Action.Submit's `data`). Used for the HITL escalation reply so
 * a human can edit the agent's suggestion before sending (PCLIP-28). The `value` prefill is shown
 * verbatim in an edit box (NOT Markdown-rendered), so it is passed through as-is, only length-bounded.
 */
export function inputText(
  id: string,
  opts: { value?: string; isMultiline?: boolean; placeholder?: string; maxLength?: number } = {},
): CardElement {
  return { type: "Input.Text", id, ...opts };
}

/** Action.Submit — a click posts a bot activity carrying `data` (no invoke-response contract). */
export function submitAction(title: string, data: Record<string, unknown>): CardAction {
  return { type: "Action.Submit", title, data };
}

/** Stamp the required root fields onto a card body (+ optional actions). */
export function adaptiveCard(body: CardElement[], actions?: CardAction[]): AdaptiveCard {
  const card: AdaptiveCard = {
    $schema: ADAPTIVE_CARD_SCHEMA,
    type: "AdaptiveCard",
    version: ADAPTIVE_CARD_VERSION,
    body,
    msteams: { width: "Full" },
  };
  if (actions && actions.length) card.actions = actions;
  return card;
}

/** Wrap a card in the Workflows message envelope required by Power Automate. */
export function toWorkflowsMessage(card: AdaptiveCard): WorkflowsMessage {
  return {
    type: "message",
    attachments: [{ contentType: CARD_CONTENT_TYPE, contentUrl: null, content: card }],
  };
}

// --------------------------------------------------------------------------
// Schema validation (AC #2 — "validated against the Adaptive Cards schema")
// --------------------------------------------------------------------------

const SUPPORTED_VERSIONS = new Set(["1.0", "1.1", "1.2", "1.3", "1.4", "1.5"]);
// Allowed actions. Action.Submit is a core v1 action (used for the PCLIP-24 approve/
// reject buttons — a click posts a normal bot activity the plugin handles, with no
// synchronous invoke-response contract). Action.Execute (Universal Actions) is still
// disallowed: it requires an inline HTTP invoke response the host webhook can't return
// (host returns a fixed 200/502 envelope), so we deliberately use Action.Submit instead.
const V1_ACTION_TYPES = new Set(["Action.OpenUrl", "Action.ShowCard", "Action.ToggleVisibility", "Action.Submit"]);

export interface CardValidation {
  ok: boolean;
  errors: string[];
}

/**
 * Validate the structural contract Teams requires of a v1.5 Adaptive Card: the
 * root shape, a supported version (<=1.5), a well-formed body, and valid actions
 * (each typed; OpenUrl carries a non-empty title + http(s) url). Recurses into
 * Container/ColumnSet children so a malformed nested element is caught too.
 */
export function validateAdaptiveCard(card: unknown, path = "card"): CardValidation {
  const errors: string[] = [];
  const c = card as Record<string, unknown> | null;
  if (!c || typeof c !== "object") {
    return { ok: false, errors: [`${path}: not an object`] };
  }
  if (c.type !== "AdaptiveCard") errors.push(`${path}.type must be "AdaptiveCard"`);
  if (typeof c.$schema !== "string" || !c.$schema) errors.push(`${path}.$schema is required`);
  if (typeof c.version !== "string" || !SUPPORTED_VERSIONS.has(c.version)) {
    errors.push(`${path}.version must be one of <=1.5 (got ${JSON.stringify(c.version)})`);
  }
  if (!Array.isArray(c.body)) errors.push(`${path}.body must be an array`);
  else c.body.forEach((el, i) => errors.push(...validateElement(el, `${path}.body[${i}]`)));

  if (c.actions !== undefined) {
    if (!Array.isArray(c.actions)) errors.push(`${path}.actions must be an array`);
    else c.actions.forEach((a, i) => errors.push(...validateAction(a, `${path}.actions[${i}]`)));
  }
  return { ok: errors.length === 0, errors };
}

function validateElement(el: unknown, path: string): string[] {
  const errors: string[] = [];
  const e = el as Record<string, unknown> | null;
  if (!e || typeof e !== "object") return [`${path}: not an object`];
  if (typeof e.type !== "string" || !e.type) errors.push(`${path}.type is required`);
  if (e.type === "TextBlock" && (typeof e.text !== "string" || !e.text)) errors.push(`${path}.text is required for a TextBlock`);
  // Input.Text must carry a non-empty string `id` — that id is the key its value is returned under.
  if (e.type === "Input.Text" && (typeof e.id !== "string" || !e.id)) errors.push(`${path}.id is required for an Input.Text`);
  if (e.type === "FactSet") {
    if (!Array.isArray(e.facts)) errors.push(`${path}.facts must be an array`);
    else
      e.facts.forEach((f, i) => {
        const ff = f as Record<string, unknown> | null;
        if (!ff || typeof ff.title !== "string" || typeof ff.value !== "string") {
          errors.push(`${path}.facts[${i}] needs string title + value`);
        }
      });
  }
  // Recurse into common container elements.
  if (Array.isArray((e as { items?: unknown[] }).items)) {
    (e as { items: unknown[] }).items.forEach((c, i) => errors.push(...validateElement(c, `${path}.items[${i}]`)));
  }
  if (Array.isArray((e as { columns?: unknown[] }).columns)) {
    (e as { columns: unknown[] }).columns.forEach((col, i) => {
      const cc = col as Record<string, unknown> | null;
      if (cc && Array.isArray(cc.items)) cc.items.forEach((it, j) => errors.push(...validateElement(it, `${path}.columns[${i}].items[${j}]`)));
    });
  }
  return errors;
}

function validateAction(a: unknown, path: string): string[] {
  const errors: string[] = [];
  const act = a as Record<string, unknown> | null;
  if (!act || typeof act !== "object") return [`${path}: not an object`];
  if (typeof act.type !== "string" || !act.type) errors.push(`${path}.type is required`);
  else if (!V1_ACTION_TYPES.has(act.type)) errors.push(`${path}.type ${act.type} is not a v1 action (Action.Execute is v2/PCLIP-24)`);
  if (act.type === "Action.OpenUrl") {
    if (typeof act.title !== "string" || !act.title) errors.push(`${path}.title is required for Action.OpenUrl`);
    if (typeof act.url !== "string" || !/^https?:\/\//.test(act.url)) errors.push(`${path}.url must be an http(s) URL`);
  }
  if (act.type === "Action.Submit") {
    if (typeof act.title !== "string" || !act.title) errors.push(`${path}.title is required for Action.Submit`);
    if (act.data !== undefined && (typeof act.data !== "object" || act.data === null)) {
      errors.push(`${path}.data must be an object when present`);
    }
  }
  return errors;
}
