import { execFile } from "node:child_process";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";

const execFileAsync = promisify(execFile);
const script = join(process.cwd(), "templates/SKILLS/agent-memory/init.sh");

describe("agent-memory Skill initializer", () => {
  it("creates missing templates without overwriting existing memory", async () => {
    const workspace = await mkdtemp(join(tmpdir(), "agent-memory-skill-"));

    await execFileAsync("bash", [script, workspace]);
    const files = [
      "memory/index.md",
      "memory/system/index.md",
      "memory/system/definition.md",
    ];
    for (const file of files)
      await expect(readFile(join(workspace, file), "utf8")).resolves.not.toBe(
        "",
      );
    const definition = await readFile(join(workspace, files[2]), "utf8");
    expect(definition).toContain("OKF");
    expect(definition).toContain("session-initial snapshot");
    expect(definition).toContain("available filesystem");
    expect(definition).toContain("Never store secrets");

    await writeFile(join(workspace, files[0]), "existing index\n");
    await writeFile(join(workspace, files[1]), "existing system index\n");
    await writeFile(join(workspace, files[2]), "existing definition\n");
    await execFileAsync("bash", [script, workspace]);

    await expect(readFile(join(workspace, files[0]), "utf8")).resolves.toBe(
      "existing index\n",
    );
    await expect(readFile(join(workspace, files[1]), "utf8")).resolves.toBe(
      "existing system index\n",
    );
    await expect(readFile(join(workspace, files[2]), "utf8")).resolves.toBe(
      "existing definition\n",
    );
  });
});
