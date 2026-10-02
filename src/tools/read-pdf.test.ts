import { execFile } from "node:child_process";
import { copyFile, mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { inflateSync } from "node:zlib";
import { expect, it } from "vitest";
import { readTool } from "./fs.js";

const fixture = fileURLToPath(
  new URL("./__fixtures__/pdf/two-pages.pdf", import.meta.url),
);

function assertPage(png: Buffer, color: number[]): void {
  expect(png.subarray(0, 8)).toEqual(
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
  );
  expect(png.readUInt32BE(16)).toBe(2048);
  expect(png.readUInt32BE(20)).toBe(1024);
  const chunks: Buffer[] = [];
  for (let offset = 8; offset < png.length; ) {
    const length = png.readUInt32BE(offset);
    if (png.toString("ascii", offset + 4, offset + 8) === "IDAT") {
      chunks.push(png.subarray(offset + 8, offset + 8 + length));
    }
    offset += length + 12;
  }
  // The first pixel has no left/previous-row neighbor for any PNG filter.
  expect([...inflateSync(Buffer.concat(chunks)).subarray(1, 4)]).toEqual(color);
}

it("read renders only the selected PDF page as image content", async () => {
  const directory = await mkdtemp(join(tmpdir(), "read-pdf-test-"));
  const path = join(directory, "a ; $(touch bad).PDF");
  try {
    await copyFile(fixture, path);
    for (const [page, color] of [
      [1, [255, 0, 0]],
      [2, [0, 0, 255]],
    ] as const) {
      const result = await readTool.execute("pdf", { path, page });
      const content = result.content[0];
      expect(result.content).toHaveLength(1);
      expect(content?.type).toBe("image");
      if (content?.type !== "image") throw new Error("Expected image");
      expect(content.mimeType).toBe("image/png");
      const png = Buffer.from(content.data, "base64");
      assertPage(png, [...color]);
      expect(result.details).toEqual({
        path,
        page,
        size: png.length,
        mimeType: "image/png",
      });
    }
    expect(await readdir(directory)).toEqual(["a ; $(touch bad).PDF"]);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

it("reports out-of-range, broken, encrypted and missing PDFs without leaving files", async () => {
  const directory = await mkdtemp(join(tmpdir(), "read-pdf-test-"));
  try {
    const broken = join(directory, "broken.pdf");
    await writeFile(broken, "not a PDF");
    const encrypted = fileURLToPath(
      new URL("./__fixtures__/pdf/encrypted.pdf", import.meta.url),
    );
    await expect(
      readTool.execute("range", { path: fixture, page: 3 }),
    ).rejects.toThrow(/page 3.*ページ範囲/);
    await expect(
      readTool.execute("broken", { path: broken, page: 1 }),
    ).rejects.toThrow(/PDF.*画像化できません/);
    await expect(
      readTool.execute("missing", {
        path: join(directory, "missing.pdf"),
        page: 1,
      }),
    ).rejects.toThrow(/Couldn't open file/);
    await expect(
      readTool.execute("encrypted", { path: encrypted, page: 1 }),
    ).rejects.toThrow(/Incorrect password/);
    expect((await readdir(directory)).sort()).toEqual(["broken.pdf"]);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

it("rejects missing/invalid PDF pages and options on other file types", async () => {
  await expect(
    readTool.execute("missing-page", { path: fixture }),
  ).rejects.toThrow("page");
  for (const page of [
    0,
    -1,
    1.5,
    Number.NaN,
    Number.POSITIVE_INFINITY,
    2147483648,
  ]) {
    await expect(
      readTool.execute("invalid", { path: fixture, page }),
    ).rejects.toThrow("page");
  }
  for (const range of [{ startLine: 1 }, { lineCount: 1 }]) {
    await expect(
      readTool.execute("range", { path: fixture, page: 1, ...range }),
    ).rejects.toThrow("行範囲");
  }
  for (const path of ["missing.txt", "missing.png"]) {
    await expect(
      readTool.execute("wrong-type", { path, page: 1 }),
    ).rejects.toThrow("PDF ファイルにだけ");
  }
});

it("honors cancellation", async () => {
  const controller = new AbortController();
  controller.abort();
  await expect(
    readTool.execute("abort", { path: fixture, page: 1 }, controller.signal),
  ).rejects.toMatchObject({ name: "AbortError" });
});

const image = process.env.SANDBOX_NETWORK_TEST_IMAGE;
it.skipIf(!image)("Runner image includes a local PDF renderer", async () => {
  const { stdout } = await promisify(execFile)(
    "docker",
    [
      "run",
      "--rm",
      "--network=none",
      "-v",
      `${fixture}:/tmp/input.pdf:ro`,
      image as string,
      "pdftoppm",
      "-f",
      "2",
      "-l",
      "2",
      "-singlefile",
      "-scale-to",
      "2048",
      "-png",
      "/tmp/input.pdf",
    ],
    { encoding: "buffer", maxBuffer: 10 * 1024 * 1024 },
  );
  assertPage(stdout, [0, 0, 255]);
});
