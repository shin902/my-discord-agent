import { mkdir, mkdtemp, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { createMutationHandler } from "./handler.js";

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

function dependencies(exec = vi.fn()) {
  return {
    exec,
    withFileMutationQueue: vi.fn(
      async <T>(_filePath: string, operation: () => Promise<T>) => operation(),
    ),
  };
}

describe("biome-after-write extension", () => {
  it("runs Biome inside the canonical file mutation queue", async () => {
    const root = await mkdtemp(join(tmpdir(), "biome-hook-"));
    await mkdir(join(root, "src"));
    const absolutePath = join(root, "src/example.ts");
    await writeFile(absolutePath, "const value=1");
    const exec = vi.fn().mockResolvedValue({ code: 0, stdout: "", stderr: "" });
    const deps = dependencies(exec);

    const result = await createMutationHandler(deps)(mutation(), context(root));

    expect(result).toBeUndefined();
    expect(deps.withFileMutationQueue).toHaveBeenCalledWith(
      absolutePath,
      expect.any(Function),
    );
    expect(exec).toHaveBeenCalledWith(
      "pnpm",
      [
        "exec",
        "biome",
        "check",
        "--write",
        "--no-errors-on-unmatched",
        "--",
        "src/example.ts",
      ],
      { cwd: root, signal: undefined },
    );
  });

  it("waits for the mutation queue before starting Biome", async () => {
    const root = await mkdtemp(join(tmpdir(), "biome-hook-"));
    await mkdir(join(root, "src"));
    await writeFile(join(root, "src/example.ts"), "const value=1");
    const exec = vi.fn().mockResolvedValue({ code: 0, stdout: "", stderr: "" });
    let releaseQueue: (() => void) | undefined;
    const queueReady = new Promise<void>((resolve) => {
      releaseQueue = resolve;
    });
    const withFileMutationQueue = vi.fn(
      async <T>(_filePath: string, operation: () => Promise<T>) => {
        await queueReady;
        return operation();
      },
    );

    const pending = createMutationHandler({ exec, withFileMutationQueue })(
      mutation(),
      context(root),
    );
    await vi.waitFor(() => expect(withFileMutationQueue).toHaveBeenCalled());
    expect(exec).not.toHaveBeenCalled();

    releaseQueue?.();
    await pending;

    expect(exec).toHaveBeenCalledOnce();
  });

  it("normalizes a leading @ like Pi's built-in mutation tools", async () => {
    const root = await mkdtemp(join(tmpdir(), "biome-hook-"));
    await mkdir(join(root, "src"));
    await writeFile(join(root, "src/example.ts"), "const value=1");
    const exec = vi.fn().mockResolvedValue({ code: 0, stdout: "", stderr: "" });
    const deps = dependencies(exec);

    await createMutationHandler(deps)(
      mutation({ path: "@src/example.ts" }),
      context(root),
    );

    expect(exec).toHaveBeenCalledOnce();
    expect(deps.withFileMutationQueue).toHaveBeenCalledWith(
      join(root, "src/example.ts"),
      expect.any(Function),
    );
  });

  it("passes option-shaped filenames after the option terminator", async () => {
    const root = await mkdtemp(join(tmpdir(), "biome-hook-"));
    await writeFile(join(root, "--colors=off.ts"), "const value=1");
    const exec = vi.fn().mockResolvedValue({ code: 0, stdout: "", stderr: "" });

    await createMutationHandler(dependencies(exec))(
      mutation({ path: "--colors=off.ts" }),
      context(root),
    );

    expect(exec.mock.calls[0]?.[1]).toEqual([
      "exec",
      "biome",
      "check",
      "--write",
      "--no-errors-on-unmatched",
      "--",
      "--colors=off.ts",
    ]);
  });

  it.each([
    ["failed mutation", { isError: true }],
    ["non-mutation tool", { toolName: "read" }],
    ["unsupported file", { path: "README.md" }],
    ["missing file", { path: "src/missing.ts" }],
  ])("skips %s", async (_name, overrides) => {
    const root = await mkdtemp(join(tmpdir(), "biome-hook-"));
    const deps = dependencies();

    await createMutationHandler(deps)(mutation(overrides), context(root));

    expect(deps.exec).not.toHaveBeenCalled();
    expect(deps.withFileMutationQueue).not.toHaveBeenCalled();
  });

  it("skips a symlink whose target is outside the repository", async () => {
    const root = await mkdtemp(join(tmpdir(), "biome-hook-root-"));
    const outside = await mkdtemp(join(tmpdir(), "biome-hook-outside-"));
    await writeFile(join(outside, "outside.ts"), "const value = 1;");
    await symlink(join(outside, "outside.ts"), join(root, "link.ts"));
    const deps = dependencies();

    await createMutationHandler(deps)(
      mutation({ path: "link.ts" }),
      context(root),
    );

    expect(deps.exec).not.toHaveBeenCalled();
    expect(deps.withFileMutationQueue).not.toHaveBeenCalled();
  });

  it("reports command startup failure without marking the mutation as failed", async () => {
    const root = await mkdtemp(join(tmpdir(), "biome-hook-"));
    await mkdir(join(root, "src"));
    await writeFile(join(root, "src/example.ts"), "const value=1");
    const exec = vi.fn().mockRejectedValue(new Error("pnpm was not found"));

    const result = await createMutationHandler(dependencies(exec))(
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

    const result = await createMutationHandler(dependencies(exec))(
      mutation(),
      ctx,
    );

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
