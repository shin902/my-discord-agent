import { describe, expect, it } from "vitest";
import { pickAgentConfig, resolveAgentConfig } from "./agent-resolution.js";

const group = {
  model: {
    provider: "group-provider",
    modelId: "group-model",
    thinkingLevel: "high" as const,
  },
  tools: ["group-tool"],
  approvalRequiredTools: ["group-approval"],
  skills: ["group-skill"],
  mounts: [{ host: "group", container: "/group" }],
  contextFiles: [{ path: "MEMORY.md", maxChars: 2000 as const }],
};

const channel = {
  model: { provider: "channel-provider", modelId: "channel-model" },
  tools: [],
  approvalRequiredTools: [],
  skills: ["channel-skill"],
  mounts: [{ host: "channel", container: "/channel", readOnly: true }],
  contextFiles: [],
};

describe("resolveAgentConfig", () => {
  it("親から子へフィールド単位で完全置換する", () => {
    expect(
      resolveAgentConfig(group, channel, {
        tools: ["job-tool"],
        approvalRequiredTools: ["job-approval"],
      }),
    ).toEqual({
      model: { provider: "channel-provider", modelId: "channel-model" },
      tools: ["job-tool"],
      approvalRequiredTools: ["job-approval"],
      skills: ["channel-skill"],
      mounts: [{ host: "channel", container: "/channel", readOnly: true }],
      contextFiles: [],
    });
  });

  it("指定されていないフィールドは親を継承し、配列を加算しない", () => {
    expect(resolveAgentConfig(group, { tools: ["channel-tool"] })).toEqual({
      model: group.model,
      tools: ["channel-tool"],
      approvalRequiredTools: group.approvalRequiredTools,
      skills: group.skills,
      mounts: group.mounts,
      contextFiles: group.contextFiles,
    });
  });

  it("group限定のallowMention/toolLogArgsを共通設定へ持ち込まない", () => {
    const groupWithDeliverySettings = {
      ...group,
      allowMention: true,
      toolLogArgs: true,
    };
    expect(pickAgentConfig(groupWithDeliverySettings)).toEqual({
      model: group.model,
      tools: group.tools,
      approvalRequiredTools: group.approvalRequiredTools,
      skills: group.skills,
      mounts: group.mounts,
      contextFiles: group.contextFiles,
    });
  });

  it("inherits, replaces and clears toolSets independently of tools and skills", () => {
    const parent = { tools: ["bash"], skills: ["web"], toolSets: ["web"] };
    expect(resolveAgentConfig(parent, { skills: [] })).toEqual({
      ...parent,
      skills: [],
    });
    expect(resolveAgentConfig(parent, { toolSets: ["calendar"] })).toEqual({
      ...parent,
      toolSets: ["calendar"],
    });
    expect(resolveAgentConfig(parent, { toolSets: [] })).toEqual({
      ...parent,
      toolSets: [],
    });
  });

  it("tools未指定のeffective configは空配列になる", () => {
    expect(resolveAgentConfig()).toEqual({ tools: [] });
  });
});
