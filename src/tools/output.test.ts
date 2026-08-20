import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

import type { AgentTool, AgentToolResult } from "@earendil-works/pi-agent-core";
import { afterEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";

import { grepTool, readTool } from "./fs.js";
import {
  externalizeLargeToolResult,
  TOOL_OUTPUT_CHAR_LIMIT,
  wrapToolOutput,
  parseExternalizedDetails,
  isExternalizedToolOutput,
  ExternalDetailsSchema,
} from "./output.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

interface TextResultDetails { source: string; requestId?: string; count?: number; }

function textResult(
  text: string,
  details: TextResultDetails = { source: "test" },
  terminate?: boolean,
): AgentToolResult<TextResultDetails> {
  const result: AgentToolResult<TextResultDetails> = { content: [{ type: "text", text }], details };
  if (terminate !== undefined) result.terminate = terminate;
  return result;
}

function fakeTool(name: string, result: AgentToolResult<unknown>): AgentTool {
  return {
    name,
    label: name,
    description: name,
    parameters: z.object({}),
    execute: vi.fn(async () => result),
  };
}

function externalizedOutput(result: AgentToolResult<unknown>) {
  const details = parseExternalizedDetails(ExternalDetailsSchema.parse(result.details));
  return { details, path: details.fullOutputPath };
}

function firstText(result: AgentToolResult<unknown>): string {
  const first = result.content[0];
  if (!first || first.type !== "text") {
    throw new Error("Expected text content");
  }
  return first.text;
}

function rememberOutput(path: string): void {
  temporaryDirectories.push(dirname(path));
}

describe("common tool output boundary", () => {
  it("leaves output at the character boundary unchanged", async () => {
    const text = "x".repeat(TOOL_OUTPUT_CHAR_LIMIT);
    const input = textResult(text);

    const result = await externalizeLargeToolResult(input);

    expect(result).toBe(input);
    expect(result.content[0]).toEqual({ type: "text", text });
    expect(result.details).toEqual({ source: "test" });
  });

  it("externalizes oversized text with complete UTF-8 preservation and metadata", async () => {
    const text = `${"😀日本語 café\n".repeat(5_000)}end`;
    expect(text.length).toBeGreaterThan(TOOL_OUTPUT_CHAR_LIMIT);
    const input = textResult(text, {
      source: "test",
      requestId: "user-secret",
    });

    const result = await externalizeLargeToolResult(input);
    const { details, path } = externalizedOutput(result);
    rememberOutput(path);

    expect(await readFile(path)).toEqual(Buffer.from(text, "utf8"));
    expect(path).toMatch(/^\/tmp\/my-discord-agent-tool-[^/]+\/output\.txt$/);
    expect(path).not.toContain("user-secret");
    expect(result.content).toHaveLength(1);
    expect(firstText(result)).toContain("ツール出力が大きいため");
    expect(firstText(result)).toContain(`保存先: ${path}`);
    expect(firstText(result)).toContain(
      `元サイズ: ${text.length} 文字 / 5001 行`,
    );
    expect(details).toMatchObject({
      source: "test",
      requestId: "user-secret",
      truncated: true,
      fullOutputPath: path,
      truncation: {
        reason: "text-output-too-large",
        totalCharacters: text.length,
        totalBytes: Buffer.byteLength(text, "utf8"),
        totalLines: 5_001,
        inlineCharacterLimit: TOOL_OUTPUT_CHAR_LIMIT,
        lifetime: "container-run",
      },
    });
  });

  it("preserves grep details.truncated while namespacing wrapper metadata", async () => {
    const inputDirectory = await mkdtemp("/tmp/grep-details-");
    temporaryDirectories.push(inputDirectory);
    const inputPath = join(inputDirectory, "matches.txt");
    const input = Array.from(
      { length: 200 },
      (_, index) => `needle-${index} ${"x".repeat(320)}`,
    ).join("\n");
    await writeFile(inputPath, input, "utf8");

    const grepResult = await grepTool.execute("grep", {
      pattern: "needle",
      path: inputPath,
    });
    expect(grepResult.details).toMatchObject({
      count: 200,
      truncated: false,
    });
    expect(firstText(grepResult).length).toBeGreaterThan(
      TOOL_OUTPUT_CHAR_LIMIT,
    );

    const result = await externalizeLargeToolResult(grepResult);
    const details = parseExternalizedDetails(ExternalDetailsSchema.parse(result.details));
    const nestedDetails = ExternalDetailsSchema.safeParse(details.externalizedOutput);
    const metadata = nestedDetails.success && isExternalizedToolOutput(nestedDetails.data)
      ? nestedDetails.data
      : details;
    rememberOutput(metadata.fullOutputPath);

    expect(details.pattern).toBe("needle");
    expect(details.count).toBe(200);
    expect(details.truncated).toBe(false);
    expect(metadata).toMatchObject({
      truncated: true,
      fullOutputPath: expect.any(String),
      truncation: {
        reason: "text-output-too-large",
        totalCharacters: firstText(grepResult).length,
        totalBytes: Buffer.byteLength(firstText(grepResult), "utf8"),
        totalLines: 200,
        inlineCharacterLimit: TOOL_OUTPUT_CHAR_LIMIT,
        lifetime: "container-run",
      },
    });
    expect(await readFile(metadata.fullOutputPath, "utf8")).toBe(
      firstText(grepResult),
    );
  });

  it("preserves details and terminate while replacing only text blocks", async () => {
    const text = "line\n".repeat(12_000);
    const input = textResult(text, { source: "upstream", count: 3 }, true);

    const result = await externalizeLargeToolResult(input);
    const { details, path } = externalizedOutput(result);
    rememberOutput(path);

    expect(result.terminate).toBe(true);
    expect(details.source).toBe("upstream");
    expect(details.count).toBe(3);
    expect(details.truncated).toBe(true);
    expect(firstText(result)).toContain("startLine/lineCount");
    expect(firstText(result)).toContain("tailCount");
    expect(firstText(result)).not.toContain("tailLines");
  });

  it("preserves image-only base64 content without inspecting it as text", async () => {
    const input: AgentToolResult<{ source: string }> = {
      content: [
        {
          type: "image",
          data: "base64".repeat(100_000),
          mimeType: "image/png",
        },
      ],
      details: { source: "image" },
      terminate: true,
    };

    const result = await externalizeLargeToolResult(input);

    expect(result).toBe(input);
  });

  it("externalizes mixed text blocks while preserving images and their order", async () => {
    const image = {
      type: "image" as const,
      data: "base64-image-data",
      mimeType: "image/jpeg",
    };
    const text = "mixed\n".repeat(12_000);
    const input: AgentToolResult<{ source: string }> = {
      content: [{ type: "text", text }, image],
      details: { source: "mixed" },
    };

    const result = await externalizeLargeToolResult(input);
    const { path } = externalizedOutput(result);
    rememberOutput(path);

    expect(result.content).toHaveLength(2);
    expect(result.content[0]).toMatchObject({ type: "text" });
    expect(result.content[1]).toBe(image);
    expect(await readFile(path, "utf8")).toBe(text);
  });

  it("keeps oversized base64 image data unchanged when text is within the limit", async () => {
    const image = {
      type: "image" as const,
      data: "base64".repeat(100_000),
      mimeType: "image/webp",
    };
    const input: AgentToolResult<{ source: string }> = {
      content: [
        { type: "text", text: "x".repeat(TOOL_OUTPUT_CHAR_LIMIT) },
        image,
      ],
      details: { source: "mixed-at-boundary" },
    };

    const result = await externalizeLargeToolResult(input);

    expect(result).toBe(input);
  });

  it("uses private permissions for the directory and full-output file", async () => {
    const result = await externalizeLargeToolResult(
      textResult("x".repeat(TOOL_OUTPUT_CHAR_LIMIT + 1)),
    );
    const { path } = externalizedOutput(result);
    rememberOutput(path);

    expect((await stat(dirname(path))).mode & 0o777).toBe(0o700);
    expect((await stat(path)).mode & 0o777).toBe(0o600);
  });

  it("lets read ranges, tailCount, and grep consume the file in the same run", async () => {
    const text = Array.from(
      { length: 10_000 },
      (_, index) => `record-${index}: payload\n`,
    ).join("");
    const result = await externalizeLargeToolResult(textResult(text));
    const { path, details } = externalizedOutput(result);
    rememberOutput(path);

    const range = await readTool.execute("read-range", {
      path,
      startLine: 1,
      lineCount: 2,
    });
    expect(firstText(range)).toBe("record-0: payload\nrecord-1: payload");

    const tail = await readTool.execute("read-tail", {
      path,
      tailCount: 2,
    });
    expect(firstText(tail)).toBe("record-9998: payload\nrecord-9999: payload");

    const matches = await grepTool.execute("grep", {
      pattern: "record-9999",
      path,
    });
    expect(firstText(matches)).toContain(`${path}:10000: record-9999: payload`);
    expect(details.truncation.totalLines).toBe(10_000);
  });

  it("applies the boundary through the wrapper while retaining tool details", async () => {
    const text = "grep-result\n".repeat(5_000);
    const tool = fakeTool(
      "grep",
      textResult(text, { source: "wrapped" }, true),
    );
    const wrapped = wrapToolOutput(tool);

    const result = await wrapped.execute("call-1", {
      pattern: "result",
      path: "input.txt",
    });
    const { details, path } = externalizedOutput(result);
    rememberOutput(path);

    expect(result.terminate).toBe(true);
    expect(details.source).toBe("wrapped");
    expect(firstText(result)).toContain("grep");
  });
});
