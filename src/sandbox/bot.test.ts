import { afterEach, describe, expect, it, vi } from "vitest";
import { createBotTool } from "./bot.js";

describe("createBotTool", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("runはBotの実行完了後に最終結果とTask Sessionを返す", async () => {
    let resolveFetch!: (response: Response) => void;
    const fetchMock = vi.fn(
      () =>
        new Promise<Response>((resolve) => {
          resolveFetch = resolve;
        }),
    );
    vi.stubGlobal("fetch", fetchMock);
    const tool = createBotTool({
      endpoint: {
        url: "http://host.docker.internal:1234/__agent/bot",
        token: "secret",
      },
      groupName: "main",
    });

    const resultPromise = tool.execute("call-1", {
      action: "run",
      bot: "coding",
      prompt: "調査して",
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    let settled = false;
    void resultPromise.then(() => {
      settled = true;
    });
    await Promise.resolve();
    expect(settled).toBe(false);

    resolveFetch(
      new Response(
        JSON.stringify({
          content: "調査結果",
          action: "run",
          botId: "coding",
          session: "task-abc123",
        }),
        { status: 200 },
      ),
    );
    const result = await resultPromise;
    expect(result.content).toEqual([{ type: "text", text: "調査結果" }]);
    expect(result.details).toMatchObject({
      worker: "bot",
      action: "run",
      botId: "coding",
      session: "task-abc123",
    });
    expect(fetchMock).toHaveBeenCalledWith(
      "http://host.docker.internal:1234/__agent/bot",
      expect.objectContaining({
        method: "POST",
        headers: expect.objectContaining({
          "x-agent-internal-token": "secret",
        }),
        body: JSON.stringify({
          groupName: "main",
          action: "run",
          bot: "coding",
          prompt: "調査して",
        }),
      }),
    );
  });

  it("listも同期レスポンスとして返す", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        new Response(
          JSON.stringify({
            content: "Task Session一覧（1件）:",
            action: "list",
            botId: "coding",
          }),
          { status: 200 },
        ),
      ),
    );
    const tool = createBotTool({
      endpoint: {
        url: "http://host.docker.internal:1234/__agent/bot",
        token: "secret",
      },
      groupName: "main",
    });

    const result = await tool.execute("call-2", {
      action: "list",
      bot: "coding",
    });
    expect(result.content).toEqual([
      { type: "text", text: "Task Session一覧（1件）:" },
    ]);
    expect(result.details).toMatchObject({
      worker: "bot",
      action: "list",
      botId: "coding",
    });
  });

  it("ホスト側のBotエラーをtoolエラーとして返す", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        new Response(JSON.stringify({ error: "Botが未定義です: missing" }), {
          status: 500,
        }),
      ),
    );
    const tool = createBotTool({
      endpoint: {
        url: "http://host.docker.internal:1234/__agent/bot",
        token: "secret",
      },
      groupName: "main",
    });

    await expect(
      tool.execute("call-3", { action: "run", bot: "missing", prompt: "x" }),
    ).rejects.toThrow("Botが未定義です: missing");
  });
});
