import { createHash } from "node:crypto";
import type { AgentMemoryConfig } from "../config/agent-memory.js";
import { NonRetryableError } from "../utils/error.js";

export interface AgentMemoryMessage {
  role: "user" | "assistant";
  content: string;
  timestamp: string;
}

export interface AgentMemoryScope {
  teamId: string;
  agentId: string;
  userId: string;
  sessionId: string;
}

export interface AgentMemorySubmission {
  scope: AgentMemoryScope;
  messages: AgentMemoryMessage[];
}

export interface AgentMemoryAdmission {
  groupName: string;
  /** Configured channel used for fresh group mapping validation. */
  routingChannelId: string;
  channelId: string;
  baseUrl: string;
  serviceId: string;
  bearerTokenEnv?: string;
  teamId: string;
  agentId: string;
  userId: string;
  sessionId: string;
  fingerprint: string;
}

function admissionFingerprint(
  input: Omit<AgentMemoryAdmission, "fingerprint">,
): string {
  return createHash("sha256").update(JSON.stringify(input)).digest("hex");
}

export function buildAgentMemoryAdmission(
  input: Omit<AgentMemoryAdmission, "fingerprint">,
): AgentMemoryAdmission {
  return { ...input, fingerprint: admissionFingerprint(input) };
}

export function isCurrentAgentMemoryAdmission(
  admission: AgentMemoryAdmission,
  config: AgentMemoryConfig,
  message: { groupName: string; routingChannelId: string; channelId: string },
): boolean {
  const current = buildAgentMemoryAdmission({
    groupName: message.groupName,
    routingChannelId: message.routingChannelId,
    channelId: message.channelId,
    baseUrl: config.baseUrl,
    serviceId: config.serviceId,
    ...(config.bearerTokenEnv ? { bearerTokenEnv: config.bearerTokenEnv } : {}),
    teamId: config.teamId,
    agentId: config.agentId,
    userId: admission.userId,
    sessionId: admission.sessionId,
  });
  return (
    admission.fingerprint === current.fingerprint &&
    JSON.stringify(admission) === JSON.stringify(current)
  );
}

export interface AgentMemorySubmissionResult {
  requestId?: string;
  acceptedIds: string[];
  totalCount: number;
}

export class AgentMemoryHttpError extends Error {
  readonly retryable: boolean;
  readonly status?: number;

  constructor(message: string, status?: number, retryable?: boolean) {
    super(message);
    this.name = "AgentMemoryHttpError";
    this.status = status;
    this.retryable =
      retryable ??
      (status === undefined ||
        status === 408 ||
        status === 429 ||
        status >= 500);
  }
}

interface ApiEnvelope {
  code?: number;
  message?: string;
  request_id?: string;
  data?: {
    accepted_ids?: unknown;
    total_count?: unknown;
  };
}

export class AgentMemoryClient {
  constructor(private readonly config: AgentMemoryConfig) {}

  async addConversation(
    submission: AgentMemorySubmission,
  ): Promise<AgentMemorySubmissionResult> {
    const token = this.config.bearerTokenEnv
      ? process.env[this.config.bearerTokenEnv]
      : undefined;
    if (this.config.bearerTokenEnv && !token) {
      throw new NonRetryableError(`${this.config.bearerTokenEnv} is not set`);
    }
    const endpoint = new URL(this.config.baseUrl);
    endpoint.pathname = `${endpoint.pathname.replace(/\/$/u, "")}/v3/conversation/add`;
    const headers: Record<string, string> = {
      "content-type": "application/json",
      "x-tdai-service-id": this.config.serviceId,
    };
    if (token) headers.authorization = `Bearer ${token}`;
    let response: Response;
    try {
      response = await fetch(endpoint.toString(), {
        method: "POST",
        redirect: "error",
        headers,
        body: JSON.stringify({
          session_id: submission.scope.sessionId,
          team_id: submission.scope.teamId,
          agent_id: submission.scope.agentId,
          user_id: submission.scope.userId,
          messages: submission.messages,
        }),
        signal: AbortSignal.timeout(this.config.timeoutMs),
      });
    } catch (error) {
      const cause = error instanceof Error ? error.cause : undefined;
      if (cause instanceof Error && cause.message === "unexpected redirect")
        throw new AgentMemoryHttpError(
          "Agent Memory conversation/add rejected a redirect",
          undefined,
          false,
        );
      throw error;
    }
    const body = (await response.json().catch(() => ({}))) as ApiEnvelope;
    const errorCode = body.code === undefined ? response.status : body.code;
    if (!response.ok || errorCode !== 0) {
      const retryable =
        errorCode === 408 || errorCode === 429 || errorCode >= 500;
      throw new AgentMemoryHttpError(
        `Agent Memory conversation/add failed (${response.status}): ${body.message ?? "unknown error"} (code ${errorCode})`,
        response.status,
        retryable,
      );
    }
    const acceptedIds = Array.isArray(body.data?.accepted_ids)
      ? body.data.accepted_ids.filter(
          (value): value is string => typeof value === "string",
        )
      : [];
    const totalCount =
      typeof body.data?.total_count === "number"
        ? body.data.total_count
        : acceptedIds.length;
    return { requestId: body.request_id, acceptedIds, totalCount };
  }
}

export function buildAgentMemorySubmission(input: {
  teamId: string;
  agentId: string;
  userId: string;
  sessionId: string;
  userContent: string;
  assistantContent: string;
  userTimestamp: string;
  assistantTimestamp: string;
}): AgentMemorySubmission {
  return {
    scope: {
      teamId: input.teamId,
      agentId: input.agentId,
      userId: input.userId,
      sessionId: input.sessionId,
    },
    messages: [
      {
        role: "user",
        content: input.userContent,
        timestamp: input.userTimestamp,
      },
      {
        role: "assistant",
        content: input.assistantContent,
        timestamp: input.assistantTimestamp,
      },
    ],
  };
}
