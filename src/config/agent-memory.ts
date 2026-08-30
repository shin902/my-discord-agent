import { z } from "zod";
import { loadRawConfigFresh } from "./config.js";

function isLoopbackHostname(hostname: string): boolean {
  const host = hostname.toLowerCase().replace(/^\[|\]$/gu, "");
  return host === "localhost" || host === "127.0.0.1" || host === "::1";
}

const AgentMemoryBaseUrlSchema = z.string().refine((value) => {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return false;
  }
  if (
    !["http:", "https:"].includes(url.protocol) ||
    url.username !== "" ||
    url.password !== "" ||
    url.search !== "" ||
    url.hash !== ""
  )
    return false;
  return url.protocol === "https:" || isLoopbackHostname(url.hostname);
}, "must be HTTPS or unauthenticated loopback HTTP without credentials/query/fragment");

export const AgentMemoryConfigSchema = z.object({
  enabled: z.boolean().default(false),
  baseUrl: AgentMemoryBaseUrlSchema.default("http://localhost:8420"),
  serviceId: z.string().min(1).default("default"),
  // Local MemoryCore is unauthenticated by default; protected deployments may
  // opt in by naming an environment variable containing a bearer token.
  bearerTokenEnv: z.string().min(1).optional(),
  teamId: z.string().min(1).default("default"),
  agentId: z.string().min(1).default("my-discord-agent"),
  // Operators explicitly declare these groups private and eligible for shadow capture.
  eligibleGroups: z.array(z.string().min(1)).default([]),
  timeoutMs: z.number().int().positive().max(120_000).default(10_000),
});
export type AgentMemoryConfig = z.infer<typeof AgentMemoryConfigSchema>;

const DEFAULT_CONFIG: AgentMemoryConfig = AgentMemoryConfigSchema.parse({});

export function isAgentMemoryEligible(
  config: AgentMemoryConfig,
  message: {
    groupName: string;
    userId?: string;
    authorIsBot?: boolean;
    botId?: string;
    cronJobId?: string;
    cronThread?: boolean;
    cronProvisioning?: boolean;
    mailEmailId?: string;
    rssDispatchId?: string;
    botTaskSessionAdmission?: boolean;
    memoryShadow?: unknown;
  },
): boolean {
  return (
    config.enabled &&
    config.eligibleGroups.includes(message.groupName) &&
    message.userId !== undefined &&
    message.userId.length > 0 &&
    message.authorIsBot !== true &&
    message.botId === undefined &&
    message.cronJobId === undefined &&
    message.cronThread !== true &&
    message.cronProvisioning !== true &&
    message.mailEmailId === undefined &&
    message.rssDispatchId === undefined &&
    message.botTaskSessionAdmission !== true &&
    message.memoryShadow === undefined
  );
}

// agentMemory is a cohesive object, so parse the whole section while preserving
// the same fallback-on-invalid behavior used by other config loaders.
export async function loadAgentMemoryConfig(): Promise<AgentMemoryConfig> {
  const raw = await loadRawConfigFresh();
  const parsed = AgentMemoryConfigSchema.safeParse(raw.agentMemory ?? {});
  if (!parsed.success) {
    console.warn(
      "[agentMemory] 設定が不正、デフォルト使用:",
      parsed.error.message,
    );
    return DEFAULT_CONFIG;
  }
  return parsed.data;
}
