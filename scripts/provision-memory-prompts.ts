import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";

const layers = ["l1", "l2", "l3"] as const;
type Layer = (typeof layers)[number];

type Envelope<T> = { code: number; message?: string; data?: T };
type PromptRecord = {
  memory_prompt_id: string;
  name: string;
  layer: Layer;
  prompt: string;
};

const baseUrl = process.env.MEMORY_CORE_URL ?? "http://127.0.0.1:8420";
const serviceId = process.env.MEMORY_CORE_SERVICE_ID ?? "default";
const teamId = process.env.MEMORY_CORE_TEAM_ID ?? "default";
const agentId = process.env.MEMORY_CORE_AGENT_ID ?? "my-discord-agent";
const token = process.env.MEMORY_CORE_GATEWAY_API_KEY;

function memoryCoreUrl(path: string): URL {
  let url: URL;
  try {
    url = new URL(baseUrl);
  } catch {
    throw new Error("Invalid MemoryCore URL configuration");
  }
  if (
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    (url.protocol !== "https:" &&
      !(
        url.protocol === "http:" &&
        (url.hostname === "127.0.0.1" || url.hostname === "[::1]")
      ))
  ) {
    throw new Error("Invalid MemoryCore URL configuration");
  }
  const route = new URL(path, "https://memory-core.invalid");
  url.pathname = `${url.pathname.replace(/\/$/u, "")}${route.pathname}`;
  url.search = route.search;
  return url;
}

async function request<T>(path: string, body?: object): Promise<T> {
  const url = memoryCoreUrl(path);
  const headers = {
    accept: "application/json",
    ...(body ? { "content-type": "application/json" } : {}),
    "x-tdai-service-id": serviceId,
    ...(token ? { authorization: `Bearer ${token}` } : {}),
  };
  try {
    new Headers(headers);
  } catch {
    throw new Error("Invalid MemoryCore header configuration");
  }
  const signal = AbortSignal.timeout(10_000);
  let response: Response;
  let envelope: Envelope<T>;
  try {
    response = await fetch(url, {
      method: body ? "POST" : "GET",
      headers,
      body: body ? JSON.stringify(body) : undefined,
      signal,
      redirect: "error",
    });
    envelope = (await response.json()) as Envelope<T>;
  } catch {
    throw new Error("MemoryCore request failed or timed out");
  }
  if (!response.ok || envelope.code !== 0 || envelope.data === undefined) {
    const code =
      Number.isSafeInteger(envelope.code) &&
      envelope.code >= 0 &&
      envelope.code <= 999_999
        ? envelope.code
        : "unknown";
    throw new Error(`MemoryCore request failed (${response.status}, code ${code})`);
  }
  return envelope.data;
}

function isPromptRecord(value: unknown): value is PromptRecord {
  if (!value || typeof value !== "object") return false;
  const record = value as Record<string, unknown>;
  return (
    typeof record.memory_prompt_id === "string" &&
    record.memory_prompt_id.trim().length > 0 &&
    typeof record.name === "string" &&
    record.name.trim().length > 0 &&
    Array.from(record.name).length <= 100 &&
    layers.some((layer) => layer === record.layer) &&
    typeof record.prompt === "string" &&
    record.prompt.trim().length > 0 &&
    Array.from(record.prompt).length <= 10_000
  );
}

async function listPrompts(layer: Layer): Promise<PromptRecord[]> {
  const prompts: PromptRecord[] = [];
  while (true) {
    const page = await request<{ items: unknown }>(
      `/v3/memory-prompt/get?layer=${layer}&limit=100&offset=${prompts.length}`,
    );
    if (!Array.isArray(page.items) || !page.items.every(isPromptRecord)) {
      throw new Error("MemoryCore returned an invalid prompt list");
    }
    prompts.push(...page.items);
    if (page.items.length < 100) return prompts;
  }
}

async function provision(layer: Layer): Promise<void> {
  const scopeHash = createHash("sha256")
    .update(`${teamId}\0${agentId}`)
    .digest("hex")
    .slice(0, 12);
  const name = `my-discord-agent ${layer.toUpperCase()} quality ${scopeHash}`;
  const prompt = (await readFile(new URL(`./memory-prompts/${layer}.md`, import.meta.url), "utf8")).trim();
  const matches = (await listPrompts(layer)).filter(
    (item) => item.name === name,
  );
  if (matches.length > 1) {
    throw new Error(`Multiple active MemoryCore prompts named ${JSON.stringify(name)}`);
  }

  let promptId = matches[0]?.memory_prompt_id;
  if (matches[0]?.prompt !== prompt) {
    if (promptId) {
      await request("/v3/memory-prompt/update", {
        memory_prompt_id: promptId,
        prompt,
      });
    } else {
      const created = await request<{ memory_prompt_id: string }>(
        "/v3/memory-prompt/create",
        { name, layer, prompt },
      );
      promptId = created.memory_prompt_id;
    }
  }

  await request("/v3/memory-prompt/set", {
    action: "apply",
    memory_prompt_id: promptId,
    team_id: teamId,
    agent_ids: [agentId],
    layer,
  });
  const effective = await request<PromptRecord & { source: string }>(
    `/v3/memory-prompt/get?team_id=${encodeURIComponent(teamId)}&agent_id=${encodeURIComponent(agentId)}&layer=${layer}`,
  );
  if (
    effective.memory_prompt_id !== promptId ||
    effective.prompt !== prompt ||
    effective.source !== "agent"
  ) {
    throw new Error(`MemoryCore did not return the effective ${layer.toUpperCase()} prompt`);
  }
  console.log(`${layer.toUpperCase()}: effective prompt verified`);
}

for (const layer of layers) await provision(layer);
