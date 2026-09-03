import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../config/proxy-config.js", () => ({
  loadRequestTimeoutMs: vi.fn().mockResolvedValue(120_000),
}));

const PROXY_CREDS = JSON.stringify([
  { provider: "graph", baseUrl: "http://proxy.test/graph" },
]);

function firstText(result: {
  content: Array<{ type: string; text?: string }>;
}): string {
  const first = result.content[0];
  if (!first || first.type !== "text" || first.text == null) {
    throw new Error("Expected text content");
  }
  return first.text;
}

const makeMsgList = (overrides: Record<string, unknown>[] = []) => ({
  value: [
    {
      id: "msg-001",
      subject: "テスト件名",
      from: { emailAddress: { name: "Alice", address: "alice@example.com" } },
      receivedDateTime: "2024-01-01T10:00:00Z",
      bodyPreview: "本文のプレビュー",
      isRead: false,
      ...overrides[0],
    },
  ],
});

describe("list-emails", () => {
  const originalEnv = process.env;
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    vi.resetModules();
    process.env = { ...originalEnv, CREDENTIAL_PROXY_JSON: PROXY_CREDS };
    fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
  });

  afterEach(() => {
    process.env = originalEnv;
    vi.unstubAllGlobals();
  });

  it("inbox の一覧を正しくフォーマットする", async () => {
    fetchMock.mockResolvedValue({
      ok: true,
      json: async () => makeMsgList(),
    });
    const { listEmailsTool } = await import("./mail.js");
    const result = await listEmailsTool.execute("id", {});
    const text = firstText(result);
    expect(text).toContain("テスト件名");
    expect(text).toContain("Alice <alice@example.com>");
    expect(text).toContain("msg-001");
    expect(text).toContain("【未読】");
  });

  it("デフォルトで $top=10 かつ inbox を叩く", async () => {
    fetchMock.mockResolvedValue({ ok: true, json: async () => makeMsgList() });
    const { listEmailsTool } = await import("./mail.js");
    await listEmailsTool.execute("id", {});
    const url = fetchMock.mock.calls[0][0] as string;
    expect(url).toContain("/me/mailFolders/inbox/messages");
    expect(url).toContain("$top=10");
  });

  it("limit=50 を上限にクランプする", async () => {
    fetchMock.mockResolvedValue({
      ok: true,
      json: async () => ({ value: [] }),
    });
    const { listEmailsTool } = await import("./mail.js");
    await listEmailsTool.execute("id", { limit: 100 });
    const url = fetchMock.mock.calls[0][0] as string;
    expect(url).toContain("$top=50");
  });

  it("folder パラメータを URL に反映する", async () => {
    fetchMock.mockResolvedValue({
      ok: true,
      json: async () => ({ value: [] }),
    });
    const { listEmailsTool } = await import("./mail.js");
    await listEmailsTool.execute("id", { folder: "sentitems" });
    const url = fetchMock.mock.calls[0][0] as string;
    expect(url).toContain("/me/mailFolders/sentitems/messages");
  });

  it("unreadOnly: true のとき $filter=isRead eq false を付加する", async () => {
    fetchMock.mockResolvedValue({
      ok: true,
      json: async () => ({ value: [] }),
    });
    const { listEmailsTool } = await import("./mail.js");
    await listEmailsTool.execute("id", { unreadOnly: true });
    const url = fetchMock.mock.calls[0][0] as string;
    expect(url).toContain("$filter=isRead eq false");
  });

  it("unreadOnly: false（デフォルト）のとき $filter を付加しない", async () => {
    fetchMock.mockResolvedValue({
      ok: true,
      json: async () => ({ value: [] }),
    });
    const { listEmailsTool } = await import("./mail.js");
    await listEmailsTool.execute("id", {});
    const url = fetchMock.mock.calls[0][0] as string;
    expect(url).not.toContain("$filter");
  });

  it("空フォルダのとき「メールはありません」を返す", async () => {
    fetchMock.mockResolvedValue({
      ok: true,
      json: async () => ({ value: [] }),
    });
    const { listEmailsTool } = await import("./mail.js");
    const result = await listEmailsTool.execute("id", {});
    expect(firstText(result)).toContain("メールはありません");
  });

  it("既読メールには【未読】を付けない", async () => {
    fetchMock.mockResolvedValue({
      ok: true,
      json: async () => makeMsgList([{ isRead: true }]),
    });
    const { listEmailsTool } = await import("./mail.js");
    const result = await listEmailsTool.execute("id", {});
    expect(firstText(result)).not.toContain("【未読】");
  });

  it("Graph API エラー時は例外を投げる", async () => {
    fetchMock.mockResolvedValue({
      ok: false,
      status: 401,
      text: async () => "Unauthorized",
    });
    const { listEmailsTool } = await import("./mail.js");
    await expect(listEmailsTool.execute("id", {})).rejects.toThrow("401");
  });

  it("graph プロバイダーが CREDENTIAL_PROXY_JSON にない場合は例外", async () => {
    process.env.CREDENTIAL_PROXY_JSON = JSON.stringify([
      { provider: "openai", baseUrl: "http://proxy.test/openai" },
    ]);
    const { listEmailsTool } = await import("./mail.js");
    await expect(listEmailsTool.execute("id", {})).rejects.toThrow(
      "graph プロバイダーが CREDENTIAL_PROXY_JSON に見つかりません",
    );
  });
});

describe("read-email", () => {
  const originalEnv = process.env;
  let fetchMock: ReturnType<typeof vi.fn>;

  const makeMsg = (overrides: Record<string, unknown> = {}) => ({
    id: "msg-001",
    subject: "テスト件名",
    from: { emailAddress: { name: "Alice", address: "alice@example.com" } },
    toRecipients: [
      { emailAddress: { name: "Bob", address: "bob@example.com" } },
    ],
    ccRecipients: [],
    receivedDateTime: "2024-01-01T10:00:00Z",
    body: { contentType: "text", content: "メール本文テキスト" },
    isRead: true,
    ...overrides,
  });

  beforeEach(() => {
    vi.resetModules();
    process.env = { ...originalEnv, CREDENTIAL_PROXY_JSON: PROXY_CREDS };
    fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
  });

  afterEach(() => {
    process.env = originalEnv;
    vi.unstubAllGlobals();
  });

  it("指定した id で Graph API を叩く", async () => {
    fetchMock.mockResolvedValue({ ok: true, json: async () => makeMsg() });
    const { readEmailTool } = await import("./mail.js");
    await readEmailTool.execute("id", { id: "msg-001" });
    const url = fetchMock.mock.calls[0][0] as string;
    expect(url).toContain("/me/messages/msg-001");
  });

  it("メールの件名・送信者・本文をフォーマットする", async () => {
    fetchMock.mockResolvedValue({ ok: true, json: async () => makeMsg() });
    const { readEmailTool } = await import("./mail.js");
    const result = await readEmailTool.execute("id", { id: "msg-001" });
    const text = firstText(result);
    expect(text).toContain("テスト件名");
    expect(text).toContain("Alice <alice@example.com>");
    expect(text).toContain("Bob <bob@example.com>");
    expect(text).toContain("メール本文テキスト");
  });

  it("isRead:false のとき markAsRead デフォルト(true)で PATCH を送信する", async () => {
    fetchMock
      .mockResolvedValueOnce({
        ok: true,
        json: async () => makeMsg({ isRead: false }),
      })
      .mockResolvedValueOnce({ ok: true });
    const { readEmailTool } = await import("./mail.js");
    await readEmailTool.execute("id", { id: "msg-001" });
    expect(fetchMock).toHaveBeenCalledTimes(2);
    const [patchUrl, patchInit] = fetchMock.mock.calls[1] as [
      string,
      RequestInit,
    ];
    expect(patchUrl).toContain("/me/messages/msg-001");
    expect(patchInit.method).toBe("PATCH");
    expect(JSON.parse(patchInit.body as string)).toEqual({ isRead: true });
  });

  it("markAsRead: false のとき PATCH を送信しない", async () => {
    fetchMock.mockResolvedValue({
      ok: true,
      json: async () => makeMsg({ isRead: false }),
    });
    const { readEmailTool } = await import("./mail.js");
    await readEmailTool.execute("id", { id: "msg-001", markAsRead: false });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("isRead:true のとき PATCH を送信しない（既に既読）", async () => {
    fetchMock.mockResolvedValue({
      ok: true,
      json: async () => makeMsg({ isRead: true }),
    });
    const { readEmailTool } = await import("./mail.js");
    await readEmailTool.execute("id", { id: "msg-001" });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("HTML 本文からタグを除去する", async () => {
    fetchMock.mockResolvedValue({
      ok: true,
      json: async () =>
        makeMsg({
          body: { contentType: "html", content: "<p>本文</p><br><b>強調</b>" },
        }),
    });
    const { readEmailTool } = await import("./mail.js");
    const result = await readEmailTool.execute("id", { id: "msg-001" });
    const text = firstText(result);
    expect(text).toContain("本文");
    expect(text).toContain("強調");
    expect(text).not.toContain("<p>");
    expect(text).not.toContain("<b>");
  });

  it("HTML エンティティをデコードする", async () => {
    fetchMock.mockResolvedValue({
      ok: true,
      json: async () =>
        makeMsg({
          body: {
            contentType: "html",
            content: "<p>Sales &amp; Marketing &lt;info@example.com&gt;</p>",
          },
        }),
    });
    const { readEmailTool } = await import("./mail.js");
    const result = await readEmailTool.execute("id", { id: "msg-001" });
    const text = firstText(result);
    expect(text).toContain("Sales & Marketing <info@example.com>");
    expect(text).not.toContain("&amp;");
    expect(text).not.toContain("&lt;");
  });

  it("本文が 8000 文字を超えたら省略する", async () => {
    const longBody = "a".repeat(10000);
    fetchMock.mockResolvedValue({
      ok: true,
      json: async () =>
        makeMsg({ body: { contentType: "text", content: longBody } }),
    });
    const { readEmailTool } = await import("./mail.js");
    const result = await readEmailTool.execute("id", { id: "msg-001" });
    const text = firstText(result);
    expect(text).toContain("2000 文字省略");
  });

  it("id に特殊文字が含まれても encodeURIComponent でエスケープする", async () => {
    fetchMock.mockResolvedValue({ ok: true, json: async () => makeMsg() });
    const { readEmailTool } = await import("./mail.js");
    await readEmailTool.execute("id", { id: "AAA==" });
    const url = fetchMock.mock.calls[0][0] as string;
    expect(url).toContain("AAA%3D%3D");
  });
});
