import { lstat, mkdir, writeFile } from "node:fs/promises";
import path from "node:path";

export type RedditCookieFileSystem = {
  lstat: typeof lstat;
  mkdir: typeof mkdir;
  writeFile: typeof writeFile;
};

const defaultFileSystem: RedditCookieFileSystem = { lstat, mkdir, writeFile };

async function assertRegularCookieFile(
  cookieFile: string,
  fileSystem: RedditCookieFileSystem,
): Promise<void> {
  const existing = await fileSystem.lstat(cookieFile);
  if (!existing.isFile()) {
    throw new Error(`Reddit cookie path is not a regular file: ${cookieFile}`);
  }
}

/** Ensure the host-side bind source exists without replacing a non-file path. */
export async function ensureRedditCookieFile(
  cookieFile: string,
  fileSystem: RedditCookieFileSystem = defaultFileSystem,
): Promise<void> {
  try {
    await assertRegularCookieFile(cookieFile, fileSystem);
    return;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }

  await fileSystem.mkdir(path.dirname(cookieFile), { recursive: true });
  await fileSystem
    .writeFile(
      cookieFile,
      JSON.stringify(
        { cookieHeader: "", updatedAt: new Date(0).toISOString() },
        null,
        2,
      ),
      { encoding: "utf-8", mode: 0o600, flag: "wx" },
    )
    .catch(async (error: unknown) => {
      // Another process may have initialized the path between access and write.
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      await assertRegularCookieFile(cookieFile, fileSystem);
    });
}
