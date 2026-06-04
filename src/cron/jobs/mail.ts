import { ChannelType, ThreadAutoArchiveDuration } from "discord.js";
import { Agent } from "@earendil-works/pi-agent-core";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { CronContext } from "../runner.js";
import { appendMessage } from "../../agent/session.js";
import {
  DEFAULT_MODEL_ID,
  DEFAULT_PROVIDER,
  resolveModel,
} from "../../agent/model.js";
import {
  type GroupJsonConfig,
  loadGroupConfig,
  loadGroupSystemPrompt,
} from "../../config/group-config.js";
import { getProxyPort } from "../../proxy/credential-proxy-server.js";
import { splitMessage } from "../../utils/splitMessage.js";

const MAX_BODY_CHARS = 8000;
const DEFAULT_SUMMARY_PROMPT = "受信したメールを日本語で簡潔に要約してください。";

function graphUrl(path: string): string {
  const port = getProxyPort();
  return `http://localhost:${port}/graph${path}`;
}

async function graphFetch(path: string): Promise<unknown> {
  const res = await fetch(graphUrl(path));
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`Graph API エラー ${res.status}: ${text.slice(0, 200)}`);
  }
  return res.json();
}

async function graphPatch(path: string, body: unknown): Promise<void> {
  const res = await fetch(graphUrl(path), {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`Graph API PATCH エラー ${res.status}: ${text.slice(0, 200)}`);
  }
}

interface UnreadEmail {
  id: string;
  subject: string;
  from: string;
}

async function listUnreadEmails(): Promise<UnreadEmail[]> {
  const select = "id,subject,from";
  const data = (await graphFetch(
    `/me/mailFolders/inbox/messages?$top=20&$select=${select}&$orderby=receivedDateTime asc&$filter=isRead eq false`,
  )) as { value: Array<Record<string, unknown>> };

  return data.value.map((msg) => {
    const ea = (
      msg.from as
        | { emailAddress?: { name?: string; address?: string } }
        | undefined
    )?.emailAddress;
    const from = ea?.name
      ? `${ea.name} <${ea.address}>`
      : (ea?.address ?? "不明");
    return {
      id: String(msg.id),
      subject: String(msg.subject ?? "(件名なし)"),
      from,
    };
  });
}

async function fetchEmailBody(emailId: string): Promise<string> {
  const msg = (await graphFetch(
    `/me/messages/${encodeURIComponent(emailId)}?$select=body`,
  )) as Record<string, unknown>;

  await graphPatch(`/me/messages/${encodeURIComponent(emailId)}`, {
    isRead: true,
  });

  const body = msg.body as
    | { contentType?: string; content?: string }
    | undefined;
  let text = body?.content ?? "";
  if (body?.contentType === "html") {
    text = text
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
  if (text.length > MAX_BODY_CHARS) {
    text = `${text.slice(0, MAX_BODY_CHARS)}\n\n...(${text.length - MAX_BODY_CHARS} 文字省略)`;
  }
  return text;
}

async function generateSummary(
  emailText: string,
  ctx: CronContext,
): Promise<string> {
  const { groupName } = ctx;
  const [groupConfig, systemPrompt] = await Promise.all([
    groupName ? loadGroupConfig(groupName) : Promise.resolve({} as GroupJsonConfig),
    groupName ? loadGroupSystemPrompt(groupName) : Promise.resolve(null),
  ]);

  const providerName = groupConfig.model?.provider ?? DEFAULT_PROVIDER;
  const modelId = groupConfig.model?.modelId ?? DEFAULT_MODEL_ID;
  const model = await resolveModel(providerName, modelId);

  const port = getProxyPort();
  // sandbox と同様に credential proxy 経由でモデル API を呼ぶ
  const proxyModel = {
    ...model,
    baseUrl: `http://localhost:${port}/${providerName}`,
  };

  const agent = new Agent({
    initialState: {
      systemPrompt: systemPrompt ?? DEFAULT_SUMMARY_PROMPT,
      model: proxyModel,
      messages: [],
      tools: [],
      thinkingLevel: groupConfig.model?.thinkingLevel ?? "off",
    },
    getApiKey: () => Promise.resolve("proxy"),
  });

  let summary = "";
  agent.subscribe((event) => {
    if (
      event.type === "message_end" &&
      "role" in event.message &&
      (event.message as { role: unknown }).role === "assistant"
    ) {
      const content = (
        event.message as { content: Array<{ type: string; text?: string }> }
      ).content;
      summary = content
        .filter((c) => c.type === "text")
        .map((c) => c.text ?? "")
        .join("");
    }
  });

  await agent.prompt(emailText);
  return summary || "(要約を生成できませんでした)";
}

export default async function handler(ctx: CronContext): Promise<void> {
  if (!ctx.channelId) {
    console.error("[mail] channelId が設定されていません");
    return;
  }
  if (!ctx.groupName) {
    console.error("[mail] groupName が設定されていません");
    return;
  }

  const unread = await listUnreadEmails();
  if (unread.length === 0) return;

  console.log(`[mail] 未読メール ${unread.length} 件を処理します`);

  for (const meta of unread) {
    try {
      const bodyText = await fetchEmailBody(meta.id);
      const emailText = `件名: ${meta.subject}\n送信者: ${meta.from}\n\n${bodyText}`;
      const summary = await generateSummary(emailText, ctx);

      const channel = await ctx.client.channels.fetch(ctx.channelId);
      if (
        !channel ||
        (channel.type !== ChannelType.GuildText &&
          channel.type !== ChannelType.GuildAnnouncement)
      ) {
        console.error(
          `[mail] チャンネル ${ctx.channelId} はスレッドをサポートしていません`,
        );
        return;
      }

      const chunks = splitMessage(summary);
      const sentMsg = await channel.send(chunks[0] ?? "(要約なし)");

      const thread = await sentMsg.startThread({
        name: meta.subject.slice(0, 100) || "メール",
        autoArchiveDuration: ThreadAutoArchiveDuration.OneDay,
      });

      for (const chunk of chunks.slice(1)) {
        await thread.send(chunk);
      }

      // セッション初期化: 以降のスレッド返信でエージェントがメール内容を把握できるよう
      // メール本文（user）と要約（assistant）をペアで記録する
      await appendMessage(ctx.groupName, thread.id, {
        role: "user",
        content: `メールID: ${meta.id}\n\n${emailText}`,
      } as AgentMessage);
      await appendMessage(ctx.groupName, thread.id, {
        role: "assistant",
        content: [{ type: "text", text: summary }],
        stopReason: "end_turn",
      } as unknown as AgentMessage);

      console.log(
        `[mail] "${meta.subject}" → スレッド ${thread.id} を作成しました`,
      );
    } catch (err) {
      console.error(`[mail] メール ${meta.id} の処理に失敗:`, err);
    }
  }
}
