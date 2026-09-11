import { readFile } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";

const PROMPT_FILE = "config/memory-core-prompts.example.json";
const LAYERS = ["l1", "l2", "l3"] as const;

const PromptDefinitionSchema = z.object({
  name: z.string().min(1).max(100),
  layer: z.enum(LAYERS),
  prompt: z.string().min(1).max(10_000),
});

const PromptPlanSchema = z
  .object({
    teamId: z.string().min(1),
    agentId: z.string().min(1),
    prompts: z.array(PromptDefinitionSchema).min(1).max(3),
  })
  .superRefine((plan, ctx) => {
    const layers = plan.prompts.map((prompt) => prompt.layer);
    if (new Set(layers).size !== layers.length) {
      ctx.addIssue({
        code: "custom",
        path: ["prompts"],
        message: "prompts must contain at most one definition per layer",
      });
    }
  });

const ExistingPromptSchema = z.object({
  memory_prompt_id: z.string().min(1),
  name: z.string(),
  layer: z.enum(LAYERS),
  status: z.enum(["active", "deleting"]).optional(),
});

export type MemoryPromptPlan = z.infer<typeof PromptPlanSchema>;
export type MemoryPromptDefinition = MemoryPromptPlan["prompts"][number];

export interface PromptProvisionOptions {
  baseUrl: string;
  serviceId: string;
  apiKey?: string;
  timeoutMs?: number;
  plan: MemoryPromptPlan;
  fetchImpl?: typeof fetch;
}

export interface PromptProvisionAction {
  layer: MemoryPromptDefinition["layer"];
  name: string;
  action: "created" | "updated";
  memoryPromptId: string;
}

export interface PromptProvisionResult {
  target: { teamId: string; agentId: string };
  actions: PromptProvisionAction[];
}

export function defaultMemoryPromptFile(): string {
  return path.resolve(process.cwd(), PROMPT_FILE);
}

export async function loadMemoryPromptPlan(
  filePath = defaultMemoryPromptFile(),
): Promise<MemoryPromptPlan> {
  const raw = await readFile(filePath, "utf8");
  return PromptPlanSchema.parse(JSON.parse(raw));
}

export function applyPromptTargetOverrides(
  plan: MemoryPromptPlan,
  env: NodeJS.ProcessEnv = process.env,
): MemoryPromptPlan {
  return {
    ...plan,
    teamId: env.MEMORY_CORE_TEAM_ID?.trim() || plan.teamId,
    agentId: env.MEMORY_CORE_AGENT_ID?.trim() || plan.agentId,
  };
}

function parseBaseUrl(value: string): URL {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error("Invalid MemoryCore base URL");
  }
  const isLoopbackHttp =
    url.protocol === "http:" &&
    (url.hostname === "127.0.0.1" || url.hostname === "[::1]");
  if (
    !url.username &&
    !url.password &&
    !url.search &&
    !url.hash &&
    (url.protocol === "https:" || isLoopbackHttp)
  ) {
    return url;
  }
  throw new Error(
    "MemoryCore base URL must be HTTPS or literal loopback HTTP without credentials/query/fragment",
  );
}

function endpoint(baseUrl: string, route: string): string {
  const url = parseBaseUrl(baseUrl);
  url.pathname = `${url.pathname.replace(/\/$/u, "")}${route}`;
  return url.toString();
}

function responseCode(body: unknown): number | undefined {
  if (!body || typeof body !== "object" || !("code" in body)) return undefined;
  const code = body.code;
  return typeof code === "number" && Number.isSafeInteger(code)
    ? code
    : undefined;
}

function responseData(body: unknown): unknown {
  if (!body || typeof body !== "object" || !("data" in body)) return undefined;
  return body.data;
}

async function request(
  options: PromptProvisionOptions,
  route: string,
  body: Record<string, unknown>,
): Promise<unknown> {
  const fetchImpl = options.fetchImpl ?? fetch;
  const headers: Record<string, string> = {
    "content-type": "application/json",
    "x-tdai-service-id": options.serviceId,
  };
  if (options.apiKey) headers.authorization = `Bearer ${options.apiKey}`;

  const url = endpoint(options.baseUrl, route);
  let response: Response;
  try {
    response = await fetchImpl(url, {
      method: "POST",
      redirect: "error",
      headers,
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(options.timeoutMs ?? 10_000),
    });
  } catch {
    throw new Error("MemoryCore prompt request failed or timed out");
  }

  let payload: unknown;
  try {
    payload = await response.json();
  } catch {
    throw new Error(
      `MemoryCore prompt request returned invalid JSON (${response.status})`,
    );
  }
  const code = responseCode(payload);
  if (!response.ok || code !== 0) {
    throw new Error(
      `MemoryCore prompt request failed (${response.status}, code ${code ?? "unknown"})`,
    );
  }
  return responseData(payload);
}

function promptItems(
  data: unknown,
): Array<z.infer<typeof ExistingPromptSchema>> {
  if (
    !data ||
    typeof data !== "object" ||
    !("items" in data) ||
    !Array.isArray(data.items)
  ) {
    throw new Error("MemoryCore prompt list returned an invalid payload");
  }
  return data.items.flatMap((item) => {
    const parsed = ExistingPromptSchema.safeParse(item);
    return parsed.success ? [parsed.data] : [];
  });
}

function createdPromptId(data: unknown): string {
  if (
    !data ||
    typeof data !== "object" ||
    !("memory_prompt_id" in data) ||
    typeof data.memory_prompt_id !== "string"
  ) {
    throw new Error("MemoryCore prompt create returned an invalid payload");
  }
  return data.memory_prompt_id;
}

export async function provisionMemoryPrompts(
  options: PromptProvisionOptions,
): Promise<PromptProvisionResult> {
  if (!options.serviceId.trim())
    throw new Error("MemoryCore service ID is required");
  if (
    !Number.isInteger(options.timeoutMs ?? 10_000) ||
    (options.timeoutMs ?? 10_000) <= 0
  ) {
    throw new Error("MemoryCore prompt timeout must be a positive integer");
  }

  const actions: PromptProvisionAction[] = [];
  for (const definition of options.plan.prompts) {
    const data = await request(options, "/v3/memory-prompt/get", {
      layer: definition.layer,
      limit: 100,
    });
    const existing = promptItems(data).find(
      (prompt) =>
        prompt.name === definition.name &&
        prompt.layer === definition.layer &&
        prompt.status !== "deleting",
    );

    let memoryPromptId: string;
    let action: PromptProvisionAction["action"];
    if (existing) {
      await request(options, "/v3/memory-prompt/update", {
        memory_prompt_id: existing.memory_prompt_id,
        name: definition.name,
        prompt: definition.prompt,
      });
      memoryPromptId = existing.memory_prompt_id;
      action = "updated";
    } else {
      const created = await request(options, "/v3/memory-prompt/create", {
        name: definition.name,
        layer: definition.layer,
        prompt: definition.prompt,
      });
      memoryPromptId = createdPromptId(created);
      action = "created";
    }

    await request(options, "/v3/memory-prompt/set", {
      action: "apply",
      memory_prompt_id: memoryPromptId,
      team_id: options.plan.teamId,
      agent_ids: [options.plan.agentId],
      layer: definition.layer,
    });
    actions.push({
      layer: definition.layer,
      name: definition.name,
      action,
      memoryPromptId,
    });
  }

  return {
    target: { teamId: options.plan.teamId, agentId: options.plan.agentId },
    actions,
  };
}
