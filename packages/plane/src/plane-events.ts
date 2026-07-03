/**
 * Typed view of Plane CE webhook payloads (PCLIP-1).
 *
 * Payload shape (per developers.plane.so): { event, action, webhook_id,
 * workspace_id, data, activity }. Self-hosted CE is known to fire duplicate
 * deliveries for one change (makeplane/plane#6848) and to miss some
 * "updated" events (#4097) — dedupe here, reconciliation (PCLIP-5) heals.
 */

export type PlaneEventType = "issue" | "issue_comment" | "project" | "cycle" | "module" | (string & {});
export type PlaneEventAction = "created" | "updated" | "deleted" | (string & {});

export interface PlaneWebhookPayload {
  event: PlaneEventType;
  action: PlaneEventAction;
  webhook_id?: string;
  workspace_id?: string;
  data?: Record<string, unknown>;
  activity?: {
    actor?: Record<string, unknown>;
    field?: string | null;
    old_value?: unknown;
    new_value?: unknown;
  };
}

export interface ParsedPlaneEvent {
  event: PlaneEventType;
  action: PlaneEventAction;
  /** Primary entity id (issue id, comment id, ...) when present. */
  entityId: string | undefined;
  /** Plane project id when present. */
  projectId: string | undefined;
  workspaceId: string | undefined;
  payload: PlaneWebhookPayload;
}

/** Parse and minimally validate a Plane webhook body. Returns null when the shape is not a Plane event. */
export function parsePlaneEvent(body: unknown): ParsedPlaneEvent | null {
  if (typeof body !== "object" || body === null) return null;
  const candidate = body as Record<string, unknown>;
  if (typeof candidate.event !== "string" || typeof candidate.action !== "string") return null;

  const data = (typeof candidate.data === "object" && candidate.data !== null
    ? candidate.data
    : undefined) as Record<string, unknown> | undefined;

  return {
    event: candidate.event,
    action: candidate.action,
    entityId: typeof data?.id === "string" ? data.id : undefined,
    projectId: typeof data?.project === "string" ? (data.project as string) : undefined,
    workspaceId: typeof candidate.workspace_id === "string" ? candidate.workspace_id : undefined,
    payload: candidate as unknown as PlaneWebhookPayload,
  };
}
