/**
 * Per-URL delivery health tracking + degraded-delivery status (PCLIP-22 / T5, AC #3).
 *
 * After a delivery has exhausted its retries (see delivery.ts), the worker records
 * the outcome here. When a single destination URL accumulates `threshold` consecutive
 * FINAL failures, it is marked DEGRADED; a subsequent success clears it. The worker
 * exposes {@link DeliveryHealth.snapshot} through `ctx.data.register("delivery-health")`
 * so the plugin's settings UI can surface which channels are currently degraded.
 *
 * SECURITY: a Workflows URL is a capability secret. We NEVER persist or return the raw
 * URL — entries are keyed by a non-reversible fingerprint ({@link fingerprintUrl}), and
 * the operator-facing signal is the set of channels/event types observed on that URL.
 *
 * SDK-decoupled: a tiny key/value {@link DeliveryHealthStore} (plugin state in prod),
 * so the state machine (threshold trip, recovery, counters) is fully unit-tested.
 */

export interface DeliveryHealthStore {
  get(key: string): Promise<unknown>;
  set(key: string, value: unknown): Promise<void>;
}

export const DELIVERY_HEALTH_KEY = "delivery:health";

/** Default consecutive-failure count that flips a URL to degraded. */
export const DEFAULT_DEGRADED_THRESHOLD = 5;

/** Health record for one destination URL (fingerprinted — never the raw URL). */
export interface UrlHealth {
  /** Non-reversible fingerprint of the URL (see {@link fingerprintUrl}). */
  urlFingerprint: string;
  degraded: boolean;
  /** Consecutive FINAL failures since the last success. Resets to 0 on success. */
  consecutiveFailures: number;
  totalFailures: number;
  totalSuccesses: number;
  lastStatus?: number;
  lastError?: string;
  /** Channels seen delivering to this URL (for operator context; not secrets). */
  channels: string[];
  lastEventType?: string;
  /** Epoch ms the URL first became degraded in the current degraded streak. */
  degradedSince?: number;
  updatedAt: number;
}

/**
 * Non-reversible 32-bit FNV-1a fingerprint of a URL, rendered as 8 hex chars. Used
 * only as a stable map key so we can track per-URL health WITHOUT storing the secret
 * URL. It is a fingerprint, not a cryptographic digest — collisions are irrelevant at
 * the handful-of-webhooks scale, and it intentionally cannot reconstruct the URL.
 */
export function fingerprintUrl(url: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < url.length; i++) {
    h ^= url.charCodeAt(i);
    // FNV prime 16777619, kept in 32-bit via Math.imul.
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(16).padStart(8, "0");
}

export interface RecordContext {
  channel: string;
  eventType: string;
  status?: number;
  error?: string;
}

/** What changed as a result of recording one outcome (for worker logging/metrics). */
export interface HealthTransition {
  degraded: boolean;
  /** True on the exact recording that flipped healthy → degraded (log once, AC #3). */
  justTripped: boolean;
  /** True on the recording that cleared a degraded URL back to healthy. */
  justRecovered: boolean;
  urlFingerprint: string;
}

export interface DeliveryHealth {
  /** Record a FINAL delivery outcome (after retries) for a URL. Serialized. */
  record(url: string, ok: boolean, ctx: RecordContext): Promise<HealthTransition>;
  /** Sanitized health list for the settings UI (no raw URLs). */
  snapshot(): Promise<{ threshold: number; urls: UrlHealth[] }>;
}

function createLock(): <T>(fn: () => Promise<T>) => Promise<T> {
  let tail: Promise<unknown> = Promise.resolve();
  return <T>(fn: () => Promise<T>): Promise<T> => {
    const result = tail.then(fn, fn);
    tail = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  };
}

type HealthMap = Record<string, UrlHealth>;

function coerceMap(raw: unknown): HealthMap {
  if (!raw || typeof raw !== "object") return {};
  const out: HealthMap = {};
  for (const [k, v] of Object.entries(raw as Record<string, unknown>)) {
    const e = v as Partial<UrlHealth> | null;
    if (!e || typeof e !== "object" || typeof e.urlFingerprint !== "string") continue;
    out[k] = {
      urlFingerprint: e.urlFingerprint,
      degraded: e.degraded === true,
      consecutiveFailures: numOr0(e.consecutiveFailures),
      totalFailures: numOr0(e.totalFailures),
      totalSuccesses: numOr0(e.totalSuccesses),
      lastStatus: typeof e.lastStatus === "number" ? e.lastStatus : undefined,
      lastError: typeof e.lastError === "string" ? e.lastError : undefined,
      channels: Array.isArray(e.channels) ? e.channels.filter((c): c is string => typeof c === "string") : [],
      lastEventType: typeof e.lastEventType === "string" ? e.lastEventType : undefined,
      degradedSince: typeof e.degradedSince === "number" ? e.degradedSince : undefined,
      updatedAt: numOr0(e.updatedAt),
    };
  }
  return out;
}

function numOr0(v: unknown): number {
  return typeof v === "number" && Number.isFinite(v) ? v : 0;
}

/**
 * Track delivery health per URL. Every record is serialized by an in-process lock
 * (valid for the single out-of-process worker) so concurrent deliveries can't clobber
 * the read-modify-write of the shared map.
 */
export function createDeliveryHealth(
  store: DeliveryHealthStore,
  opts: { threshold?: number; now?: () => number } = {},
): DeliveryHealth {
  const threshold = Math.max(1, opts.threshold ?? DEFAULT_DEGRADED_THRESHOLD);
  const now = opts.now ?? Date.now;
  const lock = createLock();

  const load = async (): Promise<HealthMap> => coerceMap(await store.get(DELIVERY_HEALTH_KEY));

  return {
    record(url, ok, ctx) {
      return lock(async () => {
        const map = await load();
        const key = fingerprintUrl(url);
        const at = now();
        const prev = map[key];
        const e: UrlHealth = prev ?? {
          urlFingerprint: key,
          degraded: false,
          consecutiveFailures: 0,
          totalFailures: 0,
          totalSuccesses: 0,
          channels: [],
          updatedAt: at,
        };
        if (ctx.channel && !e.channels.includes(ctx.channel)) e.channels = [...e.channels, ctx.channel];
        e.lastEventType = ctx.eventType;
        e.updatedAt = at;

        const wasDegraded = e.degraded;
        let justTripped = false;
        let justRecovered = false;

        if (ok) {
          e.totalSuccesses += 1;
          e.consecutiveFailures = 0;
          e.lastError = undefined;
          e.lastStatus = ctx.status;
          if (wasDegraded) {
            e.degraded = false;
            e.degradedSince = undefined;
            justRecovered = true;
          }
        } else {
          e.totalFailures += 1;
          e.consecutiveFailures += 1;
          e.lastStatus = ctx.status;
          e.lastError = ctx.error;
          if (!e.degraded && e.consecutiveFailures >= threshold) {
            e.degraded = true;
            e.degradedSince = at;
            justTripped = true;
          }
        }

        map[key] = e;
        await store.set(DELIVERY_HEALTH_KEY, map);
        return { degraded: e.degraded, justTripped, justRecovered, urlFingerprint: key };
      });
    },
    snapshot() {
      return lock(async () => {
        const map = await load();
        // Degraded first, then most-recently-updated, for a useful settings view.
        const urls = Object.values(map).sort((a, b) => {
          if (a.degraded !== b.degraded) return a.degraded ? -1 : 1;
          return b.updatedAt - a.updatedAt;
        });
        return { threshold, urls };
      });
    },
  };
}
