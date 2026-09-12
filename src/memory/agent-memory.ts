import { copyFile, lstat, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const TEMPLATE_DIR = fileURLToPath(
  new URL("../../templates/agent-memory/", import.meta.url),
);

/** Scaffold every configured group while startup guarantees no runner is active. */
export async function ensureAgentMemoryScaffolds(
  groupsDir: string,
  groupNames: string[],
): Promise<void> {
  for (const groupName of groupNames)
    await ensureAgentMemoryScaffold(join(groupsDir, groupName));
}

/** Create NanoClaw-compatible memory files without overwriting agent edits. */
export async function ensureAgentMemoryScaffold(
  groupDir: string,
): Promise<void> {
  const memoryDir = join(groupDir, "memory");
  const systemDir = join(memoryDir, "system");
  await ensureRealDirectory(memoryDir);
  await ensureRealDirectory(systemDir);
  await Promise.all([
    copyIfMissing("index.md", join(memoryDir, "index.md")),
    copyIfMissing("system/index.md", join(memoryDir, "system/index.md")),
    copyIfMissing(
      "system/definition.md",
      join(memoryDir, "system/definition.md"),
    ),
  ]);
}

async function ensureRealDirectory(path: string): Promise<void> {
  try {
    const stat = await lstat(path);
    if (!stat.isDirectory() || stat.isSymbolicLink())
      throw new Error(
        `Agent memory scaffold path is not a real directory: ${path}`,
      );
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    await mkdir(path);
    const stat = await lstat(path);
    if (!stat.isDirectory() || stat.isSymbolicLink())
      throw new Error(
        `Agent memory scaffold path is not a real directory: ${path}`,
      );
  }
}

async function copyIfMissing(
  template: string,
  destination: string,
): Promise<void> {
  try {
    await copyFile(join(TEMPLATE_DIR, template), destination, 1);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
  }
}
