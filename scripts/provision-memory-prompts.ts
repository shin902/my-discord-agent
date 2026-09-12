import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { loadMemoryCoreConnectionSettingsFromCron } from "../src/memory/cron-settings.js";
import { MemoryCoreClient } from "../src/memory/memory-core.js";

const layers = ["l1", "l2", "l3"] as const;
type Layer = (typeof layers)[number];

type PromptRecord = {
  memory_prompt_id: string;
  name: string;
  layer: Layer;
  prompt: string;
};

const client = new MemoryCoreClient(
  await loadMemoryCoreConnectionSettingsFromCron(),
);
const { teamId, agentId } = client.settings;

async function request<T>(path: string, body?: object): Promise<T> {
  return client.request<T>(path, { body, requireData: true });
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
