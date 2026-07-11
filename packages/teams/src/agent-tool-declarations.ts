import type { JsonSchema, PaperclipPluginManifestV1 } from "@paperclipai/plugin-sdk";

/**
 * Single source of truth for the Teams plugin's agent-callable tools.
 *
 * WHY THIS FILE EXISTS (root cause of "agent can't see post_to_channel"):
 * the host registers agent tools ONLY from `manifest.tools`
 * (server `plugin-loader.ts` → `toolDispatcher.registerPluginTools(pluginKey, manifest)`;
 * `plugin-tool-registry.registerPlugin` returns early when `manifest.tools` is empty).
 * A worker-side `ctx.tools.register(...)` call installs a runtime HANDLER but does NOT
 * advertise the tool to agents — there is no worker→host RPC that ingests it. So a tool
 * that is only runtime-registered is invisible to every agent (and to
 * `GET /api/plugins/tools`). Plane works because it does BOTH: declares its tools in the
 * manifest AND wires the handlers at runtime.
 *
 * These declarations are therefore consumed in TWO places from this one definition, so the
 * manifest advertisement and the runtime handler registration can never drift:
 *   1. `manifest.ts` spreads {@link TEAMS_AGENT_TOOL_DECLARATIONS} into `manifest.tools`.
 *   2. `worker.ts` registers each handler with {@link toolRuntimeDecl}(TEAMS_AGENT_TOOLS.x).
 */

/** One manifest tool declaration (name + displayName + description + JSON-Schema params). */
export type TeamsToolDeclaration = NonNullable<PaperclipPluginManifestV1["tools"]>[number];

/** The runtime shape `ctx.tools.register` expects for its 2nd argument (declaration minus name). */
export type TeamsToolRuntimeDecl = Omit<TeamsToolDeclaration, "name">;

/**
 * Strip `name` for the runtime `ctx.tools.register(name, decl, handler)` call, which takes the
 * name separately as its first argument. Keeps the manifest declaration and the runtime
 * registration structurally identical (same displayName/description/parametersSchema).
 */
export function toolRuntimeDecl(d: TeamsToolDeclaration): TeamsToolRuntimeDecl {
  return { displayName: d.displayName, description: d.description, parametersSchema: d.parametersSchema };
}

/** Reusable JSON-Schema for the optional structured-input `fields` array (ask/post). */
const FIELDS_SCHEMA: JsonSchema = {
  type: "array",
  description: "Optional structured inputs to collect (each rendered as an editable field)",
  items: {
    type: "object",
    properties: {
      id: { type: "string" },
      label: { type: "string" },
      multiline: { type: "boolean" },
      placeholder: { type: "string" },
      prefill: { type: "string" },
    },
    required: ["id"],
  },
};

export const TEAMS_AGENT_TOOLS = {
  escalateToHuman: {
    name: "escalate_to_human",
    displayName: "Escalate to human",
    description:
      "Escalate the current conversation to a human via the configured Microsoft Teams channel, with a suggested reply they can send back with one click.",
    parametersSchema: {
      type: "object",
      properties: {
        reason: { type: "string", description: "Why the agent is escalating" },
        confidence: { type: "number", description: "Agent confidence in [0,1]" },
        agentName: { type: "string", description: "Name of the escalating agent" },
        agentReasoning: { type: "string", description: "The agent's reasoning for escalating" },
        suggestedReply: { type: "string", description: "A reply the human can send back with one click" },
        conversationHistory: {
          type: "array",
          description: "Recent conversation turns for context",
          items: { type: "object", properties: { role: { type: "string" }, text: { type: "string" } } },
        },
      },
      required: ["reason"],
    },
  },
  askPerson: {
    name: "ask_person",
    displayName: "Ask a person",
    description:
      "Ask a specific person a question in Microsoft Teams and have their answer delivered back to you. The plugin only carries the message and tracks who answered; you decide whether and when to ask again.",
    parametersSchema: {
      type: "object",
      properties: {
        personRef: { type: "string", description: "The person's stored 1:1 conversation key (they must have interacted with the bot). Plane/Teams identity mapping is a separate capability." },
        prompt: { type: "string", description: "The question to ask" },
        fields: FIELDS_SCHEMA,
        correlationId: { type: "string", description: "Your own key to tie the answer to a work item, e.g. plane:<id>" },
      },
      required: ["personRef", "prompt"],
    },
  },
  listOpenAsks: {
    name: "list_open_asks",
    displayName: "List open asks",
    description:
      "List the questions this plugin is still waiting on answers for, so you can decide whether to re-ask or follow up. The plugin never nudges people on its own.",
    parametersSchema: {
      type: "object",
      properties: {
        correlationPrefix: { type: "string", description: "Optional: only asks whose correlationId starts with this (e.g. plane:)" },
      },
    },
  },
  cancelAsk: {
    name: "cancel_ask",
    displayName: "Cancel an ask",
    description: "Withdraw a question you previously asked a person (e.g. it's no longer relevant). Their card updates to show it's no longer needed.",
    parametersSchema: {
      type: "object",
      properties: { requestId: { type: "string", description: "The requestId returned by ask_person" } },
      required: ["requestId"],
    },
  },
  postToChannel: {
    name: "post_to_channel",
    displayName: "Post to a channel",
    description:
      "Post a message to a Microsoft Teams channel. Set collect:true to render a form and gather each person's reply (read them later with get_channel_responses); otherwise post a plain announcement (e.g. a report you built). The plugin only carries the message and tracks who replied — you decide the audience, cadence, and how to consolidate.",
    parametersSchema: {
      type: "object",
      properties: {
        channelRef: { type: "string", description: "The channel's stored conversation key (the bot must have been added / @mentioned there once)." },
        text: { type: "string", description: "The message / prompt text." },
        collect: { type: "boolean", description: "When true, render input field(s) + a Send button and collect replies; when false/omitted, post a plain announcement." },
        fields: {
          type: "array",
          description: "Optional structured inputs to collect when collect=true (each rendered as an editable field). Omit for a single free-text answer.",
          items: {
            type: "object",
            properties: { id: { type: "string" }, label: { type: "string" }, multiline: { type: "boolean" }, placeholder: { type: "string" }, prefill: { type: "string" } },
            required: ["id"],
          },
        },
        heading: { type: "string", description: "Optional bold heading for a plain announcement (ignored when collect=true)." },
        correlationId: { type: "string", description: "Your own key to group related posts/responses, e.g. standup:2026-07-10-am." },
      },
      required: ["channelRef", "text"],
    },
  },
  getChannelResponses: {
    name: "get_channel_responses",
    displayName: "Get channel responses",
    description:
      "Read back who has responded to a collecting channel post (from post_to_channel) and what they said, so you can consolidate. Returns each responder's id, display name, and answers. Set close:true to stop collecting and update the card.",
    parametersSchema: {
      type: "object",
      properties: {
        postId: { type: "string", description: "The postId returned by post_to_channel" },
        close: { type: "boolean", description: "When true, close the post (stops collecting; updates the card to a closed state)." },
      },
      required: ["postId"],
    },
  },
  listChannelMembers: {
    name: "list_channel_members",
    displayName: "List channel members",
    description:
      "List the members of a Microsoft Teams channel (display name, email, and id), so you can decide who to expect a reply from or join people to other systems by email. Emails are lowercased for case-insensitive matching. Returns an empty list if the bot can't read the channel.",
    parametersSchema: {
      type: "object",
      properties: { channelRef: { type: "string", description: "The channel's stored conversation key (the bot must have been added / @mentioned there once)." } },
      required: ["channelRef"],
    },
  },
} satisfies Record<string, TeamsToolDeclaration>;

/** All Teams agent tools, in a stable order, for `manifest.tools`. */
export const TEAMS_AGENT_TOOL_DECLARATIONS: TeamsToolDeclaration[] = Object.values(TEAMS_AGENT_TOOLS);
