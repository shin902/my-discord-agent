import {
  access,
  mkdir,
  mkdtemp,
  readFile,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  ensureAgentMemoryScaffold,
  ensureAgentMemoryScaffolds,
} from "./agent-memory.js";

describe("ensureAgentMemoryScaffold", () => {
  it("creates the NanoClaw memory tree and does not overwrite edits", async () => {
    const groupDir = await mkdtemp(join(tmpdir(), "agent-memory-"));
    await ensureAgentMemoryScaffold(groupDir);
    const index = join(groupDir, "memory/index.md");
    await writeFile(index, "agent edit\n");
    await ensureAgentMemoryScaffold(groupDir);

    expect(await readFile(index, "utf8")).toBe("agent edit\n");
    expect(
      await readFile(join(groupDir, "memory/system/index.md"), "utf8"),
    ).toContain("Definition");
    expect(
      await readFile(join(groupDir, "memory/system/definition.md"), "utf8"),
    ).toContain("OKF");
  });

  it("scaffolds every configured group", async () => {
    const groupsDir = await mkdtemp(join(tmpdir(), "agent-memory-groups-"));
    await mkdir(join(groupsDir, "one"));
    await mkdir(join(groupsDir, "two"));

    await ensureAgentMemoryScaffolds(groupsDir, ["one", "two"]);

    await expect(
      access(join(groupsDir, "one/memory/index.md")),
    ).resolves.toBeUndefined();
    await expect(
      access(join(groupsDir, "two/memory/index.md")),
    ).resolves.toBeUndefined();
  });

  it.each([
    ["memory", "outside"],
    ["memory/system", "outside"],
  ])("rejects a symlink at %s without writing outside", async (link, target) => {
    const root = await mkdtemp(join(tmpdir(), "agent-memory-symlink-"));
    const groupDir = join(root, "group");
    const outside = join(root, target);
    await mkdir(groupDir);
    await mkdir(outside);
    if (link.includes("/")) await mkdir(join(groupDir, "memory"));
    await symlink(outside, join(groupDir, link));

    await expect(ensureAgentMemoryScaffold(groupDir)).rejects.toThrow(
      "is not a real directory",
    );
    await expect(access(join(outside, "index.md"))).rejects.toThrow();
    await expect(access(join(outside, "definition.md"))).rejects.toThrow();
  });
});
