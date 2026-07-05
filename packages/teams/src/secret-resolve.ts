/**
 * Leak-safe secret-ref resolution for bot credentials (PCLIP-26 / T9).
 *
 * The plugin-sdk contract (types.d.ts) is explicit: "Secret values are resolved at call
 * time … Never store resolved secret values. Store only secret references." The peer Slack
 * plugin resolves once in setup() and holds the value in a process variable — so "never
 * store" means never persist to a DURABLE/OBSERVABLE sink (plugin state, logs, the settings
 * `ctx.data` surfaces, metrics, agent transcripts), not "re-resolve on every call" (the
 * Agents SDK CloudAdapter needs the secret in memory to build outbound credentials).
 *
 * This helper centralizes that discipline so it is TESTABLE: the resolved value is returned
 * to the caller to hold IN MEMORY only, and on failure the log carries ONLY the error class —
 * never the ref, never the resolved value, never the raw error message (a secret provider
 * could conceivably echo its input). SDK-decoupled: `resolve` and `log` are injected.
 */

export type SecretResolveStatus = "unset" | "resolved" | "error";

export interface SecretResolveResult {
  /** The resolved secret, or "" when unset/error. Hold in memory only — never persist/log. */
  value: string;
  /**
   * `unset`    — no ref configured (or it resolved to empty); intentionally unauthenticated.
   * `resolved` — a non-empty secret was resolved.
   * `error`    — the ref was set but resolution threw (misconfig / kill-switched build).
   */
  status: SecretResolveStatus;
}

export type SecretResolver = (ref: string) => Promise<string>;
export type LeakSafeLog = (message: string, fields?: Record<string, unknown>) => void;

/**
 * Resolve a secret-ref to its value without ever leaking it.
 *
 * @param resolve         Injected `ctx.secrets.resolve` (requires the `secrets.read-ref` capability).
 * @param ref             The secret-ref from config (a reference id, not the secret itself).
 * @param log             Injected leak-safe logger; only ever receives a fixed message + error class.
 * @param onErrorMessage  A generic, value-free message logged if resolution throws.
 */
export async function resolveSecretRef(
  resolve: SecretResolver,
  ref: string | undefined | null,
  log: LeakSafeLog,
  onErrorMessage: string,
): Promise<SecretResolveResult> {
  const trimmed = typeof ref === "string" ? ref.trim() : "";
  if (!trimmed) return { value: "", status: "unset" }; // no ref → intentionally unauthenticated, no log
  try {
    const value = (await resolve(trimmed)) || "";
    return value ? { value, status: "resolved" } : { value: "", status: "unset" };
  } catch (e) {
    // ONLY the error class — never the ref, the resolved value, or e.message. This is what
    // makes AC #2 (never in logs) provable even if the provider error embeds the secret.
    log(onErrorMessage, { errorClass: e instanceof Error ? e.name : "unknown" });
    return { value: "", status: "error" };
  }
}
