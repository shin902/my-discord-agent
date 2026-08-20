import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { Api, Model } from "@earendil-works/pi-ai";
import { Client } from "discord.js";
import { describe, expect, it, vi } from "vitest";
import type { MailDependencies } from "./mail.js";
import { createMailHandler } from "./mail.js";
import type { CronContext } from "../runner.js";

function context(channel: { type: number; send: ReturnType<typeof vi.fn> }): CronContext {
  const client = new Client({ intents: [] });
  client.channels.fetch = vi.fn().mockResolvedValue(channel);
  return { id: "mail", schedule: "15m", enabled: true, handler: "jobs/mail.ts", groupName: "mail", channelId: "channel", appendInbox: vi.fn(), client };
}
const model: Model<Api> = {
  id: "model",
  name: "model",
  api: "test",
  provider: "test",
  baseUrl: "http://localhost",
  reasoning: false,
  input: ["text"],
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  contextWindow: 4096,
  maxTokens: 1024,
};

function assistant(stopReason: "stop" | "error"): AgentMessage {
  return {
    role: "assistant",
    content: [],
    api: "test",
    provider: "test",
    model: "model",
    usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
    stopReason,
    timestamp: Date.now(),
  };
}

function deps(fetchImpl: MailDependencies["fetch"], agentMessage: AgentMessage): MailDependencies { return { fetch: fetchImpl, getProxyPort: () => 1234, findGroupByName: vi.fn(async () => undefined), resolveModelConfig: vi.fn(async () => ({ provider: "test", modelId: "model" })), resolveModel: vi.fn(async () => model), runTextOnlyAgent: vi.fn(async () => ({ text: "要約", agentMessage })), appendMessage: vi.fn(async () => undefined) }; }
function responses(): Response[] { return [new Response(JSON.stringify({ value: [{ id: "mail-1", subject: "件名", from: { emailAddress: { name: "送信者", address: "from@example.com" } } }] })), new Response(JSON.stringify({ body: { contentType: "text", content: "本文" } })), new Response(JSON.stringify({ ok: true }))]; }

describe("mail cron delivery boundary", () => {
  it("正常な要約はDiscord送信後に既読化する", async () => { const fetchMock = vi.fn<typeof fetch>(); for (const response of responses()) fetchMock.mockResolvedValueOnce(response); const send = vi.fn().mockResolvedValue({ startThread: vi.fn().mockResolvedValue({ id: "thread", send: vi.fn() }) }); await createMailHandler(deps(fetchMock, assistant("stop")))(context({ type: 0, send })); expect(send).toHaveBeenCalledOnce(); expect(fetchMock).toHaveBeenLastCalledWith("http://localhost:1234/graph/me/messages/mail-1", expect.objectContaining({ method: "PATCH" })); });
  it("不完全なassistant応答は送信・既読化しない", async () => { const fetchMock = vi.fn<typeof fetch>(); for (const response of responses().slice(0, 2)) fetchMock.mockResolvedValueOnce(response); const send = vi.fn(); await createMailHandler(deps(fetchMock, assistant("error")))(context({ type: 0, send })); expect(send).not.toHaveBeenCalled(); expect(fetchMock).toHaveBeenCalledTimes(2); });
});
