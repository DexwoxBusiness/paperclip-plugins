/**
 * Bidirectional Plane <-> Paperclip ID mapping store (PCLIP-6).
 *
 * Persists the mapping in the host `plugin_entities` table (Postgres-backed, so
 * it survives worker restarts/upgrades — AC #3) via the SDK `ctx.entities`
 * surface. This module is SDK-decoupled behind {@link EntitiesPort} so every AC
 * is unit-testable without the plugin runtime (same pattern as the webhook
 * handler).
 *
 * Verified platform contract (tools/paperclip, pinned canary/v2026.509.0-canary.1):
 *  - `plugin_entities` has a UNIQUE index on (plugin_id, entity_type, external_id)
 *    — packages/db/src/schema/plugin_entities.ts. This is the AC #2 duplicate
 *    guard: a second upsert for the same key updates and returns the existing
 *    row rather than inserting a duplicate.
 *  - `ctx.entities.upsert` upserts by (entityType, externalId) within the plugin
 *    and returns the existing row on conflict; `ctx.entities.list` filters by
 *    entityType/externalId using that same unique index — an O(1) index lookup
 *    (AC #1). Verified in server/src/services/plugin-registry.ts (upsertEntity,
 *    listEntities) and packages/plugins/sdk .../host-client-factory.ts.
 *  - Entity RPCs require NO extra capability ("plugin-scoped by design",
 *    host-client-factory.ts entities.upsert/list => null), so the manifest needs
 *    no new capability for this store.
 *
 * Design note — O(1) BOTH directions. The only indexed key is external_id, so a
 * single row keyed by the Plane ID would make plane->paperclip O(1) but
 * paperclip->plane a scan. To satisfy AC #1 in both directions we persist TWO
 * complementary indexed rows per pair (a forward row keyed by the Plane ID and a
 * reverse row keyed by the Paperclip issue ID). Each row carries the FULL pair
 * in `data`, so either row alone is enough to reconstruct/repair the other
 * (reconciliation, PCLIP-5). The dual write is made safe below.
 */

/** Minimal view of a `plugin_entities` row (subset of the SDK PluginEntityRecord). */
export interface EntityRecord {
  id: string;
  entityType: string;
  externalId: string | null;
  title: string | null;
  status: string | null;
  data: Record<string, unknown>;
  createdAt: string;
  updatedAt: string;
}

/** Upsert input; structurally compatible with the SDK PluginEntityUpsert. */
export interface EntityUpsert {
  entityType: string;
  scopeKind: "instance";
  externalId?: string;
  title?: string;
  status?: string;
  data: Record<string, unknown>;
}

/** Query input; structurally compatible with the SDK PluginEntityQuery. */
export interface EntityQuery {
  entityType?: string;
  externalId?: string;
  limit?: number;
  offset?: number;
}

/**
 * The slice of `ctx.entities` this store depends on. `ctx.entities` satisfies
 * it directly, but tests inject a fake that emulates the host's unique-key
 * semantics.
 */
export interface EntitiesPort {
  upsert(input: EntityUpsert): Promise<EntityRecord>;
  list(query: EntityQuery): Promise<EntityRecord[]>;
}

/** Mapping status stored on both rows (queryable via the `status` column). */
export const MAPPING_STATUS = { active: "active", stale: "stale" } as const;

/** entity_type of the reverse (Paperclip-keyed) row. */
export const REVERSE_ENTITY_TYPE = "paperclip-issue";
/** entity_type + external_id of the singleton reconciliation cursor row. */
export const CURSOR_ENTITY_TYPE = "plane-sync-cursor";
export const CURSOR_KEY = "reconcile";

/** entity_type of the forward (Plane-keyed) row for a given Plane object type. */
export function forwardEntityType(planeType: string): string {
  return `plane-${planeType}`;
}

/** A resolved mapping pair. */
export interface IdMappingPair {
  planeId: string;
  paperclipIssueId: string;
  planeType: string;
  stale: boolean;
}

export interface LinkInput {
  planeId: string;
  paperclipIssueId: string;
  /** Plane object type; defaults to "issue". Determines the forward entity_type. */
  planeType?: string;
  /** Optional human-readable title for the Paperclip UI. */
  title?: string;
}

function requireId(value: string, label: string): string {
  const trimmed = value?.trim();
  if (!trimmed) {
    // Zero-state guard (engineering standard #2/#3): an empty external_id would
    // collide across every empty-keyed row (host coerces externalId ?? ""),
    // silently merging unrelated mappings. Fail loudly instead.
    throw new Error(`${label} is required and must be non-empty to map an ID pair`);
  }
  return trimmed;
}

function toPair(row: EntityRecord): IdMappingPair {
  const data = row.data ?? {};
  return {
    planeId: String(data.planeId ?? ""),
    paperclipIssueId: String(data.paperclipIssueId ?? ""),
    planeType: String(data.planeType ?? "issue"),
    stale: row.status === MAPPING_STATUS.stale || data.stale === true,
  };
}

/** Resolve options. Stale mappings are excluded unless includeStale is set. */
export interface ResolveOpts {
  /** Include stale (superseded/orphaned) mappings — for audit/reconciliation. */
  includeStale?: boolean;
}

export interface IdMappingStore {
  link(input: LinkInput): Promise<IdMappingPair>;
  resolveByPlaneId(planeId: string, planeType?: string, opts?: ResolveOpts): Promise<IdMappingPair | null>;
  resolveByPaperclipId(paperclipIssueId: string, opts?: ResolveOpts): Promise<IdMappingPair | null>;
  markStaleByPlaneId(planeId: string, planeType?: string): Promise<IdMappingPair | null>;
  getCursor(): Promise<string | null>;
  setCursor(cursor: string): Promise<void>;
}

/**
 * Create the ID mapping store over an {@link EntitiesPort} (typically
 * `ctx.entities`). All rows are written at `instance` scope (one Plane
 * workspace per plugin instance).
 */
export function createIdMappingStore(entities: EntitiesPort): IdMappingStore {
  const scopeKind = "instance" as const;

  async function findOne(entityType: string, externalId: string): Promise<EntityRecord | null> {
    // O(1): host resolves this via the unique (plugin_id, entity_type,
    // external_id) index. limit:1 is belt-and-suspenders against the unique key.
    const rows = await entities.list({ entityType, externalId, limit: 1 });
    return rows[0] ?? null;
  }

  /** Flip a superseded/orphaned row to stale, preserving its data for audit. */
  async function staleRow(
    entityType: string,
    externalId: string,
    priorData: Record<string, unknown>,
  ): Promise<void> {
    await entities.upsert({
      entityType,
      scopeKind,
      externalId,
      status: MAPPING_STATUS.stale,
      data: { ...priorData, stale: true, staleAt: new Date().toISOString() },
    });
  }

  /** Stale rows are excluded unless includeStale — callers never act on an obsolete pair. */
  function liveOrNull(row: EntityRecord | null, opts: ResolveOpts): IdMappingPair | null {
    if (!row) return null;
    const pair = toPair(row);
    return pair.stale && !opts.includeStale ? null : pair;
  }

  async function resolveByPlaneId(
    planeId: string,
    planeType = "issue",
    opts: ResolveOpts = {},
  ): Promise<IdMappingPair | null> {
    const key = planeId?.trim();
    if (!key) return null;
    return liveOrNull(await findOne(forwardEntityType(planeType), key), opts);
  }

  async function resolveByPaperclipId(
    paperclipIssueId: string,
    opts: ResolveOpts = {},
  ): Promise<IdMappingPair | null> {
    const key = paperclipIssueId?.trim();
    if (!key) return null;
    return liveOrNull(await findOne(REVERSE_ENTITY_TYPE, key), opts);
  }

  /**
   * Idempotently link a Plane object to a Paperclip issue, preserving the 1:1
   * invariant.
   *
   * Re-link handling (Codex + Kody). A pair is two rows: forward (keyed by Plane
   * ID) and reverse (keyed by Paperclip ID). If planeId was previously mapped to
   * a DIFFERENT paperclipIssueId, the old reverse row still resolves to planeId;
   * if paperclipIssueId was previously mapped to a different planeId, the old
   * forward row still resolves to it. Either leaves a live-but-obsolete mapping
   * that misroutes the outbound mirror / reconciliation. So we stale the
   * superseded counterpart row(s) to keep the mapping one-to-one.
   *
   * Failure-path (engineering standard #1). We READ the prior rows and stale the
   * superseded counterparts BEFORE overwriting the forward/reverse rows. Reading
   * first is what makes this re-entrant: until the new rows are committed, a
   * retry re-reads the same prior partners and re-applies the (idempotent) stale
   * + upserts, converging without duplicates (AC #2). Writing the new rows first
   * would erase the prior-partner info a retry needs.
   */
  async function link(input: LinkInput): Promise<IdMappingPair> {
    const planeId = requireId(input.planeId, "planeId");
    const paperclipIssueId = requireId(input.paperclipIssueId, "paperclipIssueId");
    const planeType = (input.planeType ?? "issue").trim() || "issue";

    const priorForward = await findOne(forwardEntityType(planeType), planeId);
    const priorReverse = await findOne(REVERSE_ENTITY_TYPE, paperclipIssueId);

    // Stale the superseded counterparts (only when the partner actually changed).
    const priorPc = priorForward ? String(priorForward.data.paperclipIssueId ?? "") : "";
    if (priorPc && priorPc !== paperclipIssueId) {
      await staleRow(REVERSE_ENTITY_TYPE, priorPc, priorForward!.data);
    }
    const priorPlane = priorReverse ? String(priorReverse.data.planeId ?? "") : "";
    if (priorPlane && priorPlane !== planeId) {
      const priorPlaneType = String(priorReverse!.data.planeType ?? "issue");
      await staleRow(forwardEntityType(priorPlaneType), priorPlane, priorReverse!.data);
    }

    const data: Record<string, unknown> = {
      planeId,
      paperclipIssueId,
      planeType,
      stale: false,
      linkedAt: new Date().toISOString(),
    };
    const common = { scopeKind, title: input.title, status: MAPPING_STATUS.active, data } as const;
    await entities.upsert({ ...common, entityType: forwardEntityType(planeType), externalId: planeId });
    await entities.upsert({ ...common, entityType: REVERSE_ENTITY_TYPE, externalId: paperclipIssueId });

    return { planeId, paperclipIssueId, planeType, stale: false };
  }

  /**
   * Mark a mapping stale (AC #4): a Plane item deleted upstream must NOT be
   * silently dropped. We keep both rows for auditability and flip their `status`
   * to "stale" (plus `data.stale`/`staleAt`), so history and the host UI can
   * still see the orphan. There is deliberately no delete path.
   */
  async function markStaleByPlaneId(planeId: string, planeType = "issue"): Promise<IdMappingPair | null> {
    const existing = await resolveByPlaneId(planeId, planeType, { includeStale: true });
    if (!existing) return null;
    const data: Record<string, unknown> = {
      planeId: existing.planeId,
      paperclipIssueId: existing.paperclipIssueId,
      planeType: existing.planeType,
      stale: true,
      staleAt: new Date().toISOString(),
    };
    const common = { scopeKind, status: MAPPING_STATUS.stale, data } as const;
    await entities.upsert({ ...common, entityType: forwardEntityType(existing.planeType), externalId: existing.planeId });
    await entities.upsert({ ...common, entityType: REVERSE_ENTITY_TYPE, externalId: existing.paperclipIssueId });
    return { ...existing, stale: true };
  }

  /** Read the persistent reconciliation cursor (PCLIP-5), or null if unset. */
  async function getCursor(): Promise<string | null> {
    const row = await findOne(CURSOR_ENTITY_TYPE, CURSOR_KEY);
    const value = row?.data?.cursor;
    return typeof value === "string" ? value : null;
  }

  /** Persist the reconciliation cursor. Survives restart (Postgres-backed). */
  async function setCursor(cursor: string): Promise<void> {
    await entities.upsert({
      entityType: CURSOR_ENTITY_TYPE,
      scopeKind,
      externalId: CURSOR_KEY,
      data: { cursor, updatedAt: new Date().toISOString() },
    });
  }

  return { link, resolveByPlaneId, resolveByPaperclipId, markStaleByPlaneId, getCursor, setCursor };
}
