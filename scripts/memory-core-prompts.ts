import {
  applyPromptTargetOverrides,
  defaultMemoryPromptFile,
  loadMemoryPromptPlan,
  provisionMemoryPrompts,
} from "../src/memory/prompt-provision.js";

function envNumber(name: string, fallback: number): number {
  const raw = process.env[name]?.trim();
  if (!raw) return fallback;
  const value = Number(raw);
  if (!Number.isInteger(value) || value <= 0) {
    throw new Error(`${name} must be a positive integer`);
  }
  return value;
}

const filePath =
  process.env.MEMORY_CORE_PROMPTS_FILE?.trim() || defaultMemoryPromptFile();
const apiKey = process.env.MEMORY_CORE_GATEWAY_API_KEY?.trim();
if (!apiKey) {
  throw new Error("MEMORY_CORE_GATEWAY_API_KEY is required for MemoryCore v3");
}
const plan = applyPromptTargetOverrides(await loadMemoryPromptPlan(filePath));
const result = await provisionMemoryPrompts({
  baseUrl:
    process.env.MEMORY_CORE_BASE_URL?.trim() ||
    `http://127.0.0.1:${process.env.MEMORY_CORE_PORT?.trim() || "8420"}`,
  serviceId: process.env.MEMORY_CORE_SERVICE_ID?.trim() || "default",
  apiKey,
  timeoutMs: envNumber("MEMORY_CORE_PROMPT_TIMEOUT_MS", 10_000),
  plan,
});

for (const action of result.actions) {
  console.log(
    `${action.layer}: ${action.action} ${action.name} (${action.memoryPromptId})`,
  );
}
console.log(
  `Applied ${result.actions.length} prompt(s) to team=${result.target.teamId}, ` +
    `agent=${result.target.agentId}`,
);
