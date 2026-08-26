import { mkdir, mkdtemp, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { createMutationHandler } from "./index.js";

function context(cwd: string) {
  return {
    cwd,
    hasUI: true,
    ui: { notify: vi.fn() },
  };
}

function mutation(
  overrides: Partial<{
    toolName: string;
    path: unknown;
    isError: boolean;
  }> = {},
) {
  return {
    toolName: overrides.toolName ?? "write",
    input: { path: overrides.path ?? "src/example.ts" },
    content: [{ type: "text" as const, text: "wrote file" }],
    isError: overrides.isError ?? false,
  };
}

describe("biome-after-write extension", () => {
  it("runs Biome for a successful repository write", async () => {
    const root = await mkdtemp(join(tmpdir(), "biome-hook-"));
    await mkdir(join(root, "src"));
    await writeFile(join(root, "src/example.ts"), "const value=1");
    const exec = vi.fn().mockResolvedValue({ code: 0, stdout: "", stderr: "" });

    const result = await createMutationHandler({ exec })(
      mutation(),
      context(root),
    );

    expect(result).toBeUndefined();
    expect(exec).toHaveBeenCalledWith(
      "pnpm",
      [
        "exec",
        "biome",
        "check",
        "--write",
        "--no-errors-on-unmatched",
        "src/example.ts",
      ],
      { cwd: root, signal: undefined },
    );
  });

  it.each([
    ["failed mutation", { isError: true }],
    ["non-mutation tool", { toolName: "read" }],
    ["unsupported file", { path: "README.md" }],
    ["missing file", { path: "src/missing.ts" }],
  ])("skips %s", async (_name, overrides) => {
    const root = await mkdtemp(join(tmpdir(), "biome-hook-"));
    const exec = vi.fn();

    await createMutationHandler({ exec })(mutation(overrides), context(root));

    expect(exec).not.toHaveBeenCalled();
  });

  it("skips a symlink whose target is outside the repository", async () => {
    const root = await mkdtemp(join(tmpdir(), "biome-hook-root-"));
    const outside = await mkdtemp(join(tmpdir(), "biome-hook-outside-"));
    await writeFile(join(outside, "outside.ts"), "const value = 1;");
    await symlink(join(outside, "outside.ts"), join(root, "link.ts"));
    const exec = vi.fn();

    await createMutationHandler({ exec })(
      mutation({ path: "link.ts" }),
      context(root),
    );

    expect(exec).not.toHaveBeenCalled();
  });

  it("reports command startup failure without marking the mutation as failed", async () => {
    const root = await mkdtemp(join(tmpdir(), "biome-hook-"));
    await mkdir(join(root, "src"));
    await writeFile(join(root, "src/example.ts"), "const value=1");
    const exec = vi.fn().mockRejectedValue(new Error("pnpm was not found"));

    const result = await createMutationHandler({ exec })(
      mutation(),
      context(root),
    );

    expect(result).toEqual({
      content: [
        { type: "text", text: "wrote file" },
        {
          type: "text",
          text: "\nBiome failed for src/example.ts (exit -1):\npnpm was not found",
        },
      ],
    });
    expect(result).not.toHaveProperty("isError");
  });

  it("reports Biome failure without marking the mutation as failed", async () => {
    const root = await mkdtemp(join(tmpdir(), "biome-hook-"));
    await mkdir(join(root, "src"));
    await writeFile(join(root, "src/example.ts"), "const value=1");
    const exec = vi.fn().mockResolvedValue({
      code: 1,
      stdout: "",
      stderr: "formatting failed",
    });
    const ctx = context(root);

    const result = await createMutationHandler({ exec })(mutation(), ctx);

    expect(result).toEqual({
      content: [
        { type: "text", text: "wrote file" },
        {
          type: "text",
          text: "\nBiome failed for src/example.ts (exit 1):\nformatting failed",
        },
      ],
    });
    expect(result).not.toHaveProperty("isError");
    expect(ctx.ui.notify).toHaveBeenCalledWith(
      "Biome failed for src/example.ts (exit 1):\nformatting failed",
      "error",
    );
  });
});
