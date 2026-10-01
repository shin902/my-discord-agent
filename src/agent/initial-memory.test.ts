import {
  mkdir,
  mkdtemp,
  readFile,
  rename,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { SystemOneRequest } from "@typesafe-ai/sdk";
import Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { agentMemoryPath, INITIAL_MEMORY_TYPE } from "./memory-context.js";

const threshold = vi.hoisted(() => vi.fn(async () => 0.7));
const beforeOpen = vi.hoisted(() => vi.fn(async (_filename: string) => {}));
vi.mock("node:fs/promises", async (importOriginal) => {
  const fs = await importOriginal<typeof import("node:fs/promises")>();
  return {
    ...fs,
    open: async (...args: Parameters<typeof fs.open>) => {
      await beforeOpen(String(args[0]));
      return fs.open(...args);
    },
  };
});
vi.mock("../config/agent-memory.js", () => ({
  loadAgentMemoryThreshold: threshold,
}));
let root: string;
let workspace: string;
let session: typeof import("./session.js");
let prepare: typeof import("./initial-memory.js").prepareInitialMemory;
let fetchMock: ReturnType<typeof vi.fn>;

beforeEach(async () => {
  vi.resetModules();
  root = await mkdtemp(path.join(os.tmpdir(), "initial-memory-"));
  workspace = path.join(root, "group-workspace");
  await mkdir(workspace);
  vi.stubEnv("SESSIONS_DIR", path.join(root, "sessions"));
  vi.stubEnv("TYPESAFE_API_KEY", "test-only-placeholder");
  vi.stubEnv("TYPESAFE_LOG_LEVEL", "debug");
  threshold.mockResolvedValue(0.7);
  beforeOpen.mockReset();
  fetchMock = vi.fn();
  vi.stubGlobal("fetch", fetchMock);
  session = await import("./session.js");
  ({ prepareInitialMemory: prepare } = await import("./initial-memory.js"));
});

afterEach(async () => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
  await rm(root, { recursive: true, force: true });
});

async function memory(owner: string, filename: string, body = "保存した要点") {
  const directory = path.join(workspace, agentMemoryPath(owner));
  await mkdir(directory, { recursive: true });
  await writeFile(path.join(directory, filename), body);
  return path.join(directory, filename);
}

function respond(scores: number[]) {
  fetchMock.mockImplementation(async (_url, init) => {
    const request = JSON.parse(init.body) as SystemOneRequest;
    return Response.json({
      answers: Object.fromEntries(
        Object.keys(request.questions).map((id, index) => [
          id,
          { type: "noul", noul: scores[index] },
        ]),
      ),
    });
  });
}

const run = (owner = "main", request = "最初の依頼", signal?: AbortSignal) =>
  prepare(workspace, "group", "session", owner, request, 60_000, signal);
const messages = (owner = "main") =>
  session.loadMessages("group", "session", owner);

describe("initial owner memory at the host/session boundary", () => {
  it("batches filenames (not bodies), validates independent scores, thresholds and selects at most five in rank order", async () => {
    const filenames = Array.from({ length: 8 }, (_, i) => `記憶${i}.md`);
    for (const filename of filenames)
      await memory("main", filename, `本文:${filename}`);
    await memory("other", "別owner.md", "other private body");
    await memory("main", "ignored.txt");
    respond([0.1, 0.7, 0.95, 0.9, 0.85, 0.8, 0.75, 0.69]);
    const debug = vi.spyOn(console, "debug");
    await run();
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const request = JSON.parse(
      fetchMock.mock.calls[0][1].body,
    ) as SystemOneRequest;
    expect(request.state).toBe("最初の依頼");
    expect(Object.values(request.questions)).toHaveLength(8);
    expect(
      Object.values(request.questions).every((q) => q.type === "noul"),
    ).toBe(true);
    expect(JSON.stringify(request)).not.toContain("本文:");
    expect(JSON.stringify(request)).not.toContain("別owner");
    expect(request.questions.memory_0.instructions).toMatchObject({
      filename: "記憶0.md",
    });
    expect(request.questions.memory_0.criteria).toMatchObject({
      false: expect.stringContaining("話題が似ているだけ"),
    });
    const [snapshot] = await messages();
    expect(snapshot).toMatchObject({
      role: "custom",
      customType: INITIAL_MEMORY_TYPE,
      outcome: "selected",
      content: [2, 3, 4, 5, 6]
        .map((i) => `## Agent Memory ("記憶${i}.md")\n\n本文:記憶${i}.md`)
        .join("\n\n"),
    });
    expect(debug).not.toHaveBeenCalled();
  });

  it("uses the configured inclusive threshold without filling unrelated slots", async () => {
    threshold.mockResolvedValue(0.9);
    await memory("main", "京都の食の好み.md");
    await memory("main", "関連するだけ.md");
    respond([0.9, 0.89]);
    await run("main", "京都旅行の夕食を決めたい");
    expect((await messages())[0]).toMatchObject({
      outcome: "selected",
      content: expect.stringContaining("京都の食の好み.md"),
    });
    expect((await messages())[0]).toMatchObject({
      content: expect.not.stringContaining("関連するだけ"),
    });
  });

  it("persists no candidates and no matches; subsequent memory creation never reselects", async () => {
    await run();
    expect((await messages())[0]).toMatchObject({
      outcome: "no-candidates",
      content: "",
    });
    expect(fetchMock).not.toHaveBeenCalled();
    await memory("main", "new.md");
    await run();
    expect(fetchMock).not.toHaveBeenCalled();
    await memory("worker", "unrelated.md");
    respond([0.2]);
    await run("worker");
    await run("worker");
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(await messages("worker")).toEqual([
      expect.objectContaining({ outcome: "no-match", content: "" }),
    ]);
  });

  it("selects despite a Bot role snapshot and replays the original snapshot on retry, continuation and rename/resume", async () => {
    const owner = "レビュー / ../💡";
    await session.appendMessage(
      "group",
      "session",
      {
        role: "custom",
        customType: "system-prompt-snapshot",
        content: "Bot role",
        display: false,
        timestamp: 1,
      },
      owner,
    );
    const filename = await memory(owner, "判断基準.md", "元の本文".repeat(200));
    respond([0.95]);
    await run(owner, "cron or task execution prompt");
    const initial = await messages(owner);
    expect(initial).toHaveLength(2);
    expect(initial[1]).toMatchObject({
      content: expect.stringContaining("元の本文".repeat(200)),
    }); // No mechanical 500-character truncation.
    await writeFile(filename, "変更後の本文");
    await run(owner, "execution retry");
    expect(await messages(owner)).toEqual(initial);
    await session.appendMessage(
      "group",
      "session",
      { role: "user", content: "実際の依頼", timestamp: 2 },
      owner,
    );
    await run(owner, "continuation");
    await session.renameSession("group", "session", "resumed", owner);
    await prepare(workspace, "group", "resumed", owner, "resume", 60_000);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(await session.loadMessages("group", "resumed", owner)).toEqual([
      ...initial,
      { role: "user", content: "実際の依頼", timestamp: 2 },
    ]);
    const db = new Database(path.join(root, "sessions/group/sessions.sqlite"));
    expect(
      db
        .prepare(
          "SELECT entry_type, source_json FROM session_entries ORDER BY sequence",
        )
        .all(),
    ).toEqual([
      { entry_type: "system-prompt-snapshot", source_json: null },
      { entry_type: INITIAL_MEMORY_TYPE, source_json: null },
      { entry_type: "user", source_json: null },
    ]);
    db.close();
    expect(JSON.parse(fetchMock.mock.calls[0][1].body).state).toBe(
      "cron or task execution prompt",
    );
  });

  it("does not retrofit memory into an existing conversation without a marker", async () => {
    await memory("main", "記憶.md");
    await session.appendMessage(
      "group",
      "session",
      { role: "user", content: "past request", timestamp: 1 },
      "main",
    );
    await run();
    expect(fetchMock).not.toHaveBeenCalled();
    expect(await messages()).toHaveLength(1);
  });

  it("keeps group and exact owner identities distinct, including path-like names", async () => {
    const owners = [
      "main",
      "../main",
      "a/b",
      "a%2Fb",
      "..",
      "日本語",
      "\ud800",
      "\ud801",
    ];
    expect(new Set(owners.map(agentMemoryPath)).size).toBe(owners.length);
    for (const owner of owners) {
      expect(agentMemoryPath(owner)).toMatch(
        /^agent-memory\/owner-[a-zA-Z0-9_-]+$/,
      );
    }
    await memory("main", "first.md", "first group");
    respond([1]);
    await run();
    const otherWorkspace = path.join(root, "other-workspace");
    await mkdir(otherWorkspace);
    await prepare(
      otherWorkspace,
      "other-group",
      "session",
      "main",
      "request",
      60_000,
    );
    expect(
      await session.loadMessages("other-group", "session", "main"),
    ).toEqual([expect.objectContaining({ outcome: "no-candidates" })]);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("ignores nested files and file symlinks and rejects a symlinked owner directory", async () => {
    const filename = await memory("other", "hidden.md", "do not read");
    const directory = path.join(workspace, agentMemoryPath("main"));
    await mkdir(path.join(directory, "nested"), { recursive: true });
    await writeFile(path.join(directory, "nested/deep.md"), "nested");
    await symlink(filename, path.join(directory, "link.md"));
    await run();
    expect((await messages())[0]).toMatchObject({ outcome: "no-candidates" });
    await symlink(
      path.dirname(filename),
      path.join(workspace, agentMemoryPath("alias")),
    );
    await run("alias");
    expect((await messages("alias"))[0]).toMatchObject({ outcome: "failed" });
    expect(fetchMock).not.toHaveBeenCalled();
    expect(await readFile(filename, "utf-8")).toBe("do not read");
  });

  it.each([
    "agent-memory",
    "owner",
  ])("reads only the pinned directory when %s is swapped immediately before file open", async (level) => {
    const filename = await memory("main", "same.md", "workspace memory");
    const owner = path.dirname(filename);
    const target = level === "owner" ? owner : path.dirname(owner);
    const outside = path.join(root, "host-private");
    const outsideOwner =
      level === "owner" ? outside : path.join(outside, path.basename(owner));
    await mkdir(outsideOwner, { recursive: true });
    await writeFile(path.join(outsideOwner, "same.md"), "HOST SECRET");
    respond([1]);
    let swapped = false;
    beforeOpen.mockImplementation(async (file) => {
      if (!file.endsWith("/same.md")) return;
      await rename(target, `${target}-moved`);
      await symlink(outside, target);
      swapped = true;
    });
    await run();
    expect(swapped).toBe(true);
    expect(await messages()).toEqual([
      expect.objectContaining({
        outcome: "selected",
        content: '## Agent Memory ("same.md")\n\nworkspace memory',
      }),
    ]);
  });

  it.each([
    "agent-memory",
    "owner",
    "file",
  ])("rejects a symlink swapped in immediately before opening the %s component", async (level) => {
    const filename = await memory("main", "same.md");
    const owner = path.dirname(filename);
    const target =
      level === "file"
        ? filename
        : level === "owner"
          ? owner
          : path.dirname(owner);
    const outside = path.join(root, "host-private");
    await mkdir(outside);
    const secret = path.join(outside, "same.md");
    await writeFile(secret, "HOST SECRET");
    respond([1]);
    let swapped = false;
    beforeOpen.mockImplementation(async (file) => {
      if (!file.endsWith(`/${path.basename(target)}`)) return;
      await rename(target, `${target}-moved`);
      await symlink(level === "file" ? secret : outside, target);
      swapped = true;
    });
    await run();
    expect(swapped).toBe(true);
    expect(await messages()).toEqual([
      expect.objectContaining({
        outcome: "failed",
        content: "メモリ選択に失敗しました。今回は追加メモリなしで続行します。",
      }),
    ]);
  });

  it.each([
    408, 429, 503,
  ])("retries transient HTTP %i at most five times and persists a safe failure once", async (status) => {
    await memory("main", "記憶.md");
    fetchMock.mockImplementation(async () =>
      Response.json(
        { error: "sensitive remote error" },
        { status, headers: { "retry-after-ms": "0" } },
      ),
    );
    await run();
    expect(fetchMock).toHaveBeenCalledTimes(5);
    expect(await messages()).toEqual([
      expect.objectContaining({
        outcome: "failed",
        content: "メモリ選択に失敗しました。今回は追加メモリなしで続行します。",
      }),
    ]);
    await run();
    expect(fetchMock).toHaveBeenCalledTimes(5);
  });

  it.each([
    401, 403, 422,
  ])("does not retry authentication/validation HTTP %i", async (status) => {
    await memory("main", "記憶.md");
    fetchMock.mockResolvedValue(Response.json({}, { status }));
    await run();
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect((await messages())[0]).toMatchObject({ outcome: "failed" });
  });

  it.each([
    {},
    { wrong_id: { type: "noul", noul: 0.9 } },
    { memory_0: { type: "choice", noul: 0.9 } },
    { memory_0: { type: "noul", noul: 1.1 } },
    { memory_0: { type: "noul", noul: -0.1 } },
    { memory_0: { type: "noul", noul: "0.9" } },
    { memory_0: { type: "noul", noul: null } },
  ])("rejects malformed answers without an outer retry: %j", async (answers) => {
    await memory("main", "記憶.md");
    fetchMock.mockResolvedValue(Response.json({ answers }));
    await run();
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect((await messages())[0]).toMatchObject({ outcome: "failed" });
  });

  it("fails open without an API key and does not call the API", async () => {
    vi.stubEnv("TYPESAFE_API_KEY", "");
    await memory("main", "記憶.md");
    await run();
    expect(fetchMock).not.toHaveBeenCalled();
    expect((await messages())[0]).toMatchObject({ outcome: "failed" });
  });

  it("honors cancellation during retry backoff without persisting a completed outcome", async () => {
    await memory("main", "記憶.md");
    const controller = new AbortController();
    fetchMock.mockImplementation(async () => {
      setTimeout(() => controller.abort(new Error("cancelled")), 10);
      return Response.json(
        {},
        { status: 503, headers: { "retry-after-ms": "60000" } },
      );
    });
    await expect(run("main", "request", controller.signal)).rejects.toThrow(
      "cancelled",
    );
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(await messages()).toEqual([]);
  });

  it("bounds the total selection wait and persists timeout as a fail-open result", async () => {
    await memory("main", "記憶.md");
    fetchMock.mockImplementation(
      (_url, init) =>
        new Promise((_resolve, reject) => {
          init.signal.addEventListener(
            "abort",
            () => reject(init.signal.reason),
            { once: true },
          );
        }),
    );
    await prepare(workspace, "group", "session", "main", "request", 20);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect((await messages())[0]).toMatchObject({ outcome: "failed" });
  });
});
