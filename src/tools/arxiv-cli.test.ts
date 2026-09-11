import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import {
  afterAll,
  afterEach,
  beforeAll,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import {
  createToolProxyRequestHandler,
  createToolProxyRun,
  initToolProxyServer,
} from "../proxy/tool-proxy-server.js";
import { executeRuntimeRequest } from "../runtime/tool-runtime.js";
import * as runtime from "../runtime/tool-runtime-client.js";
import { resolveTools } from "./registry.js";

const execFileAsync = promisify(execFile);
const originalFetch = globalThis.fetch;
let directory: string;
let url: string;
let atom: string;
const server = createServer(createToolProxyRequestHandler());
beforeAll(async () => {
  await initToolProxyServer();
  directory = await mkdtemp(join(tmpdir(), "arxiv-cli-"));
  await writeFile(
    join(directory, "tool-proxy"),
    `#!/bin/sh\nexec node --import tsx "${process.cwd()}/src/sandbox/tool-proxy-cli.ts" "$@"\n`,
    { mode: 0o700 },
  );
  atom = await readFile(
    new URL("../runtime/fixtures/arxiv.xml", import.meta.url),
    "utf8",
  );
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("no port");
  url = `http://127.0.0.1:${address.port}/__tool-proxy/rpc`;
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});
afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
  await rm(directory, { recursive: true, force: true });
});

function python(capability: string, args: string[], token: string) {
  const script = capability === "arxiv-search" ? "search.py" : "survey.py";
  return execFileAsync(
    "python3",
    [`templates/SKILLS/arxiv/scripts/${script}`, ...args],
    {
      env: {
        ...process.env,
        PATH: `${directory}:${process.env.PATH}`,
        DOTENV_CONFIG_PATH: "/dev/null",
        TOOL_PROXY_URL: url,
        TOOL_PROXY_TOKEN: token,
      },
    },
  );
}

describe("arXiv Python frontend parity", () => {
  it.each([
    {
      name: "arxiv-search",
      argv: ['one "  two\\ three'],
      args: { query: 'one "  two\\ three' },
      limit: "10",
      sort: "relevance",
    },
    {
      name: "arxiv-survey",
      argv: ["first", "second"],
      args: { queries: ["first", "second"] },
      limit: "30",
      sort: "submittedDate",
    },
  ])("$name returns the native normalized JSON array and preserves defaults", async ({
    name,
    argv,
    args,
    limit,
    sort,
  }) => {
    const upstream: URL[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input, options) => {
        if (String(input).startsWith("https://export.arxiv.org/")) {
          upstream.push(new URL(String(input)));
          return new Response(atom);
        }
        return originalFetch(input, options);
      }),
    );
    vi.spyOn(runtime, "executeToolRuntime").mockImplementation(
      async (capability, effectiveArgs) => {
        const response = await executeRuntimeRequest({
          capability,
          args: effectiveArgs,
        });
        if ("error" in response) throw new Error(response.error);
        return response.result;
      },
    );
    const run = createToolProxyRun("arxiv-cli", [name]);
    if (!run) throw new Error("no run");
    try {
      const [native] = resolveTools(
        [name],
        {},
        { toolProxyEndpoint: { url, token: run.token } },
      );
      const nativeResult = await native.execute("native", args);
      const { stdout, stderr } = await python(name, argv, run.token);
      expect(stderr).toBe("");
      const nativeText = nativeResult.content[0];
      if (nativeText.type !== "text") throw new Error("no text");
      expect(stdout).toBe(nativeText.text);
      const papers = JSON.parse(stdout);
      expect(Array.isArray(papers)).toBe(true);
      expect(papers[0]).toMatchObject({
        id: "2608.12345",
        version: 2,
        updated_at: "2026-08-20T03:00:00.000Z",
      });
      // Native deduplication retains only the first anonymous entry with no ID/link.
      expect(papers.filter((paper: { id: string }) => !paper.id)).toHaveLength(
        1,
      );
      expect(upstream).toHaveLength(2);
      expect(upstream[1].toString()).toBe(upstream[0].toString());
      expect(upstream[1].searchParams.get("max_results")).toBe(limit);
      expect(upstream[1].searchParams.get("sortBy")).toBe(sort);
      if (name === "arxiv-search")
        expect(upstream[1].searchParams.get("search_query")).toBe(
          'all:"one   two  three"',
        );
    } finally {
      run.revoke();
    }
  });

  it("preserves date/sort flags and rejects out-of-range limits before any RPC", async () => {
    const execute = vi.spyOn(runtime, "executeToolRuntime").mockResolvedValue({
      content: [{ type: "text", text: "[]" }],
      details: {},
    });
    const run = createToolProxyRun("arxiv-flags", [
      "arxiv-search",
      "arxiv-survey",
    ]);
    if (!run) throw new Error("no run");
    try {
      await python(
        "arxiv-search",
        [
          "q",
          "--from",
          "2026-08-01",
          "--to",
          "2026-08-31",
          "--limit",
          "50",
          "--sort",
          "updated",
        ],
        run.token,
      );
      expect(execute.mock.calls[0][1]).toEqual({
        query: "q",
        from: "2026-08-01",
        to: "2026-08-31",
        max_results: 50,
        sort: "updated",
      });
      execute.mockClear();
      for (const argv of [
        ["q", "--limit", "0"],
        ["q", "--limit", "51"],
        ["q", "--from", "2026-02-30"],
        ["q", "--from", "2026-08-31", "--to", "2026-08-01"],
      ])
        await expect(
          python("arxiv-search", argv, run.token),
        ).rejects.toMatchObject({ code: 2 });
      await expect(
        python(
          "arxiv-survey",
          Array.from({ length: 9 }, () => "q"),
          run.token,
        ),
      ).rejects.toMatchObject({ code: 2 });
      expect(execute).not.toHaveBeenCalled();
    } finally {
      run.revoke();
    }
  });
});
