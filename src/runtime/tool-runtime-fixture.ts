import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { cp, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import {
  cleanupToolRuntimes,
  type ToolRuntimeOptions,
} from "./tool-runtime-client.js";

const execFileAsync = promisify(execFile);

/** Build a separate image containing deterministic upstream responses, never production state. */
export async function createToolRuntimeFixture(baseImage: string): Promise<{
  options: Required<ToolRuntimeOptions>;
  dispose: () => Promise<void>;
}> {
  const root = await mkdtemp(join(tmpdir(), "tool-runtime-docker-test-"));
  const image = `my-discord-agent-tool-runtime-fixture:${randomUUID()}`;
  try {
    const context = join(root, "image");
    await mkdir(context);
    await cp(fileURLToPath(new URL("./fixtures/", import.meta.url)), context, {
      recursive: true,
    });
    await writeFile(
      join(context, "Dockerfile"),
      `FROM ${baseImage}\nCOPY . /fixture/\nRUN chmod 755 /fixture/*.mjs && ln -sf /fixture/curl.mjs /usr/local/bin/curl && ln -sf /fixture/yt-dlp.mjs /opt/venv/bin/yt-dlp\nENV NODE_OPTIONS="--import=/fixture/upstream.mjs"\n`,
    );
    await execFileAsync("docker", ["build", "-t", image, context], {
      timeout: 120_000,
      maxBuffer: 4 * 1024 * 1024,
    });
    await mkdir(join(root, "data/reddit-browser-profile"), { recursive: true });
    await writeFile(
      join(root, "data/reddit-cookies.json"),
      JSON.stringify({
        cookieHeader: "fixture=only",
        updatedAt: new Date().toISOString(),
      }),
      { mode: 0o600 },
    );
    return {
      options: { root, image },
      dispose: async () => {
        await cleanupToolRuntimes({ root });
        await execFileAsync("docker", ["image", "rm", "-f", image], {
          timeout: 30_000,
        });
        await rm(root, { recursive: true, force: true });
      },
    };
  } catch (error) {
    await rm(root, { recursive: true, force: true });
    throw error;
  }
}
