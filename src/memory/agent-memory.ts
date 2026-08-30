import type { AgentMemoryConfig } from "../config/agent-memory.js";

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

export interface AgentMemorySubmissionResult {
  requestId?: string;
  acceptedIds: string[];
  totalCount: number;
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
    const token = process.env[this.config.bearerTokenEnv];
    if (!token) throw new Error(`${this.config.bearerTokenEnv} is not set`);
    const response = await fetch(
      `${this.config.baseUrl.replace(/\/$/u, "")}/v3/conversation/add`,
      {
        method: "POST",
        headers: {
          authorization: `Bearer ${token}`,
          "content-type": "application/json",
          "x-tdai-service-id": this.config.serviceId,
        },
        body: JSON.stringify({
          session_id: submission.scope.sessionId,
          team_id: submission.scope.teamId,
          agent_id: submission.scope.agentId,
          user_id: submission.scope.userId,
          messages: submission.messages,
        }),
        signal: AbortSignal.timeout(this.config.timeoutMs),
      },
    );
    const body = (await response.json().catch(() => ({}))) as ApiEnvelope;
    if (!response.ok || body.code !== 0) {
      throw new Error(
        `Agent Memory conversation/add failed (${response.status}): ${body.message ?? "unknown error"}`,
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
