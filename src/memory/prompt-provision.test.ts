import { readFile } from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  applyPromptTargetOverrides,
  loadMemoryPromptPlan,
  provisionMemoryPrompts,
} from "./prompt-provision.js";

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("MemoryCore prompt provisioning", () => {
  it("loads the Japanese L1/L2/L3 fixture with activity-time guidance", async () => {
    const plan = await loadMemoryPromptPlan();

    expect(plan.prompts.map((prompt) => prompt.layer)).toEqual([
      "l1",
      "l2",
      "l3",
    ]);
    expect(plan.prompts[0]?.prompt).toContain("metadata.activity_start_time");
    expect(plan.prompts[1]?.prompt).toContain("created_at");
    expect(plan.prompts[2]?.prompt).toContain("persona.md");
  });

  it("applies environment target overrides without changing prompt definitions", async () => {
    const plan = await loadMemoryPromptPlan();
    vi.stubEnv("MEMORY_CORE_TEAM_ID", "team-override");
    vi.stubEnv("MEMORY_CORE_AGENT_ID", "agent-override");

    expect(applyPromptTargetOverrides(plan)).toEqual({
      ...plan,
      teamId: "team-override",
      agentId: "agent-override",
    });
  });

  it("updates an existing prompt and creates a missing layer idempotently", async () => {
    const plan = await loadMemoryPromptPlan();
    const calls: Array<{ url: string; init?: RequestInit }> = [];
    const fetchImpl = vi.fn(async (input: string | URL, init?: RequestInit) => {
      calls.push({ url: String(input), init });
      const route = new URL(String(input)).pathname;
      const body = JSON.parse(String(init?.body));

      if (route.endsWith("/v3/memory-prompt/get") && body.layer === "l1") {
        return new Response(
          JSON.stringify({
            code: 0,
            data: {
              items: [
                {
                  memory_prompt_id: "prompt-l1",
                  name: plan.prompts[0]?.name,
                  layer: "l1",
                },
              ],
            },
          }),
        );
      }
      if (route.endsWith("/v3/memory-prompt/get")) {
        return new Response(JSON.stringify({ code: 0, data: { items: [] } }));
      }
      if (route.endsWith("/v3/memory-prompt/create")) {
        return new Response(
          JSON.stringify({ code: 0, data: { memory_prompt_id: "prompt-l2" } }),
        );
      }
      return new Response(JSON.stringify({ code: 0, data: {} }));
    }) as unknown as typeof fetch;

    const result = await provisionMemoryPrompts({
      baseUrl: "https://memory.example/base/",
      serviceId: "service",
      apiKey: "private-token",
      plan: { ...plan, prompts: plan.prompts.slice(0, 2) },
      fetchImpl,
    });

    expect(result.actions).toEqual([
      {
        layer: "l1",
        name: plan.prompts[0]?.name,
        action: "updated",
        memoryPromptId: "prompt-l1",
      },
      {
        layer: "l2",
        name: plan.prompts[1]?.name,
        action: "created",
        memoryPromptId: "prompt-l2",
      },
    ]);
    expect(calls.map((call) => new URL(call.url).pathname)).toEqual([
      "/base/v3/memory-prompt/get",
      "/base/v3/memory-prompt/update",
      "/base/v3/memory-prompt/set",
      "/base/v3/memory-prompt/get",
      "/base/v3/memory-prompt/create",
      "/base/v3/memory-prompt/set",
    ]);
    expect(calls[2]?.init).toMatchObject({
      headers: {
        authorization: "Bearer private-token",
        "x-tdai-service-id": "service",
      },
    });
    expect(JSON.parse(String(calls[2]?.init?.body))).toMatchObject({
      action: "apply",
      memory_prompt_id: "prompt-l1",
      team_id: "default",
      agent_ids: ["my-discord-agent"],
      layer: "l1",
    });
  });

  it("rejects non-loopback HTTP prompt endpoints before any network call", async () => {
    const fetchImpl = vi.fn() as unknown as typeof fetch;
    const plan = await loadMemoryPromptPlan();

    await expect(
      provisionMemoryPrompts({
        baseUrl: "http://memory.example",
        serviceId: "service",
        plan: { ...plan, prompts: plan.prompts.slice(0, 1) },
        fetchImpl,
      }),
    ).rejects.toThrow("HTTPS or literal loopback HTTP");
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("keeps the activity timestamp fixture separate from generated time", async () => {
    const fixture = JSON.parse(
      await readFile(
        path.join(
          process.cwd(),
          "src/memory/fixtures/l1-record-with-activity.json",
        ),
        "utf8",
      ),
    ) as { created_at: string; metadata: Record<string, string> };

    expect(fixture.created_at).toBe("2026-09-11T01:00:00.000Z");
    expect(fixture.metadata).toEqual({
      activity_start_time: "2026-09-10T18:30:00.000Z",
      activity_end_time: "2026-09-10T19:15:00.000Z",
    });
  });

  it("keeps the upstream patch focused on forwarding activity metadata", async () => {
    const patch = await readFile(
      path.join(
        process.cwd(),
        "patches/tencentdb-memory-core-activity-metadata.patch",
      ),
      "utf8",
    );

    expect(patch).toContain("metadata: pickActivityTimeMetadata(r.metadata)");
    expect(patch).toContain("metadata: r.metadata");
    expect(patch).toContain("activity_start_time?: string");
    expect(patch).toContain("activity_end_time?: string");
  });
});
