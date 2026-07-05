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
  CloudAdapter,
  TurnContext,
  authorizeJWT,
  getAuthConfigWithDefaults,
  type AuthConfiguration,
  type Request as AgentsRequest,
} from "@microsoft/agents-hosting";

// The SDK does not export a `Response` type (in the Express example it comes from
// `express`); derive the exact type CloudAdapter.process expects for our shims.
type AdapterResponse = Parameters<CloudAdapter["process"]>[1];
import { assertBotClaims, extractBearerToken, type AuthDecision, type BotTokenClaims, type InboundAuthConfig } from "./bot-auth.js";
import { conversationKey, type ConversationRef, type ConversationStore } from "./bot-conversations.js";

export interface TeamsBotDeps {
  /** Raw settings-derived auth config; normalized via getAuthConfigWithDefaults internally. */
  authConfig: Parameters<typeof getAuthConfigWithDefaults>[0];
  /** The bot's Microsoft App Id — required inbound token audience + proactive identity. */
  botAppId: string;
  /** Extra allowed issuers beyond the Bot Framework default. */
  allowedIssuers?: readonly string[];
  conversations: ConversationStore;
  log: (message: string, fields?: Record<string, unknown>) => void;
}

export interface TeamsBot {
  adapter: CloudAdapter;
  handler: ActivityHandler;
  /** Authenticate + dispatch an inbound webhook activity. Throws on auth failure (→ host 502). */
  handleInbound(headers: Record<string, string | string[]>, rawBody: string): Promise<void>;
  /** Post a proactive message to a remembered conversation (AC #1). */
  postProactively(conversationKeyId: string, activityFactory: (ctx: TurnContext) => Promise<void>): Promise<boolean>;
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
    // Minimal Express-style response shim for the authorizeJWT middleware. Any status
    // >= 400 or a terminal end/send means the middleware rejected the token. Methods
    // are self-contained (no `this`) so the shim types cleanly.
    const res: Record<string, (...args: unknown[]) => unknown> = {};
    res.status = (code: unknown) => {
      if (typeof code === "number" && code >= 400) finish({ ok: false, reason: `token verification failed (status ${code})` });
      return res;
    };
    res.end = () => {
      finish({ ok: false, reason: "token verification failed" });
      return res;
    };
    res.send = () => res.end();
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
    // v1 is notification-only; conversational replies land with T8+. Acknowledge so
    // the user isn't left hanging when the bot is @mentioned.
    await context.sendActivity("Thanks — I post Paperclip notifications and approvals here. Interactive commands are coming soon.");
    await next();
  });

  return {
    adapter,
    handler,
    async handleInbound(headers, rawBody) {
      const authorization = headers["authorization"] ?? headers["Authorization"];
      // 1) Cryptographic validation via the SDK (signature/JWKS/issuer/audience),
      // using the SAME normalized authConfig as the adapter.
      const sdkDecision = await verifyViaSdk(authConfig, authorization);
      if (!sdkDecision.ok) {
        deps.log("teams bot inbound rejected (auth)", { reason: sdkDecision.reason });
        // No 401 available (host maps a throw → 502); throwing is the only rejection.
        throw new Error(`bot inbound unauthorized: ${sdkDecision.reason}`);
      }
      // 2) Defense-in-depth claims policy (audience === our app id, allowed issuer, exp/nbf).
      const policy = assertBotClaims(sdkDecision.claims, authPolicy(deps), Date.now());
      if (!policy.ok) {
        deps.log("teams bot inbound rejected (claims policy)", { reason: policy.reason });
        throw new Error(`bot inbound unauthorized: ${policy.reason}`);
      }
      // 3) Dispatch to the adapter with a captured (no-op) response — replies go via
      // the Connector, not this inline response (host can't return a body). A malformed
      // body throws (→ host 502) rather than dispatching an empty activity under a 200.
      const activity = parseActivityBody(rawBody);
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
