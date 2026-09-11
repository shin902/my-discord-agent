import { spawn as realSpawn } from "node:child_process";
import { dirname } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("node:child_process", async (original) => {
  const actual = await original<typeof import("node:child_process")>();
  return {
    ...actual,
    spawn: vi.fn((command, args, options) =>
      actual.spawn(command, args, { ...options, cwd: process.cwd() }),
    ),
  };
});
vi.mock("node:fs/promises", async (original) => {
  const actual = await original<typeof import("node:fs/promises")>();
  return {
    ...actual,
    open: vi.fn(actual.open),
    mkdtemp: vi.fn(actual.mkdtemp),
  };
});

import { mkdtemp, open, readFile, rm, stat } from "node:fs/promises";
import { bashTool } from "./bash.js";
import { externalizeLargeToolResult } from "./output.js";

function run(command: string, signal?: AbortSignal) {
  return bashTool.execute("id", { command }, signal, undefined);
}

function getText(result: Awaited<ReturnType<typeof run>>): string {
  const c = result.content[0];
  if (c.type !== "text") throw new Error("expected text content");
  return c.text;
}

function outputDetails(result: { details: unknown }) {
  return result.details as {
    fullOutputPath: string;
    totalBytes: number;
    previewBytes: number;
    truncated: boolean;
    lifetime: string;
  };
}

afterEach(async () => {
  vi.useRealTimers();
  for (const result of vi.mocked(mkdtemp).mock.results) {
    if (result.type === "return") {
      await rm(await result.value, { recursive: true, force: true });
    }
  }
  vi.clearAllMocks();
  vi.mocked(open).mockReset();
  vi.mocked(open).mockImplementation(
    (
      await vi.importActual<typeof import("node:fs/promises")>(
        "node:fs/promises",
      )
    ).open,
  );
});

describe("bashTool streaming output", () => {
  it("keeps small stdout inline and saves a private, exact byte copy", async () => {
    const result = await run("printf 'hello\\n'");
    expect(getText(result)).toBe("hello");
    const details = outputDetails(result);
    expect(details).toMatchObject({
      totalBytes: 6,
      truncated: false,
      lifetime: "container-run",
    });
    expect(details.fullOutputPath).toMatch(
      /^\/tmp\/my-discord-agent-bash-[^/]+\/output\.txt$/,
    );
    expect(await readFile(details.fullOutputPath, "utf8")).toBe("hello\n");
    expect((await stat(dirname(details.fullOutputPath))).mode & 0o777).toBe(
      0o700,
    );
    expect((await stat(details.fullOutputPath)).mode & 0o777).toBe(0o600);
  });

  it("merges stdout/stderr in pipe order, without labels or inserted newlines", async () => {
    const result = await run("printf err >&2; printf out; printf end >&2");
    expect(getText(result)).toBe("erroutend");
    expect(await readFile(outputDetails(result).fullOutputPath, "utf8")).toBe(
      "erroutend",
    );
  });

  it("returns the existing no-output placeholder and moderately sized output", async () => {
    expect(getText(await run("true"))).toBe("(出力なし)");
    expect(getText(await run("head -c 15000 /dev/zero | tr '\\0' a"))).toBe(
      "a".repeat(15000),
    );
  });

  it("preserves >1 MiB from each descriptor with a bounded head preview", async () => {
    const size = 2 * 1024 * 1024;
    const result = await run(
      `head -c ${size} /dev/zero | tr '\\0' a; head -c ${size} /dev/zero | tr '\\0' b >&2; printf 終`,
    );
    const details = outputDetails(result);
    expect(details).toMatchObject({
      totalBytes: size * 2 + 3,
      truncated: true,
      previewBytes: 32768,
      lifetime: "container-run",
    });
    expect(await readFile(details.fullOutputPath, "utf8")).toBe(
      `${"a".repeat(size)}${"b".repeat(size)}終`,
    );
    expect(getText(result).length).toBeLessThan(34_000);
    expect(getText(result)).toContain(details.fullOutputPath);
    expect(getText(result)).toContain("current container run");
    expect(await externalizeLargeToolResult(result)).toBe(result);
  });

  it("exposes the complete acquired output on non-zero exit", async () => {
    const error = await run("printf partial; printf error >&2; exit 7").catch(
      (error: Error & { details: unknown }) => error,
    );
    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toContain("exit 7");
    const details = outputDetails(error);
    expect((error as Error).message).toContain(details.fullOutputPath);
    expect(await readFile(details.fullOutputPath, "utf8")).toBe("partialerror");
  });

  it("preserves acquired output when the command times out", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const pending = run("printf partial; sleep 60").catch(
      (error: Error & { details: unknown }) => error,
    );
    // Wait for capture rather than guessing when the shell has produced output.
    await vi.waitFor(async () => {
      const directory = await vi.mocked(mkdtemp).mock.results[0]?.value;
      expect(await readFile(`${directory}/output.txt`, "utf8")).toBe("partial");
    });
    await vi.advanceTimersByTimeAsync(30_000);
    const error = await pending;
    expect((error as Error).message).toContain("timed out");
    const details = outputDetails(error);
    expect((error as Error).message).toContain(details.fullOutputPath);
    expect(await readFile(details.fullOutputPath, "utf8")).toBe("partial");
  });

  it("does not start the command when output storage cannot be opened", async () => {
    vi.mocked(open).mockRejectedValueOnce(
      Object.assign(new Error("ENOSPC"), { code: "ENOSPC" }),
    );
    await expect(run("yes")).rejects.toThrow(
      "Output storage failed; capture discarded",
    );
    expect(realSpawn).not.toHaveBeenCalled();
    const directory = await vi.mocked(mkdtemp).mock.results[0].value;
    await expect(stat(directory)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it.runIf(process.platform === "linux")(
    "discards ENOSPC capture and stops an unbounded producer",
    async () => {
      const actual =
        await vi.importActual<typeof import("node:fs/promises")>(
          "node:fs/promises",
        );
      vi.mocked(open).mockImplementationOnce(async (path, flags, mode) => {
        const partial = await actual.open(path, flags, mode);
        await partial.writeFile("partial capture occupying disk");
        await partial.close();
        return actual.open("/dev/full", "w");
      });
      const error = await run("yes").catch((error: Error) => error);
      expect(error).toBeInstanceOf(Error);
      expect((error as Error).message).toBe(
        "Output storage failed; capture discarded",
      );
      expect(error).not.toHaveProperty("details.fullOutputPath");
      const directory = await vi.mocked(mkdtemp).mock.results[0].value;
      await expect(stat(directory)).rejects.toMatchObject({ code: "ENOENT" });
      const child = vi.mocked(realSpawn).mock.results[0].value;
      expect(child.exitCode !== null || child.signalCode !== null).toBe(true);
      expect(getText(await run("printf recovered"))).toBe("recovered");
    },
  );
});
