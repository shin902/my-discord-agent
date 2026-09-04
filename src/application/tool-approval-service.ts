import { randomBytes, timingSafeEqual } from "node:crypto";

export const TOOL_APPROVAL_TTL_MS = 60_000;

export interface ToolApprovalBinding {
  runId: string;
  operation: string;
  invocation: string;
  target: string;
}

export interface ToolApprovalRequest extends ToolApprovalBinding {
  requestId: string;
  groupName: string;
  channelId: string;
  summary: string;
  expiresAt: number;
}

export type ToolApprovalDecision = "approve" | "deny";
export type ToolApprovalDecisionResult =
  | "approved"
  | "denied"
  | "expired"
  | "unauthorized"
  | "unknown";

export interface ToolApprovalControlSurface {
  discordBotId: string;
  channelId: string;
  messageId: string;
  authorizedUserIds: readonly string[];
}

export interface ToolApprovalInteraction {
  requestId: string;
  decision: ToolApprovalDecision;
  discordBotId: string;
  channelId: string;
  messageId: string;
  userId: string;
}

export type ToolApprovalPresenter = (
  request: ToolApprovalRequest,
) => Promise<ToolApprovalControlSurface>;

type PendingApproval = {
  request: ToolApprovalRequest;
  controlSurface?: ToolApprovalControlSurface;
  resolve: (token: string | undefined) => void;
  timer: NodeJS.Timeout;
};

type ApprovalGrant = {
  binding: ToolApprovalBinding;
  expiresAt: number;
};

const pendingApprovals = new Map<string, PendingApproval>();
const grants = new Map<string, ApprovalGrant>();
let presenter: ToolApprovalPresenter | undefined;

export function configureToolApprovalPresenter(
  value: ToolApprovalPresenter | undefined,
): void {
  presenter = value;
}

function sameValue(left: string, right: string): boolean {
  const leftBuffer = Buffer.from(left);
  const rightBuffer = Buffer.from(right);
  return (
    leftBuffer.length === rightBuffer.length &&
    timingSafeEqual(leftBuffer, rightBuffer)
  );
}

function sameBinding(
  left: ToolApprovalBinding,
  right: ToolApprovalBinding,
): boolean {
  return (
    sameValue(left.runId, right.runId) &&
    sameValue(left.operation, right.operation) &&
    sameValue(left.invocation, right.invocation) &&
    sameValue(left.target, right.target)
  );
}

/** Request a human decision through the configured trusted control surface. */
export async function requestToolApproval(
  input: Omit<ToolApprovalRequest, "requestId" | "expiresAt">,
  ttlMs = TOOL_APPROVAL_TTL_MS,
): Promise<string | undefined> {
  if (!presenter || ttlMs <= 0) return undefined;
  const requestId = randomBytes(24).toString("base64url");
  const request: ToolApprovalRequest = {
    ...input,
    requestId,
    expiresAt: Date.now() + ttlMs,
  };

  return await new Promise<string | undefined>((resolve) => {
    const timer = setTimeout(() => {
      const pending = pendingApprovals.get(requestId);
      if (!pending) return;
      pendingApprovals.delete(requestId);
      pending.resolve(undefined);
    }, ttlMs);
    timer.unref();
    pendingApprovals.set(requestId, { request, resolve, timer });

    void presenter?.(request)
      .then((controlSurface) => {
        const pending = pendingApprovals.get(requestId);
        if (!pending) return;
        if (controlSurface.authorizedUserIds.length === 0) {
          clearTimeout(pending.timer);
          pendingApprovals.delete(requestId);
          pending.resolve(undefined);
          return;
        }
        pending.controlSurface = controlSurface;
      })
      .catch(() => {
        const pending = pendingApprovals.get(requestId);
        if (!pending) return;
        clearTimeout(pending.timer);
        pendingApprovals.delete(requestId);
        pending.resolve(undefined);
      });
  });
}

/** Resolve exactly one pending request from its bound Discord control surface. */
export function decideToolApproval(
  interaction: ToolApprovalInteraction,
): ToolApprovalDecisionResult {
  const pending = pendingApprovals.get(interaction.requestId);
  if (!pending) return "unknown";
  if (Date.now() >= pending.request.expiresAt) {
    pendingApprovals.delete(interaction.requestId);
    clearTimeout(pending.timer);
    pending.resolve(undefined);
    return "expired";
  }
  const surface = pending.controlSurface;
  if (
    !surface ||
    !sameValue(surface.discordBotId, interaction.discordBotId) ||
    !sameValue(surface.channelId, interaction.channelId) ||
    !sameValue(surface.messageId, interaction.messageId) ||
    !surface.authorizedUserIds.some((id) => sameValue(id, interaction.userId))
  ) {
    return "unauthorized";
  }

  pendingApprovals.delete(interaction.requestId);
  clearTimeout(pending.timer);
  if (interaction.decision === "deny") {
    pending.resolve(undefined);
    return "denied";
  }

  const token = randomBytes(32).toString("base64url");
  grants.set(token, {
    binding: pending.request,
    expiresAt: pending.request.expiresAt,
  });
  pending.resolve(token);
  return "approved";
}

/** Consume a short-lived grant once, only for its exact trusted binding. */
export function consumeToolApproval(
  token: string,
  binding: ToolApprovalBinding,
): boolean {
  const grant = grants.get(token);
  if (!grant) return false;
  grants.delete(token);
  return Date.now() < grant.expiresAt && sameBinding(grant.binding, binding);
}

/** Revoke unresolved approvals and grants, used during shutdown and tests. */
export function clearToolApprovals(): void {
  for (const pending of pendingApprovals.values()) {
    clearTimeout(pending.timer);
    pending.resolve(undefined);
  }
  pendingApprovals.clear();
  grants.clear();
}
