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
  const url = new URL(baseUrl);
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
    throw new Error(
      "MEMORY_CORE_URL must be HTTPS or literal loopback HTTP without credentials, query, or fragment",
    );
  }
  const route = new URL(path, "https://memory-core.invalid");
  url.pathname = `${url.pathname.replace(/\/$/u, "")}${route.pathname}`;
  url.search = route.search;
  return url;
}

async function request<T>(path: string, body?: object): Promise<T> {
  const url = memoryCoreUrl(path);
  if (!body) {
    url.searchParams.set("limit", "100");
  }
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
    });
    envelope = (await response.json()) as Envelope<T>;
  } catch {
    throw new Error("MemoryCore request failed or timed out");
  }
  if (!response.ok || envelope.code !== 0 || envelope.data === undefined) {
    throw new Error(
      `MemoryCore ${path} failed (${response.status}, code ${envelope.code}): ${envelope.message ?? "unknown error"}`,
    );
  }
  return envelope.data;
}

async function provision(layer: Layer): Promise<void> {
  const scopeHash = createHash("sha256")
    .update(`${teamId}\0${agentId}`)
    .digest("hex")
    .slice(0, 12);
  const name = `my-discord-agent ${layer.toUpperCase()} quality ${scopeHash}`;
  const prompt = (await readFile(new URL(`./memory-prompts/${layer}.md`, import.meta.url), "utf8")).trim();
  const listed = await request<{ items: PromptRecord[] }>(
    `/v3/memory-prompt/get?layer=${layer}`,
  );
  const matches = listed.items.filter((item) => item.name === name);
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
  console.log(`${layer.toUpperCase()}: ${promptId} (effective for ${teamId}/${agentId})`);
}

for (const layer of layers) await provision(layer);
