import type { AgentTool } from "@earendil-works/pi-agent-core";
import { Type } from "typebox";

const MAX_BODY_CHARS = 8000;

function getGraphBaseUrl(): string {
  const credJson = process.env.CREDENTIAL_PROXY_JSON;
  if (!credJson) throw new Error("CREDENTIAL_PROXY_JSON が設定されていません");
  const creds: Array<{ provider: string; baseUrl: string }> =
    JSON.parse(credJson);
  const entry = creds.find((e) => e.provider === "graph");
  if (!entry)
    throw new Error(
      "graph プロバイダーが CREDENTIAL_PROXY_JSON に見つかりません",
    );
  return entry.baseUrl.replace(/\/$/, "");
}

async function graphFetch(path: string): Promise<unknown> {
  const baseUrl = getGraphBaseUrl();
  const res = await fetch(`${baseUrl}${path}`);
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`Graph API エラー ${res.status}: ${text.slice(0, 200)}`);
  }
  return res.json();
}

const listEmailsParameters = Type.Object({
  limit: Type.Optional(
    Type.Number({
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
});

export const listEmailsTool: AgentTool<typeof listEmailsParameters> = {
  name: "list_emails",
  label: "List Emails",
  description:
    "Outlook メールの一覧を取得する。件名・送信者・受信日時・本文プレビューを返す",
  parameters: listEmailsParameters,
  execute: async (_toolCallId, { limit = 10, folder = "inbox" }) => {
    if (!/^[a-zA-Z0-9_-]+$/.test(folder)) {
      throw new Error(`無効なフォルダ名: ${folder}`);
    }
    const top = Math.min(limit, 50);
    const select = "id,subject,from,receivedDateTime,bodyPreview,isRead";
    const data = (await graphFetch(
      `/me/mailFolders/${folder}/messages?$top=${top}&$select=${select}&$orderby=receivedDateTime desc`,
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
  id: Type.String({ description: "メールID（list_emails で取得した id）" }),
});

export const readEmailTool: AgentTool<typeof readEmailParameters> = {
  name: "read_email",
  label: "Read Email",
  description: "指定したメールの全文を取得する。list_emails で得た id を渡す",
  parameters: readEmailParameters,
  execute: async (_toolCallId, { id }) => {
    const select =
      "id,subject,from,toRecipients,ccRecipients,receivedDateTime,body,isRead";
    const msg = (await graphFetch(
      `/me/messages/${encodeURIComponent(id)}?$select=${select}`,
    )) as Record<string, unknown>;

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
    // HTML の場合はタグを除去
    if (body?.contentType === "html") {
      bodyText = bodyText
        .replace(/<[^>]+>/g, "")
        .replace(/&nbsp;/g, " ")
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
