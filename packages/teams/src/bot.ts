/**
 * Microsoft 365 Agents SDK bot integration (PCLIP-23 / T6).
 *
 * This is the SDK-COUPLED integration layer (like worker.ts): it wires
 * `@microsoft/agents-hosting` to the Paperclip plugin runtime. The security policy
 * ({@link ./bot-auth.js}) and the proactive conversation store
 * ({@link ./bot-conversations.js}) are kept in separate SDK-decoupled, unit-tested
 * modules; this file only glues them to the real adapter.
 *
 * Verified against @microsoft/agents-hosting v1.6 (see memory ms365-agents-sdk-api):
 *   - `CloudAdapter(authConfig)`; `adapter.process(req, res, logic)`;
 *     `adapter.continueConversation(botAppId, reference, logic)`.
 *   - `authorizeJWT(authConfig)` is the auth middleware (Express-shaped); it does the
 *     JWKS signature/issuer/audience validation and sets `req.user`. `process()` alone
 *     permits ANONYMOUS identity, so we must authenticate before dispatch (AC #3).
 *   - `ActivityHandler` (`onMessage`, `onConversationUpdate`, `run(context)`);
 *     `context.activity.getConversationReference()` for proactive.
 *   - Bot Framework SDK (`botbuilder`) is RETIRED and MUST NOT be used (AC #2).
 *
 * HOST CONSTRAINT (verified against tools/paperclip): the plugin `onWebhook` returns
 * `void` and CANNOT set the HTTP status or response body — the host returns 200 on
 * success and 502 on throw. Therefore:
 *   - Inbound auth REJECTION is signalled by throwing (host → 502). Functionally the
 *     request is rejected/unprocessed (AC #3), though the status is 502 not 401.
 *   - Message replies are sent via the Connector (proactive/sendActivity), NOT via the
 *     inline HTTP response.
 *   - `invoke` activities (Action.Execute / Universal Actions, T7) that REQUIRE an
 *     inline response body are blocked until the host exposes an HTTP-response-capable
 *     webhook. Tracked as a host dependency on PCLIP-23/24.
 */

// eslint-disable-next-line import/no-unresolved -- installed at deploy time; not built in this repo (like worker.ts)
import {
  ActivityHandler,
  CardFactory,
  CloudAdapter,
  TurnContext,
  authorizeJWT,
  getAuthConfigWithDefaults,
  type AuthConfiguration,
  type Request as AgentsRequest,
} from "@microsoft/agents-hosting";
// Derive Activity from the SDK's own method signature so we don't need a direct
// @microsoft/agents-activity dependency (it's only a transitive dep of agents-hosting).
type Activity = Parameters<TurnContext["updateActivity"]>[0];

// The SDK does not export a `Response` type (in the Express example it comes from
// `express`); derive the exact type CloudAdapter.process expects for our shims.
type AdapterResponse = Parameters<CloudAdapter["process"]>[1];
import { assertBotClaims, assertServiceUrl, BotInboundUnauthorizedError, extractBearerToken, type AuthDecision, type BotTokenClaims, type InboundAuthConfig } from "./bot-auth.js";
import { conversationKey, type ConversationRef, type ConversationStore } from "./bot-conversations.js";
import {
  buildApprovalCard,
  buildApprovalErrorCard,
  buildDecidedCard,
  parseApprovalSubmit,
  teamsActor,
  type ApprovalCardInput,
  type ApprovalsClient,
  type ApprovalVerb,
} from "./approvals.js";
import { type ApprovalStore } from "./approval-store.js";
import { buildHelpCard, dispatchCommand, parseCommand, type CommandDeps, type CommandName } from "./commands.js";

export interface TeamsBotDeps {
  /** Raw settings-derived auth config; normalized via getAuthConfigWithDefaults internally. */
  authConfig: Parameters<typeof getAuthConfigWithDefaults>[0];
  /** The bot's Microsoft App Id — required inbound token audience + proactive identity. */
  botAppId: string;
  /** Extra allowed issuers beyond the Bot Framework default. */
  allowedIssuers?: readonly string[];
  conversations: ConversationStore;
  /** Interactive approvals (PCLIP-24). Omit to disable approve/reject handling. */
  approvals?: { client: ApprovalsClient; store: ApprovalStore };
  /** @Paperclip command set (PCLIP-27 / T10). Omit to fall back to the friendly notice. */
  commands?: CommandDeps;
  /** Called after a command is handled, for the `teams.commands.handled` metric. */
  onCommand?: (command: CommandName) => void;
  log: (message: string, fields?: Record<string, unknown>) => void;
}

export interface TeamsBot {
  adapter: CloudAdapter;
  handler: ActivityHandler;
  /** Authenticate + dispatch an inbound webhook activity. Throws on auth failure (→ host 502). */
  handleInbound(headers: Record<string, string | string[]>, rawBody: string): Promise<void>;
  /** Post a proactive message to a remembered conversation (AC #1). */
  postProactively(conversationKeyId: string, activityFactory: (ctx: TurnContext) => Promise<void>): Promise<boolean>;
  /** Post an interactive approval card to a conversation and remember its ref (PCLIP-24). */
  postApprovalCard(conversationKeyId: string, input: ApprovalCardInput): Promise<boolean>;
  /** On the approval.decided event, read the outcome and refresh the stored card (PCLIP-24). */
  onApprovalDecided(input: { approvalId: string; byName?: string }): Promise<boolean>;
}

/** Build the inbound-auth policy config from deps. */
function authPolicy(deps: TeamsBotDeps): InboundAuthConfig {
  return { audience: deps.botAppId, allowedIssuers: deps.allowedIssuers };
}

/**
 * Run the SDK's `authorizeJWT` middleware over a minimal request/response shim to
 * perform the cryptographic validation (signature, JWKS, issuer, audience) and read
 * back the resolved identity claims. We do NOT re-implement JWT crypto — this is the
 * vetted SDK path. Returns the decoded claims or a rejection reason.
 */
function verifyViaSdk(authConfig: AuthConfiguration, authorization: string | string[] | undefined): Promise<AuthDecision> {
  return new Promise((resolve) => {
    // Fast pre-check so a missing token never reaches the middleware.
    if (!extractBearerToken(authorization ?? null)) {
      resolve({ ok: false, reason: "missing or malformed Authorization bearer token" });
      return;
    }
    // The shim MUST carry method: "POST" (Codex): authorizeJWT rejects any request
    // whose method isn't POST/GET BEFORE it verifies the token, so a method-less shim
    // would send every valid Teams message down the unauthorized path. Teams delivers
    // bot activities as POST.
    const req = {
      method: "POST",
      headers: { authorization: Array.isArray(authorization) ? authorization[0] : authorization },
    } as unknown as AgentsRequest & { user?: BotTokenClaims };
    let settled = false;
    const finish = (decision: AuthDecision) => {
      if (!settled) {
        settled = true;
        resolve(decision);
      }
    };
    // Minimal Express-style response shim for the authorizeJWT middleware. The middleware
    // ONLY touches res on FAILURE — it calls `res.status(4xx).send({ 'jwt-auth-error': msg })`
    // (success goes through `next()`), so any status >= 400 / terminal send/end is a rejection.
    // We capture the SDK's error MESSAGE from the `.send()` payload into the reason so the
    // worker's internal log can distinguish a JWKS/Bot-Framework INFRASTRUCTURE failure (e.g.
    // "SigningKeyNotFoundError", a JWKS 5xx/timeout) from a plain bad/expired TOKEN — the
    // reviewer's infra-vs-auth triage point. This reason is logged internally only; the caller
    // still receives the generic "unauthorized", so no internals leak (AC #2). Methods are
    // self-contained (no `this`) so the shim types cleanly.
    let pendingStatus: number | undefined;
    const rejectReason = (message?: string): string => {
      const base = pendingStatus !== undefined ? `token verification failed (status ${pendingStatus})` : "token verification failed";
      return message ? `${base}: ${message}` : base;
    };
    const sdkError = (payload: unknown): string | undefined => {
      if (payload && typeof payload === "object") {
        const v = (payload as Record<string, unknown>)["jwt-auth-error"];
        if (typeof v === "string" && v.trim()) return v.trim();
      }
      return undefined;
    };
    const res: Record<string, (...args: unknown[]) => unknown> = {};
    res.status = (code: unknown) => {
      if (typeof code === "number" && code >= 400) {
        pendingStatus = code;
        // The SDK calls `.send()` synchronously right after `.status()`, carrying the error
        // message — let it win. This microtask is a defensive guard so a >= 400 status that is
        // (unexpectedly) never followed by send/end still rejects instead of hanging.
        queueMicrotask(() => finish({ ok: false, reason: rejectReason() }));
      }
      return res;
    };
    res.send = (payload?: unknown) => {
      finish({ ok: false, reason: rejectReason(sdkError(payload)) });
      return res;
    };
    res.end = () => {
      finish({ ok: false, reason: rejectReason() });
      return res;
    };
    // Express error-first `next(err?)`: an error means verification failed; no error
    // means authenticated (claims on req.user).
    const next = (err?: unknown) => {
      if (err) finish({ ok: false, reason: `token verification failed: ${err instanceof Error ? err.message : String(err)}` });
      else finish({ ok: true, claims: (req.user ?? {}) as BotTokenClaims });
    };
    try {
      // authorizeJWT(authConfig) → Express-style (req,res,next) middleware. It may be
      // ASYNC (JWKS fetch): route a rejected promise through next(err) so an async
      // verification failure resolves this promise instead of hanging the webhook
      // handler or raising an unhandled rejection (Kody, critical).
      const maybePromise = (authorizeJWT(authConfig) as (r: unknown, s: unknown, n: (err?: unknown) => void) => unknown)(req, res, next);
      if (maybePromise && typeof (maybePromise as Promise<unknown>).catch === "function") {
        (maybePromise as Promise<unknown>).catch((e) => next(e));
      }
    } catch (e) {
      next(e);
    }
  });
}

/** Create the Teams bot: adapter + activity handler + inbound/proactive plumbing. */
export function createTeamsBot(deps: TeamsBotDeps): TeamsBot {
  // Normalize the raw settings-derived config through the SDK helper BEFORE use
  // (Codex): authorizeJWT resolves the expected audience from `authConfig.connections`,
  // which is only populated by getAuthConfigWithDefaults / the env loader — a raw
  // { clientId, tenantId, clientSecret } object would otherwise fail every token with
  // an audience mismatch. The normalized config also carries clientSecret into the
  // CloudAdapter's connection manager for OUTBOUND (proactive) auth (AC #1).
  const authConfig = getAuthConfigWithDefaults(deps.authConfig);
  const adapter = new CloudAdapter(authConfig);
  const handler = new ActivityHandler();
  // T7/PCLIP-24 SEAM: Action.Execute / Universal Action `invoke` activities are handled
  // here once the host exposes an HTTP-response-capable webhook (invoke REQUIRES an
  // inline response body, which the current void-returning onWebhook cannot provide —
  // see the file header + PCLIP-23 description). The handler + adapter are already
  // constructed, so unblocking T7 is a localized change: add the invoke handler and
  // return its AdaptiveCardInvokeResponse through the (future) response channel.

  // Remember the conversation on any inbound turn so we can post proactively later
  // (AC #1). Both a message and a conversationUpdate (bot added to a team) carry a
  // usable ConversationReference.
  const rememberFrom = async (context: TurnContext): Promise<void> => {
    // getConversationReference() is an instance method on the ACTIVITY (agents-activity).
    const reference = context.activity.getConversationReference() as unknown as ConversationRef;
    const key = conversationKey(reference);
    if (key) await deps.conversations.remember(reference);
  };

  handler.onConversationUpdate(async (context: TurnContext, next: () => Promise<void>) => {
    await rememberFrom(context);
    await next();
  });
  handler.onMessage(async (context: TurnContext, next: () => Promise<void>) => {
    await rememberFrom(context);
    // PCLIP-24: an Approve/Reject Action.Submit click arrives as a message activity
    // carrying our data in `activity.value`. Handle it and return — no generic reply.
    const submit = parseApprovalSubmit(context.activity.value);
    if (submit && deps.approvals) {
      await handleApprovalSubmit(context, submit.verb, submit.approvalId);
      await next();
      return;
    }
    // PCLIP-27 (T10): an @mention text command. parseCommand strips the <at>…</at> mention
    // span itself (this SDK's ActivityHandler has no removeRecipientMention), and unknown/
    // empty text renders help — so the user is never left in silence.
    if (deps.commands) {
      const text = typeof context.activity.text === "string" ? context.activity.text : "";
      const parsed = parseCommand(text);
      try {
        const outcome = await dispatchCommand(parsed, deps.commands);
        await context.sendActivity(cardActivity(outcome.card) as Activity);
        deps.onCommand?.(outcome.command);
      } catch (e) {
        // A data-fetch (ctx.agents/issues) failure must not leave the user in silence:
        // log the detail and still reply with help.
        deps.log("teams command failed", { command: parsed.command, error: e instanceof Error ? e.message : String(e) });
        await context.sendActivity(cardActivity(buildHelpCard()) as Activity);
      }
      await next();
      return;
    }
    // No command deps wired (bot not fully configured): keep a friendly, non-silent notice.
    await context.sendActivity("Thanks — I post Paperclip notifications and approvals here.");
    await next();
  });

  /** Build a bot message activity carrying an Adaptive Card. */
  const cardActivity = (card: ReturnType<typeof buildApprovalCard>): Partial<Activity> => ({
    type: "message",
    attachments: [CardFactory.adaptiveCard(card)],
  });

  /**
   * Handle an Approve/Reject click: relay the decision to the Paperclip API with the
   * acting Teams user (teams:{aadObjectId}). On failure, refresh the card to an error
   * state that KEEPS the actions (AC #5). On success we do NOT refresh here — the
   * definitive "Approved/Rejected by …" refresh comes from the approval.decided event
   * (updateActivity), so both this clicker and everyone else converge (idempotent).
   */
  const handleApprovalSubmit = async (context: TurnContext, verb: ApprovalVerb, approvalId: string): Promise<void> => {
    if (!deps.approvals) return;
    const actor = teamsActor(context.activity.from?.aadObjectId);
    // Sanitize the Teams display name before it goes into a decisionNote the Paperclip
    // audit UI may render (Kody, security): strip HTML/quote/control chars and cap length.
    // The actor id is a GUID-based teams:{aadObjectId} and is safe as-is.
    const safeName = sanitizeDisplayName(context.activity.from?.name);
    const noteName = safeName || actor;
    const result = await deps.approvals.client.decide(verb, approvalId, {
      actor,
      decisionNote: `Teams approval ${verb} by ${noteName} (${actor})`,
    });
    const stored = await deps.approvals.store.get(approvalId);
    if (!result.ok) {
      deps.log("teams approval decision failed", { approvalId, verb, status: result.status, error: result.error });
      const input: ApprovalCardInput = {
        approvalId,
        title: stored?.title,
        requester: stored?.requester,
        issueIdentifier: stored?.issueIdentifier,
        link: stored?.link,
      };
      const errorCard = buildApprovalErrorCard(input, result.error ?? `HTTP ${result.status}`);
      if (stored?.activityId) {
        await context.updateActivity({ ...cardActivity(errorCard), id: stored.activityId } as Activity);
      } else {
        await context.sendActivity(cardActivity(errorCard) as Activity);
      }
      return;
    }
    // Success: refresh the card OPTIMISTICALLY here — we know the verb (the user just
    // clicked it), so we don't have to wait for / re-read the approval.decided event
    // (whose payload doesn't carry the outcome). Update in place + forget the ref so the
    // subsequent approval.decided event is a no-op for this card.
    if (stored?.activityId) {
      // Refresh with the ACTUAL decision from the server (idempotency-safe): if the approval
      // was already decided elsewhere — possibly differently — show the true outcome, not the
      // verb this user just clicked. Attribute to the clicker only when their action was the
      // one applied; otherwise show the state without a (misleading) name.
      const actualVerb = result.verb ?? verb;
      const decidedByName = actualVerb === verb ? safeName : undefined;
      const decided = buildDecidedCard(actualVerb, { byName: decidedByName, title: stored.title });
      await context.updateActivity({ ...cardActivity(decided), id: stored.activityId } as Activity);
      await deps.approvals.store.forget(approvalId);
    }
  };

  /** Strip HTML/quote/control chars from a user-controlled display name; cap length. */
  const sanitizeDisplayName = (name?: string): string | undefined => {
    if (!name) return undefined;
    const cleaned = name.replace(/[<>&"'`\r\n\t]/g, "").trim().slice(0, 120);
    return cleaned || undefined;
  };

  return {
    adapter,
    handler,
    async handleInbound(headers, rawBody) {
      const authorization = headers["authorization"] ?? headers["Authorization"];
      // 1) Cryptographic validation via the SDK (signature/JWKS/issuer/audience). The SDK's
      // authorizeJWT owns: RS256 signature via JWKS (jwks-rsa's `getSigningKey`, keyed off the
      // token's own issuer through buildJwksUri), audience === a configured clientId, and a
      // 5-min clock tolerance (verified in @microsoft/agents-hosting jwt-middleware.js). JWKS
      // key caching + refresh is therefore owned by jwks-rsa (short default TTL, plus a fresh
      // fetch on an unknown `kid` for key rotation) — far more frequent than the 24h upper
      // bound the Bot Connector spec requires, so we do NOT hand-roll a JWKS cache.
      const sdkDecision = await verifyViaSdk(authConfig, authorization);
      if (!sdkDecision.ok) {
        deps.log("teams bot inbound rejected (auth)", { reason: sdkDecision.reason });
        // No 401/403 available (host maps a throw → 502 and echoes the message). Throw a
        // GENERIC "unauthorized" so no verification internals reach the caller (AC #2); the
        // detailed reason rides on .reason for the worker to log, never surfaced (T8).
        throw new BotInboundUnauthorizedError(sdkDecision.reason);
      }
      // 2) Defense-in-depth claims policy (audience === our app id, allowed issuer, exp/nbf).
      const policy = assertBotClaims(sdkDecision.claims, authPolicy(deps), Date.now());
      if (!policy.ok) {
        deps.log("teams bot inbound rejected (claims policy)", { reason: policy.reason });
        throw new BotInboundUnauthorizedError(policy.reason);
      }
      // 3) Parse the activity. A malformed body throws (→ host 502) rather than dispatching
      // an empty activity under a 200.
      const activity = parseActivityBody(rawBody);
      // 3b) serviceUrl binding (Bot Connector spec req #7) — the SDK does NOT check this, so
      // bind the token to the activity's channel endpoint here (defense-in-depth). Only
      // enforced when the token carries the claim (Emulator/Entra omit it).
      const serviceUrlCheck = assertServiceUrl(
        sdkDecision.claims,
        activity && typeof activity === "object" ? (activity as Record<string, unknown>).serviceUrl : undefined,
      );
      if (!serviceUrlCheck.ok) {
        deps.log("teams bot inbound rejected (serviceUrl)", { reason: serviceUrlCheck.reason });
        throw new BotInboundUnauthorizedError(serviceUrlCheck.reason);
      }
      // 4) Dispatch to the adapter with a captured (no-op) response — replies go via the
      // Connector, not this inline response (host can't return a body).
      const req = { method: "POST", headers, body: activity, user: sdkDecision.claims } as unknown as AgentsRequest;
      const res = { status: () => res, send: () => res, end: () => res, header: () => res } as unknown as AdapterResponse;
      await adapter.process(req, res, async (context) => handler.run(context));
    },
    // Proactive-send CAPABILITY (AC #1 "can post proactively"). The trigger that calls
    // this (e.g. routing v1 notifications through the bot instead of a Workflows URL) is
    // a follow-up once bot-channel delivery is offered as an alternative to Workflows;
    // the capability + its conversation store are complete and tested here.
    async postProactively(conversationKeyId, activityFactory) {
      const stored = await deps.conversations.get(conversationKeyId);
      if (!stored) {
        deps.log("teams bot proactive skipped: unknown conversation", { conversationKeyId });
        return false;
      }
      await adapter.continueConversation(deps.botAppId, stored.reference as never, activityFactory);
      return true;
    },
    // PCLIP-24: post the interactive approval card to a known conversation and remember
    // where it landed (conversation ref + posted activity id) so approval.decided can
    // later updateActivity it in place. Must be bot-posted (not via Workflows) to be updatable.
    async postApprovalCard(conversationKeyId, input) {
      if (!deps.approvals) return false;
      const conv = await deps.conversations.get(conversationKeyId);
      if (!conv) {
        deps.log("teams approval card skipped: unknown conversation", { conversationKeyId });
        return false;
      }
      let activityId: string | undefined;
      await adapter.continueConversation(deps.botAppId, conv.reference as never, async (ctx) => {
        const res = await ctx.sendActivity(cardActivity(buildApprovalCard(input)) as Activity);
        activityId = res?.id;
      });
      if (!activityId) return false;
      await deps.approvals.store.remember(input.approvalId, {
        conversationReference: conv.reference,
        activityId,
        title: input.title,
        requester: input.requester,
        issueIdentifier: input.issueIdentifier,
        link: input.link,
      });
      return true;
    },
    // PCLIP-24: event-driven refresh for decisions made ELSEWHERE (Paperclip UI, another
    // channel). We only have a stored card if WE posted it; if the plugin's own click
    // already refreshed optimistically it has forgotten the ref, so this is a no-op. The
    // approval.decided event does NOT carry the outcome, so read it via getStatus, then
    // updateActivity to the decided state (mirrors Discord editMessage) and forget.
    async onApprovalDecided(input) {
      if (!deps.approvals) return false;
      const stored = await deps.approvals.store.get(input.approvalId);
      if (!stored) return false;
      const status = await deps.approvals.client.getStatus(input.approvalId);
      if (!status.ok || !status.verb) {
        deps.log("teams approval.decided: could not resolve outcome", { approvalId: input.approvalId, status: status.status, error: status.error });
        return false;
      }
      // Prefer the decider from the event; fall back to the record's decidedBy (getStatus).
      const decided = buildDecidedCard(status.verb, { byName: input.byName ?? status.decidedBy, title: stored.title });
      await adapter.continueConversation(deps.botAppId, stored.conversationReference as never, async (ctx) => {
        await ctx.updateActivity({ type: "message", id: stored.activityId, attachments: [CardFactory.adaptiveCard(decided)] } as Activity);
      });
      await deps.approvals.store.forget(input.approvalId);
      return true;
    },
  };
}

/**
 * Parse the inbound activity body. A malformed body THROWS (Kody) so the host rejects
 * it (→ 502) instead of dispatching an empty activity and returning a misleading 200.
 */
function parseActivityBody(raw: string): unknown {
  try {
    return JSON.parse(raw);
  } catch (e) {
    throw new Error(`invalid JSON activity body: ${e instanceof Error ? e.message : String(e)}`);
  }
}
