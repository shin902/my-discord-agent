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
  lookbackMonths: z.number().int().positive().default(1),
});

interface SummaryRow {
  income: number | null;
  expense: number | null;
  net: number | null;
}

interface CategoryRow {
  category: string | null;
  total: number;
}

interface SubCostRow {
  monthly_cost: number | null;
}

function formatAmount(amount: number): string {
  const sign = amount >= 0 ? "+" : "";
  return `${sign}${amount.toLocaleString("ja-JP")}円`;
}

function row(
  label: string,
  amount: number,
  labelWidth = 10,
  amountWidth = 14,
): string {
  return label.padEnd(labelWidth) + formatAmount(amount).padStart(amountWidth);
}

export default async function handler(ctx: CronContext): Promise<void> {
  if (!ctx.channelId || !ctx.groupName) {
    console.error("[finance-monthly] channelId / groupName が未設定です");
    return;
  }

  const settings = SettingsSchema.parse(ctx.settings ?? {});
  const dbPath = path.join(ROOT, "groups", ctx.groupName, "finance.db");

  const db = new Database(dbPath, { readonly: true });
  try {
    const now = new Date();
    const target = new Date(
      now.getFullYear(),
      now.getMonth() - settings.lookbackMonths,
      1,
    );
    const yearMonth = `${target.getFullYear()}-${String(target.getMonth() + 1).padStart(2, "0")}`;
    const monthLabel = `${target.getFullYear()}年${target.getMonth() + 1}月`;

    const summary = db
      .prepare<[string], SummaryRow>(
        `SELECT
          SUM(CASE WHEN amount > 0 THEN amount ELSE 0 END) AS income,
          SUM(CASE WHEN amount < 0 THEN amount ELSE 0 END) AS expense,
          SUM(amount) AS net
        FROM transactions
        WHERE date LIKE ?`,
      )
      .get(`${yearMonth}%`);

    const categories = db
      .prepare<[string], CategoryRow>(
        `SELECT category, SUM(amount) AS total
        FROM transactions
        WHERE date LIKE ? AND amount < 0
        GROUP BY category
        ORDER BY total ASC`,
      )
      .all(`${yearMonth}%`);

    const subCost = db
      .prepare<[], SubCostRow>(
        `SELECT SUM(
          CASE
            WHEN cycle = 'monthly' THEN amount
            WHEN cycle = 'yearly'  THEN amount / 12
            WHEN cycle = 'weekly'  THEN amount * 4
            ELSE amount
          END
        ) AS monthly_cost
        FROM subscriptions
        WHERE active = 1 AND amount < 0`,
      )
      .get();

    const SEP = "━".repeat(26);
    const lines: string[] = [
      `${monthLabel}の収支サマリー`,
      SEP,
      row("収入", summary?.income ?? 0),
      row("支出", summary?.expense ?? 0),
      SEP,
      row("収支", summary?.net ?? 0),
    ];

    if (categories.length > 0) {
      lines.push("", "カテゴリ別支出", "─".repeat(26));
      for (const cat of categories) {
        lines.push(row(cat.category ?? "未分類", cat.total));
      }
    }

    if (subCost?.monthly_cost != null) {
      lines.push("", row("サブスク月額", subCost.monthly_cost));
    }

    const report = `\`\`\`\n${lines.join("\n")}\n\`\`\``;

    const channel = await ctx.client.channels.fetch(ctx.channelId);
    if (!channel || channel.type !== ChannelType.GuildText) {
      console.error("[finance-monthly] テキストチャンネルが見つかりません");
      return;
    }

    for (const chunk of splitMessage(report)) {
      await channel.send(chunk);
    }
  } finally {
    db.close();
  }
}
