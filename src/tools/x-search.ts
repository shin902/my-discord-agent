import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import { promisify } from "node:util";
import type { AgentTool } from "@earendil-works/pi-agent-core";
import { Type } from "typebox";

const execFileAsync = promisify(execFile);
const CREDENTIALS_PATH = "/var/lib/twitter/twitter-cookies.json";

const parameters = Type.Object({
  query: Type.String({
    minLength: 1,
    maxLength: 500,
    description:
      "X search query. X operators such as from:, since:, and lang: may be included.",
  }),
  limit: Type.Optional(
    Type.Integer({ minimum: 1, maximum: 50, description: "Maximum results." }),
  ),
  mode: Type.Optional(
    Type.Union([Type.Literal("latest"), Type.Literal("top")], {
      description: "Search ranking mode.",
    }),
  ),
});

async function credentials(): Promise<{
  auth_token: string;
  ct0: string;
}> {
  try {
    const value = JSON.parse(await readFile(CREDENTIALS_PATH, "utf8"));
    if (
      !value ||
      typeof value !== "object" ||
      typeof value.auth_token !== "string" ||
      !value.auth_token ||
      typeof value.ct0 !== "string" ||
      !value.ct0
    )
      throw new Error();
    return value;
  } catch {
    throw new Error("X search credentials are unavailable or invalid");
  }
}

type RunTwitter = typeof execFileAsync;

export async function executeXSearch(
  args: { query: string; limit?: number; mode?: "latest" | "top" },
  signal?: AbortSignal,
  run: RunTwitter = execFileAsync,
): Promise<unknown[]> {
  const auth = await credentials();
  try {
    const { stdout } = await run(
      "twitter",
      [
        "search",
        args.query,
        "--type",
        args.mode === "latest" ? "Latest" : "Top",
        "--max",
        String(args.limit ?? 10),
        "--json",
      ],
      {
        env: {
          ...process.env,
          TWITTER_AUTH_TOKEN: auth.auth_token,
          TWITTER_CT0: auth.ct0,
        },
        maxBuffer: 16 * 1024 * 1024,
        signal,
      },
    );
    const response = JSON.parse(stdout) as {
      ok?: unknown;
      data?: unknown;
    };
    if (response.ok !== true || !Array.isArray(response.data))
      throw new Error();
    return response.data;
  } catch {
    throw new Error(
      "X search failed; credentials may be expired, rate limited, or the upstream API may have changed",
    );
  }
}

export const xSearchTool: AgentTool<typeof parameters> = {
  name: "x-search",
  label: "X Search",
  description:
    "Search public posts on X using an authenticated read-only session. Supports X query operators and top/latest ranking.",
  parameters,
  execute: async (_id, args, signal) => {
    const limit = args.limit ?? 10;
    const mode = args.mode ?? "top";
    const data = await executeXSearch({ ...args, limit, mode }, signal);
    return {
      content: [{ type: "text", text: JSON.stringify(data) }],
      details: { query: args.query, limit, mode },
    };
  },
};
