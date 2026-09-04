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

export interface ToolApprovalClaim {
  requestId: string;
  decision: ToolApprovalDecision;
}
export type ToolApprovalClaimResult =
  | ToolApprovalClaim
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
  state: "pending";
  request: ToolApprovalRequest;
  controlSurface?: ToolApprovalControlSurface;
  resolve: (token: string | undefined) => void;
  timer: NodeJS.Timeout;
};

type ClaimedApproval = {
  state: "claimed";
  request: ToolApprovalRequest;
  claim: ToolApprovalClaim;
  resolve: (token: string | undefined) => void;
  timer: NodeJS.Timeout;
};

type Approval = PendingApproval | ClaimedApproval;

type ApprovalGrant = {
  binding: ToolApprovalBinding;
  expiresAt: number;
};

const pendingApprovals = new Map<string, Approval>();
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
      const approval = pendingApprovals.get(requestId);
      if (!approval) return;
      pendingApprovals.delete(requestId);
      approval.resolve(undefined);
    }, ttlMs);
    timer.unref();
    pendingApprovals.set(requestId, {
      state: "pending",
      request,
      resolve,
      timer,
    });

    void presenter?.(request)
      .then((controlSurface) => {
        const approval = pendingApprovals.get(requestId);
        if (!approval || approval.state !== "pending") return;
        if (controlSurface.authorizedUserIds.length === 0) {
          clearTimeout(approval.timer);
          pendingApprovals.delete(requestId);
          approval.resolve(undefined);
          return;
        }
        approval.controlSurface = controlSurface;
      })
      .catch(() => {
        const approval = pendingApprovals.get(requestId);
        if (!approval) return;
        clearTimeout(approval.timer);
        pendingApprovals.delete(requestId);
        approval.resolve(undefined);
      });
  });
}

/** Atomically claim one pending request from its bound Discord control surface. */
export function claimToolApproval(
  interaction: ToolApprovalInteraction,
): ToolApprovalClaimResult {
  const approval = pendingApprovals.get(interaction.requestId);
  if (!approval || approval.state !== "pending") return "unknown";
  if (Date.now() >= approval.request.expiresAt) {
    pendingApprovals.delete(interaction.requestId);
    clearTimeout(approval.timer);
    approval.resolve(undefined);
    return "expired";
  }
  const surface = approval.controlSurface;
  if (
    !surface ||
    !sameValue(surface.discordBotId, interaction.discordBotId) ||
    !sameValue(surface.channelId, interaction.channelId) ||
    !sameValue(surface.messageId, interaction.messageId) ||
    !surface.authorizedUserIds.some((id) => sameValue(id, interaction.userId))
  ) {
    return "unauthorized";
  }

  const claim: ToolApprovalClaim = {
    requestId: interaction.requestId,
    decision: interaction.decision,
  };
  pendingApprovals.set(interaction.requestId, {
    state: "claimed",
    request: approval.request,
    claim,
    resolve: approval.resolve,
    timer: approval.timer,
  });
  return claim;
}

/** Finalize a previously claimed request after its Discord update succeeds. */
export function finalizeToolApproval(
  claim: ToolApprovalClaim,
): ToolApprovalDecisionResult {
  const approval = pendingApprovals.get(claim.requestId);
  if (!approval || approval.state !== "claimed" || approval.claim !== claim)
    return "unknown";

  pendingApprovals.delete(claim.requestId);
  clearTimeout(approval.timer);
  if (Date.now() >= approval.request.expiresAt) {
    approval.resolve(undefined);
    return "expired";
  }
  if (claim.decision === "deny") {
    approval.resolve(undefined);
    return "denied";
  }

  const token = randomBytes(32).toString("base64url");
  grants.set(token, {
    binding: approval.request,
    expiresAt: approval.request.expiresAt,
  });
  approval.resolve(token);
  return "approved";
}

/** Fail closed when the Discord update outcome is unknown. */
export function cancelToolApproval(claim: ToolApprovalClaim): boolean {
  const approval = pendingApprovals.get(claim.requestId);
  if (!approval || approval.state !== "claimed" || approval.claim !== claim)
    return false;
  pendingApprovals.delete(claim.requestId);
  clearTimeout(approval.timer);
  approval.resolve(undefined);
  return true;
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
