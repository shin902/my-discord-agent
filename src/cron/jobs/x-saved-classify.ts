import { execFile } from "node:child_process";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { z } from "zod";
import {
  openXSavedDb,
  resolveXSavedDbPath,
} from "../../integrations/x-saved/store.js";
import { NonRetryableError } from "../../utils/error.js";
import type { CronContext } from "../runner.js";

const root = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../..",
);
const score = z.number().min(0).max(1);
const Settings = z.strictObject({
  aliases: z.string().min(1),
  device: z.enum(["cpu", "cuda", "mps"]).default("cpu"),
  limit: z.number().int().min(1).max(100).default(20),
  thresholds: z
    .strictObject({
      copyright: score.optional(),
      character: score.optional(),
      general: score.optional(),
    })
    .default({}),
});

export default async function handler(ctx: CronContext): Promise<void> {
  const parsed = Settings.safeParse(ctx.settings);
  if (!parsed.success)
    throw new NonRetryableError("Invalid x-saved-classify settings");
  const settings = parsed.data;
  const taggerRoot = path.join(
    os.homedir(),
    ".local/share/my-discord-agent/x-saved-tagger",
  );
  const dbPath = resolveXSavedDbPath();
  openXSavedDb(dbPath).close();
  const { stdout, stderr } = await promisify(execFile)(
    path.join(taggerRoot, "venv/bin/python"),
    [
      path.join(root, "scripts/x-saved-tagger.py"),
      "--db",
      dbPath,
      "--aliases",
      path.resolve(root, settings.aliases),
      "--cache",
      path.join(taggerRoot, "cache"),
      "--device",
      settings.device,
      "--limit",
      String(settings.limit),
      "--thresholds",
      JSON.stringify(settings.thresholds),
    ],
    {
      cwd: root,
      timeout: 30 * 60_000,
      killSignal: "SIGKILL",
      maxBuffer: 1024 * 1024,
    },
  );
  if (stderr) console.warn(`[x-saved-classify] ${stderr.trim()}`);
  console.log(`[x-saved-classify] ${stdout.trim()}`);
}
