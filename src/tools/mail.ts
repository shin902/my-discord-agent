import type { AgentTool } from "@earendil-works/pi-agent-core";
import { Type } from "typebox";
import { resolveProxyBaseUrl } from "./proxy-url.js";

const MAX_BODY_CHARS = 8000;

async function graphFetch(path: string): Promise<unknown> {
  const baseUrl = resolveProxyBaseUrl("graph");
  const res = await fetch(`${baseUrl}${path}`);
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`Graph API エラー ${res.status}: ${text.slice(0, 200)}`);
  }
  return res.json();
}

async function graphPatch(path: string, body: unknown): Promise<void> {
  const baseUrl = resolveProxyBaseUrl("graph");
  const res = await fetch(`${baseUrl}${path}`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(
      `Graph API PATCH エラー ${res.status}: ${text.slice(0, 200)}`,
    );
  }
}

const listEmailsParameters = Type.Object({
  limit: Type.Optional(
    Type.Integer({
      description: "取得件数（デフォルト: 10、最大: 50）",
      minimum: 1,
      maximum: 50,
    }),
  ),
  folder: Type.Optional(
    Type.String({
      description:
        "フォルダ名（inbox / sentitems / drafts 等、デフォルト: inbox）",
    }),
  ),
  unreadOnly: Type.Optional(
    Type.Boolean({
      description: "true のとき未読メールのみ取得する（デフォルト: false）",
    }),
  ),
});

export const listEmailsTool: AgentTool<typeof listEmailsParameters> = {
  name: "list-emails",
  label: "List Emails",
  description:
    "Outlook メールの一覧を取得する。件名・送信者・受信日時・本文プレビューを返す",
  parameters: listEmailsParameters,
  execute: async (
    _toolCallId,
    { limit = 10, folder = "inbox", unreadOnly = false },
  ) => {
    if (!/^[a-zA-Z0-9_-]+$/.test(folder)) {
      throw new Error(`無効なフォルダ名: ${folder}`);
    }
    const top = Math.min(limit, 50);
    const select = "id,subject,from,receivedDateTime,bodyPreview,isRead";
    const filterParam = unreadOnly ? "&$filter=isRead eq false" : "";
    const data = (await graphFetch(
      `/me/mailFolders/${folder}/messages?$top=${top}&$select=${select}&$orderby=receivedDateTime desc${filterParam}`,
    )) as { value: Array<Record<string, unknown>> };

    const lines: string[] = [`## メール一覧（${folder}）`, ""];
    for (const msg of data.value) {
      const from = (
        msg.from as
          | { emailAddress?: { name?: string; address?: string } }
          | undefined
      )?.emailAddress;
      const sender = from?.name
        ? `${from.name} <${from.address}>`
        : (from?.address ?? "不明");
      const read = msg.isRead ? "" : " 【未読】";
      lines.push(`### ${msg.subject ?? "(件名なし)"}${read}`);
      lines.push(`- ID: \`${msg.id}\``);
      lines.push(`- 送信者: ${sender}`);
      lines.push(`- 受信日時: ${msg.receivedDateTime}`);
      lines.push(
        `- プレビュー: ${String(msg.bodyPreview ?? "").slice(0, 200)}`,
      );
      lines.push("");
    }

    if (data.value.length === 0) lines.push("(メールはありません)");

    return {
      content: [{ type: "text", text: lines.join("\n") }],
      details: { folder, count: data.value.length },
    };
  },
};

const readEmailParameters = Type.Object({
  id: Type.String({ description: "メールID（list-emails で取得した id）" }),
  markAsRead: Type.Optional(
    Type.Boolean({
      description: "既読にマークするか（デフォルト: true）",
    }),
  ),
});

export const readEmailTool: AgentTool<typeof readEmailParameters> = {
  name: "read-email",
  label: "Read Email",
  description:
    "指定したメールの全文を取得する。list-emails で得た id を渡す。デフォルトで既読にマークする",
  parameters: readEmailParameters,
  execute: async (_toolCallId, { id, markAsRead = true }) => {
    const select =
      "id,subject,from,toRecipients,ccRecipients,receivedDateTime,body,isRead";
    const msg = (await graphFetch(
      `/me/messages/${encodeURIComponent(id)}?$select=${select}`,
    )) as Record<string, unknown>;

    if (markAsRead && msg.isRead === false) {
      await graphPatch(`/me/messages/${encodeURIComponent(id)}`, {
        isRead: true,
      });
    }

    const from = (
      msg.from as
        | { emailAddress?: { name?: string; address?: string } }
        | undefined
    )?.emailAddress;
    const sender = from?.name
      ? `${from.name} <${from.address}>`
      : (from?.address ?? "不明");

    const formatRecipients = (field: unknown): string => {
      const list = field as
        | Array<{ emailAddress?: { name?: string; address?: string } }>
        | undefined;
      if (!list || list.length === 0) return "(なし)";
      return list
        .map((r) => {
          const ea = r.emailAddress;
          return ea?.name
            ? `${ea.name} <${ea.address}>`
            : (ea?.address ?? "不明");
        })
        .join(", ");
    };

    const body = msg.body as
      | { contentType?: string; content?: string }
      | undefined;
    let bodyText = body?.content ?? "";
    if (body?.contentType === "html") {
      bodyText = bodyText
        .replace(/<[^>]+>/g, "")
        .replace(/&nbsp;/g, " ")
        .replace(/&amp;/g, "&")
        .replace(/&lt;/g, "<")
        .replace(/&gt;/g, ">")
        .replace(/&quot;/g, '"')
        .replace(/&apos;/g, "'")
        .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(Number(n)))
        .replace(/&#x([\da-f]+);/gi, (_, h) =>
          String.fromCharCode(parseInt(h, 16)),
        )
        .trim();
    }
    if (bodyText.length > MAX_BODY_CHARS) {
      bodyText = `${bodyText.slice(0, MAX_BODY_CHARS)}\n\n...(${bodyText.length - MAX_BODY_CHARS} 文字省略)`;
    }

    const lines = [
      `# ${msg.subject ?? "(件名なし)"}`,
      "",
      `**送信者**: ${sender}`,
      `**宛先**: ${formatRecipients(msg.toRecipients)}`,
      `**CC**: ${formatRecipients(msg.ccRecipients)}`,
      `**受信日時**: ${msg.receivedDateTime}`,
      "",
      "---",
      "",
      bodyText,
    ];

    return {
      content: [{ type: "text", text: lines.join("\n") }],
      details: { id },
    };
  },
};
