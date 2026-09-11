import { type ChildProcessWithoutNullStreams, spawn } from "node:child_process";
import { EventEmitter } from "node:events";
import { writeFileSync } from "node:fs";
import { access, readFile, rm, stat } from "node:fs/promises";
import { dirname } from "node:path";
import { PassThrough, Writable } from "node:stream";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const fsMocks = vi.hoisted(() => ({
  createWriteStream: vi.fn(),
  realCreateWriteStream: undefined as
    | typeof import("node:fs").createWriteStream
    | undefined,
}));
const fsPromisesMocks = vi.hoisted(() => ({
  readFile: vi.fn(),
  rm: vi.fn(),
  realReadFile: undefined as
    | typeof import("node:fs/promises").readFile
    | undefined,
  realRm: undefined as typeof import("node:fs/promises").rm | undefined,
}));

vi.mock("node:child_process", () => ({
  spawn: vi.fn(),
}));

vi.mock("node:fs", async (importOriginal) => {
  const original = await importOriginal<typeof import("node:fs")>();
  fsMocks.realCreateWriteStream = original.createWriteStream;
  fsMocks.createWriteStream.mockImplementation(original.createWriteStream);
  return { ...original, createWriteStream: fsMocks.createWriteStream };
});

vi.mock("node:fs/promises", async (importOriginal) => {
  const original = await importOriginal<typeof import("node:fs/promises")>();
  fsPromisesMocks.realReadFile = original.readFile;
  fsPromisesMocks.realRm = original.rm;
  fsPromisesMocks.readFile.mockImplementation(original.readFile);
  fsPromisesMocks.rm.mockImplementation(original.rm);
  return {
    ...original,
    readFile: fsPromisesMocks.readFile,
    rm: fsPromisesMocks.rm,
  };
});

import { bashTool } from "./bash.js";

const mockSpawn = vi.mocked(spawn);
const outputDirectories: string[] = [];

type FakeChild = EventEmitter & {
  pid: number;
  exitCode: number | null;
  signalCode: NodeJS.Signals | null;
  stdout: PassThrough;
  stderr: PassThrough;
  kill: (signal: NodeJS.Signals) => boolean;
};

type MockCommandOptions = {
  stdout?: string;
  stderr?: string;
  code?: number;
  autoClose?: boolean;
};

function mockCommand({
  stdout = "",
  stderr = "",
  code = 0,
  autoClose = true,
}: MockCommandOptions = {}): FakeChild {
  const kill = vi.fn<(signal: NodeJS.Signals) => boolean>();
  const child = Object.assign(new EventEmitter(), {
    pid: 2_000_000,
    exitCode: null,
    signalCode: null,
    stdout: new PassThrough(),
    stderr: new PassThrough(),
    kill,
  }) as FakeChild;
  let closed = false;
  const close = (signal: NodeJS.Signals | null = null): void => {
    if (closed) return;
    closed = true;
    child.exitCode = code;
    child.signalCode = signal;
    let ended = 0;
    const onEnd = (): void => {
      ended += 1;
      if (ended === 2) queueMicrotask(() => child.emit("close", code, signal));
    };
    child.stdout.once("end", onEnd);
    child.stderr.once("end", onEnd);
    child.stdout.end();
    child.stderr.end();
  };
  kill.mockImplementation((signal: NodeJS.Signals) => {
    close(signal);
    return true;
  });
  mockSpawn.mockImplementationOnce(() => {
    if (autoClose) {
      queueMicrotask(() => {
        if (stdout) child.stdout.write(stdout);
        if (stderr) child.stderr.write(stderr);
        close();
      });
    }
    return child as unknown as ChildProcessWithoutNullStreams;
  });
  return child;
}

function textOf(result: Awaited<ReturnType<typeof bashTool.execute>>): string {
  const block = result.content[0];
  if (block.type !== "text") throw new Error("expected text content");
  return block.text;
}

function rememberPath(path: string): string {
  outputDirectories.push(dirname(path));
  return path;
}

function resultPath(result: { details?: unknown }): string {
  const path = (result.details as { fullOutputPath?: unknown }).fullOutputPath;
  if (typeof path !== "string") throw new Error("expected output path");
  return rememberPath(path);
}

function errorPath(error: Error): string {
  const path = (error as Error & { fullOutputPath?: unknown }).fullOutputPath;
  if (typeof path !== "string") throw new Error("expected output path");
  return rememberPath(path);
}

function failProcessGroupKill(): void {
  vi.spyOn(process, "kill").mockImplementation(() => {
    throw Object.assign(new Error("permission denied"), { code: "EPERM" });
  });
}

type CreateWriteStream = typeof import("node:fs").createWriteStream;

function realWriteStream(
  ...args: Parameters<CreateWriteStream>
): ReturnType<CreateWriteStream> {
  const createWriteStream = fsMocks.realCreateWriteStream;
  if (!createWriteStream) throw new Error("expected real createWriteStream");
  return createWriteStream(...args);
}

function failingWriteStream(error: Error): Writable {
  const stream = new Writable({
    write(_chunk, _encoding, callback) {
      callback(error);
    },
  });
  queueMicrotask(() => stream.emit("open", 1));
  return stream;
}

function mockedOutputPath(): string {
  const path = fsMocks.createWriteStream.mock.lastCall?.[0];
  if (typeof path !== "string") throw new Error("expected output file path");
  return path;
}

function mockedOutputDirectory(): string {
  return dirname(mockedOutputPath());
}

beforeEach(() => {
  vi.clearAllMocks();
  fsMocks.createWriteStream.mockImplementation(realWriteStream);
  const readFile = fsPromisesMocks.realReadFile;
  const rm = fsPromisesMocks.realRm;
  if (!readFile || !rm) throw new Error("expected real fs functions");
  fsPromisesMocks.readFile.mockImplementation(readFile);
  fsPromisesMocks.rm.mockImplementation(rm);
});

afterEach(async () => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  await Promise.all(
    outputDirectories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

describe("bashTool", () => {
  it("materializes small output before cleanup and keeps sandbox settings", async () => {
    mockCommand({ stdout: "hello\n" });
    let releaseRead!: () => void;
    const readGate = new Promise<void>((resolve) => {
      releaseRead = resolve;
    });
    fsPromisesMocks.readFile.mockImplementationOnce(async () => {
      await readGate;
      const readFile = fsPromisesMocks.realReadFile;
      if (!readFile) throw new Error("expected real readFile");
      return readFile(mockedOutputPath(), "utf8");
    });

    const pending = bashTool.execute(
      "id",
      { command: "echo hello" },
      undefined,
      undefined,
    );
    await vi.waitFor(() => expect(fsPromisesMocks.readFile).toHaveBeenCalled());
    expect(fsPromisesMocks.rm).not.toHaveBeenCalled();
    await expect(access(mockedOutputPath())).resolves.toBeUndefined();
    releaseRead();
    const result = await pending;

    expect(textOf(result)).toBe("hello");
    expect(mockSpawn).toHaveBeenCalledWith(
      "echo hello",
      expect.objectContaining({
        cwd: "/workspace",
        shell: true,
        detached: true,
        stdio: ["ignore", "pipe", "pipe"],
      }),
    );
  });

  it("returns stderr with its existing section marker", async () => {
    mockCommand({ stderr: "warn\n" });
    const result = await bashTool.execute(
      "id",
      { command: "echo warn >&2" },
      undefined,
      undefined,
    );

    expect(textOf(result)).toBe("stderr:\nwarn");
  });

  it("preserves stdout/stderr arrival order with stream markers", async () => {
    const child = mockCommand({ autoClose: false });
    const pending = bashTool.execute(
      "id",
      { command: "interleaved output" },
      undefined,
      undefined,
    );
    await vi.waitFor(() => expect(mockSpawn).toHaveBeenCalled());

    child.stdout.write("out-1\n");
    child.stderr.write("err-1\n");
    child.stdout.write("out-2\n");
    child.exitCode = 0;
    child.stdout.end();
    child.stderr.end();
    child.emit("close", 0, null);

    const result = await pending;
    expect(textOf(result)).toBe(
      "out-1\n\nstderr:\nerr-1\n\nstdout:\nout-2",
    );
  });

  it("returns the existing empty result and command failure behavior", async () => {
    mockCommand();
    const empty = await bashTool.execute(
      "id",
      { command: "true" },
      undefined,
      undefined,
    );
    expect(textOf(empty)).toBe("(出力なし)");

    mockCommand({ stderr: "error output\n", code: 1 });
    await expect(
      bashTool.execute("id", { command: "exit 1" }, undefined, undefined),
    ).rejects.toThrow("error output");
  });

  it("streams >1 MiB stdout/stderr to a private file with bounded preview and metadata", async () => {
    const stdout = "out-".repeat(300_000);
    const stderr = "err-".repeat(300_000);
    mockCommand({ stdout, stderr });

    const result = await bashTool.execute(
      "id",
      { command: "generate both" },
      undefined,
      undefined,
    );
    const path = resultPath(result);
    const fileText = await readFile(path, "utf8");
    const details = result.details as Record<string, unknown>;

    expect(fileText).toBe(`${stdout}\nstderr:\n${stderr}`);
    expect(textOf(result)).toContain("出力プレビュー（先頭・末尾）:");
    expect(textOf(result).length).toBeLessThan(30_000);
    expect((await stat(dirname(path))).mode & 0o777).toBe(0o700);
    expect((await stat(path)).mode & 0o777).toBe(0o600);
    expect(details).toMatchObject({
      command: "generate both",
      truncated: true,
      fullOutputPath: path,
      stdoutBytes: Buffer.byteLength(stdout),
      stderrBytes: Buffer.byteLength(stderr),
      truncation: {
        reason: "text-output-too-large",
        totalCharacters: fileText.length,
        totalBytes: Buffer.byteLength(fileText),
        inlineCharacterLimit: 50_000,
        lifetime: "container-run",
      },
    });
  });

  it("keeps partial non-zero output available at the path", async () => {
    const stdout = "out-".repeat(20_000);
    const stderr = "err-".repeat(20_000);
    mockCommand({ stdout, stderr, code: 1 });

    const value = await bashTool
      .execute("id", { command: "fail" }, undefined, undefined)
      .catch((error: unknown) => error);
    if (!(value instanceof Error)) throw new Error("expected command failure");
    const path = errorPath(value);

    expect(await readFile(path, "utf8")).toBe(`${stdout}\nstderr:\n${stderr}`);
    expect(value.message).toContain("保存先:");
    expect(value).toMatchObject({
      fullOutputPath: path,
      stdoutBytes: Buffer.byteLength(stdout),
      stderrBytes: Buffer.byteLength(stderr),
    });
  });

  it("keeps timeout partial output at the path", async () => {
    vi.useFakeTimers();
    failProcessGroupKill();
    const child = mockCommand({ autoClose: false });
    const pending = bashTool
      .execute("id", { command: "timed out" }, undefined, undefined)
      .catch((error: unknown) => error);
    await vi.waitFor(() => expect(mockSpawn).toHaveBeenCalled());
    child.stdout.write("partial timeout\n");
    await vi.advanceTimersByTimeAsync(30_000);
    await vi.advanceTimersByTimeAsync(250);

    const value = await pending;
    if (!(value instanceof Error)) throw new Error("expected timeout");
    const path = errorPath(value);
    expect(await readFile(path, "utf8")).toBe("partial timeout\n");
    expect(value).toMatchObject({
      fullOutputPath: path,
      truncation: { reason: "command-output", lifetime: "container-run" },
    });
    expect(child.kill).toHaveBeenCalledWith("SIGTERM");
  });

  it("stops the process and cleans up when output storage fails", async () => {
    failProcessGroupKill();
    const storageError = Object.assign(new Error("no space left"), {
      code: "ENOSPC",
    });
    fsMocks.createWriteStream.mockImplementationOnce((path: string) => {
      writeFileSync(path, "");
      return failingWriteStream(storageError);
    });
    const child = mockCommand({ autoClose: false });
    const pending = bashTool
      .execute("id", { command: "write failure" }, undefined, undefined)
      .catch((error: unknown) => error);
    await vi.waitFor(() => expect(mockSpawn).toHaveBeenCalled());
    child.stdout.write("partial output\n");

    const value = await pending;
    if (!(value instanceof Error)) throw new Error("expected write failure");
    expect(value.message).toBe("コマンド出力の保存に失敗しました");
    expect(value).not.toHaveProperty("fullOutputPath");
    expect(child.kill).toHaveBeenCalledWith("SIGTERM");
    await expect(access(mockedOutputDirectory())).rejects.toMatchObject({
      code: "ENOENT",
    });
  });
});
