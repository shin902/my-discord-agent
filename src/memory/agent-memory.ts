import { constants } from "node:fs";
import { copyFile, type FileHandle, mkdir, open } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const TEMPLATE_DIR = fileURLToPath(
  new URL("../../templates/agent-memory/", import.meta.url),
);
const DIRECTORY_FLAGS =
  constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW;

/** Scaffold every configured group. */
export async function ensureAgentMemoryScaffolds(
  groupsDir: string,
  groupNames: string[],
): Promise<void> {
  for (const groupName of groupNames)
    await ensureAgentMemoryScaffold(join(groupsDir, groupName));
}

/** Create NanoClaw-compatible memory files without following directory symlinks. */
export async function ensureAgentMemoryScaffold(
  groupDir: string,
): Promise<void> {
  const group = await openDirectory(groupDir);
  let memory: FileHandle | undefined;
  let system: FileHandle | undefined;
  try {
    memory = await ensureDirectory(group, "memory");
    system = await ensureDirectory(memory, "system");
    await Promise.all([
      copyIfMissing("index.md", childPath(memory, "index.md")),
      copyIfMissing("system/index.md", childPath(system, "index.md")),
      copyIfMissing("system/definition.md", childPath(system, "definition.md")),
    ]);
  } finally {
    await system?.close();
    await memory?.close();
    await group.close();
  }
}

async function ensureDirectory(
  parent: FileHandle,
  name: string,
): Promise<FileHandle> {
  const path = childPath(parent, name);
  try {
    await mkdir(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
  }
  return openDirectory(path);
}

async function openDirectory(path: string): Promise<FileHandle> {
  try {
    return await open(path, DIRECTORY_FLAGS);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ELOOP" || code === "ENOTDIR")
      throw new Error(
        `Agent memory scaffold path is not a real directory: ${path}`,
      );
    throw error;
  }
}

function childPath(parent: FileHandle, name: string): string {
  return `/proc/self/fd/${parent.fd}/${name}`;
}

async function copyIfMissing(
  template: string,
  destination: string,
): Promise<void> {
  try {
    await copyFile(
      join(TEMPLATE_DIR, template),
      destination,
      constants.COPYFILE_EXCL,
    );
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
  }
}
