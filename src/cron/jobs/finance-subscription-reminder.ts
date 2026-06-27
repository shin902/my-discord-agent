import path from "node:path";
import { fileURLToPath } from "node:url";
import Database from "better-sqlite3";
import { ChannelType } from "discord.js";
import { z } from "zod";
import { splitMessage } from "../../utils/splitMessage.js";
import type { CronContext } from "../runner.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "../../../");

const SettingsSchema = z.object({
  daysAhead: z.number().int().nonnegative().default(7),
});

interface SubscriptionRow {
  name: string;
  amount: number;
  cycle: string;
  next_date: string;
  category: string | null;
}

function formatAmount(amount: number): string {
  return `${Math.abs(amount).toLocaleString("ja-JP")}円`;
}

function cycleLabel(cycle: string): string {
  switch (cycle) {
    case "monthly":
      return "月額";
    case "yearly":
      return "年額";
    case "weekly":
      return "週額";
    default:
      return cycle;
  }
}

function daysUntil(dateStr: string): number {
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const target = new Date(dateStr);
  return Math.round((target.getTime() - today.getTime()) / 86_400_000);
}

function daysLabel(days: number): string {
  if (days === 0) return "今日";
  if (days === 1) return "明日";
  return `${days}日後`;
}

export default async function handler(ctx: CronContext): Promise<void> {
  if (!ctx.channelId || !ctx.groupName) {
    console.error(
      "[finance-subscription-reminder] channelId / groupName が未設定です",
    );
    return;
  }

  const settings = SettingsSchema.parse(ctx.settings ?? {});
  const dbPath = path.join(ROOT, "groups", ctx.groupName, "finance.db");

  let db: Database.Database | undefined;
  let subs: SubscriptionRow[];
  try {
    db = new Database(dbPath, { readonly: true });
    subs = db
      .prepare<[number], SubscriptionRow>(
        `SELECT name, amount, cycle, next_date, category
        FROM subscriptions
        WHERE active = 1
          AND next_date BETWEEN date('now') AND date('now', ? || ' days')
        ORDER BY next_date ASC`,
      )
      .all(settings.daysAhead);
  } finally {
    db?.close();
  }

  if (subs.length === 0) return;

  const SEP = "━".repeat(28);
  const lines: string[] = [
    `サブスク更新のお知らせ（${settings.daysAhead}日以内）`,
    SEP,
  ];

  for (const sub of subs) {
    const days = daysUntil(sub.next_date);
    const name = sub.name.slice(0, 12).padEnd(12);
    const amount = formatAmount(sub.amount).padStart(10);
    const cycle = cycleLabel(sub.cycle).padEnd(4);
    const when = daysLabel(days).padStart(6);
    lines.push(`${name} ${amount} ${cycle} ${when}`);
  }

  const report = `\`\`\`\n${lines.join("\n")}\n\`\`\``;

  const channel = await ctx.client.channels.fetch(ctx.channelId);
  if (!channel || channel.type !== ChannelType.GuildText) {
    console.error(
      "[finance-subscription-reminder] テキストチャンネルが見つかりません",
    );
    return;
  }

  for (const chunk of splitMessage(report)) {
    await channel.send(chunk);
  }
}
