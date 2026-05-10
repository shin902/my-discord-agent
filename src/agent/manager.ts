import { spawn } from "node:child_process";
import { resolve } from "node:path";
import { SandboxManager } from "@anthropic-ai/sandbox-runtime";
import {
  getModels,
  getProviders,
  type KnownProvider,
} from "@earendil-works/pi-ai";

export const DEFAULT_PROVIDER = "opencode-go";
export const DEFAULT_MODEL_ID = "kimi-k2.6";
export const DEFAULT_SYSTEM_PROMPT = "あなたは役立つDiscordアシスタントです。";

export function resolveModel(provider: string, modelId: string) {
  const providers = getProviders();
  if (!providers.includes(provider as KnownProvider)) {
    throw new Error(`不明なプロバイダ: ${provider}`);
  }
  const model = getModels(provider as KnownProvider).find(
    (m) => m.id === modelId,
  );
  if (!model)
    throw new Error(`不明なモデル: ${modelId} (provider: ${provider})`);
  return model;
}

// 起動時バリデーション専用。無効な設定はスローして即クラッシュさせる
export function validateModel(provider: string, modelId: string): void {
  resolveModel(provider, modelId);
}

/**
 * 指定セッションの Agent にメッセージを送り、返答テキストを返す。
 * agent/worker.js をサンドボックス内で起動し、stdin/stdout で通信する。
 * discord/ 層はこの関数だけを呼ぶ。
 */
export async function sendMessage(
  groupName: string,
  sessionId: string,
  content: string,
): Promise<string> {
  const workerPath = resolve(process.cwd(), "dist", "agent", "worker.js");
  const groupDir = resolve(process.cwd(), "groups", groupName);
  const sessionDir = resolve(process.cwd(), "data", "sessions", groupName);
  const cmd = await SandboxManager.wrapWithSandbox(
    `node ${workerPath}`,
    undefined,
    {
      filesystem: {
        denyRead: [".env", ".env.*", "~/.ssh"],
        allowWrite: [groupDir, sessionDir],
        denyWrite: [".env", ".env.*", "pnpm-lock.yaml", "package.json"],
      },
    },
  );

  return new Promise((res, rej) => {
    const child = spawn(cmd, {
      shell: true,
      stdio: ["pipe", "pipe", "inherit"],
      env: process.env,
    });

    child.stdin.write(JSON.stringify({ groupName, sessionId, content }));
    child.stdin.end();

    const chunks: Buffer[] = [];
    child.stdout.on("data", (chunk: Buffer) => chunks.push(chunk));

    child.on("close", () => {
      try {
        const { response } = JSON.parse(Buffer.concat(chunks).toString()) as {
          response: string;
        };
        res(response);
      } catch (e) {
        rej(new Error(`Worker出力のパースに失敗: ${e}`));
      }
    });
    child.on("error", rej);
  });
}
