import { access, mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it, vi } from "vitest";

const race = vi.hoisted(() => ({
  armed: false,
  groupDir: "",
  outside: "",
}));

vi.mock("node:fs/promises", async (importOriginal) => {
  const fs = await importOriginal<typeof import("node:fs/promises")>();
  return {
    ...fs,
    copyFile: async (...args: Parameters<typeof fs.copyFile>) => {
      if (race.armed) {
        race.armed = false;
        await fs.rename(
          join(race.groupDir, "memory"),
          join(race.groupDir, "detached"),
        );
        await fs.symlink(race.outside, join(race.groupDir, "memory"));
      }
      return fs.copyFile(...args);
    },
  };
});

it("keeps writes on opened directories when memory is replaced by a symlink", async () => {
  const { ensureAgentMemoryScaffold } = await import("./agent-memory.js");
  const root = await mkdtemp(join(tmpdir(), "agent-memory-race-"));
  race.groupDir = join(root, "group");
  race.outside = join(root, "outside");
  const fs = await import("node:fs/promises");
  await fs.mkdir(race.groupDir);
  await fs.mkdir(race.outside);
  race.armed = true;

  await ensureAgentMemoryScaffold(race.groupDir);

  await expect(access(join(race.outside, "index.md"))).rejects.toThrow();
  await expect(access(join(race.outside, "definition.md"))).rejects.toThrow();
  await expect(
    access(join(race.groupDir, "detached/index.md")),
  ).resolves.toBeUndefined();
  await expect(
    access(join(race.groupDir, "detached/system/definition.md")),
  ).resolves.toBeUndefined();
});
