import { execFile } from "node:child_process";
import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { describe, expect, it, vi } from "vitest";
import networkCases from "./__fixtures__/agent-reach/network-cases.json" with {
  type: "json",
};
import {
  agentReachTool,
  buildCommand,
  isPublicIpAddress,
  validatePublicDestination,
} from "./agent-reach.js";
import { installRssPythonFixtures } from "./agent-reach-rss-test-utils.js";

const execFileAsync = promisify(execFile);

type LookupResult = { address: string; family: number };
const lookup = async (addresses: string[]): Promise<LookupResult[]> =>
  addresses.map((address) => ({
    address,
    family: address.includes(":") ? 6 : 4,
  }));

describe("agent-reach destination policy", () => {
  it.each(networkCases)("$name: $address", ({ address, public: expected }) => {
    expect(isPublicIpAddress(address)).toBe(expected);
  });

  it("checks every DNS answer and fails closed when one is non-public", async () => {
    const resolver = vi.fn(async () => lookup(["8.8.8.8", "100.127.255.255"]));

    await expect(
      validatePublicDestination("mixed.example", resolver),
    ).rejects.toThrow("100.127.255.255");
    expect(resolver).toHaveBeenCalledWith("mixed.example", {
      all: true,
      verbatim: true,
    });
  });

  it("fails closed for DNS errors and empty answers", async () => {
    await expect(
      validatePublicDestination("broken.example", async () => {
        throw new Error("resolver unavailable");
      }),
    ).rejects.toThrow("DNS解決に失敗");

    await expect(
      validatePublicDestination("empty.example", async () => []),
    ).rejects.toThrow("DNS解決結果が空");
  });

  it("rejects blocked URLs before any fetch command runs", async () => {
    for (const url of [
      "https://100.64.0.1/feed.xml",
      "https://[2001:db8::1]/feed.xml",
    ]) {
      await expect(agentReachTool.execute("security", { url })).rejects.toThrow(
        "内部アドレスへのアクセスは禁止",
      );
    }
  });

  it("fetches a public RSS feed through multiple validated redirects", async () => {
    const testDir = await mkdtemp(join(tmpdir(), "agent-reach-rss-redirect-"));
    try {
      const output = join(testDir, "rss.md");
      const requestLog = join(testDir, "requests.log");
      const parseMarker = join(testDir, "parse-marker");
      await installRssPythonFixtures(testDir, {
        "https://8.8.8.8/feed.xml": {
          status: 302,
          location: "https://8.8.4.4/step.xml",
        },
        "https://8.8.4.4/step.xml": {
          status: 301,
          location: "https://1.1.1.1/final.xml",
        },
        "https://1.1.1.1/final.xml": {
          status: 200,
          body: "<rss><channel><title>fixture</title></channel></rss>",
        },
      });

      await execFileAsync(
        "bash",
        ["-c", buildCommand("rss", "https://8.8.8.8/feed.xml", output)],
        {
          env: {
            ...process.env,
            AGENT_REACH_RSS_REQUEST_LOG: requestLog,
            AGENT_REACH_RSS_PARSE_MARKER: parseMarker,
            PYTHONPATH: testDir,
          },
        },
      );

      await expect(readFile(requestLog, "utf8")).resolves.toBe(
        "https://8.8.8.8/feed.xml\nhttps://8.8.4.4/step.xml\nhttps://1.1.1.1/final.xml\n",
      );
      await expect(readFile(parseMarker, "utf8")).resolves.toBe("bytes");
      await expect(readFile(output, "utf8")).resolves.toContain(
        '"title": "validated RSS"',
      );
    } finally {
      await rm(testDir, { recursive: true, force: true });
    }
  });

  it("rejects private RSS destinations before opening initial or redirect URLs", async () => {
    const testDir = await mkdtemp(join(tmpdir(), "agent-reach-rss-private-"));
    try {
      const output = join(testDir, "rss.md");
      const requestLog = join(testDir, "requests.log");
      await installRssPythonFixtures(testDir, {
        "https://8.8.8.8/feed.xml": {
          status: 302,
          location: "http://127.0.0.1/private.xml",
        },
      });
      const env = {
        ...process.env,
        PYTHONPATH: testDir,
        AGENT_REACH_RSS_REQUEST_LOG: requestLog,
      };

      await expect(
        execFileAsync(
          "bash",
          ["-c", buildCommand("rss", "https://8.8.8.8/feed.xml", output)],
          { env },
        ),
      ).rejects.toThrow();
      await expect(readFile(requestLog, "utf8")).resolves.toBe(
        "https://8.8.8.8/feed.xml\n",
      );

      await expect(
        execFileAsync(
          "bash",
          ["-c", buildCommand("rss", "http://127.0.0.1/feed.xml", output)],
          { env },
        ),
      ).rejects.toThrow();
      await expect(readFile(requestLog, "utf8")).resolves.toBe(
        "https://8.8.8.8/feed.xml\n",
      );
    } finally {
      await rm(testDir, { recursive: true, force: true });
    }
  });

  it("guards yt-dlp secondary DNS lookups in the child process", async () => {
    const testDir = await mkdtemp(join(tmpdir(), "agent-reach-ytdlp-guard-"));
    try {
      const marker = join(testDir, "marker");
      const ytDlp = join(testDir, "yt-dlp");
      const output = join(testDir, "youtube.md");
      const command = buildCommand(
        "youtube",
        "https://www.youtube.com/watch?v=fixture",
        output,
      );

      for (const destination of [
        "http://localhost:9/private",
        "http://[2001:db8::1]/private",
      ]) {
        await writeFile(
          ytDlp,
          `#!/usr/bin/env python3\nimport os\nimport urllib.request\n\ntry:\n    urllib.request.urlopen("${destination}")\nexcept Exception as error:\n    with open(os.environ["AGENT_REACH_GUARD_MARKER"], "w") as output:\n        output.write(str(error))\n    raise\n`,
          "utf8",
        );
        await chmod(ytDlp, 0o755);

        await expect(
          execFileAsync("bash", ["-c", command], {
            env: {
              ...process.env,
              AGENT_REACH_GUARD_MARKER: marker,
              PATH: `${testDir}:${process.env.PATH ?? ""}`,
            },
          }),
        ).rejects.toBeDefined();
        await expect(readFile(marker, "utf8")).resolves.toContain(
          "non-public destination rejected",
        );
      }
    } finally {
      await rm(testDir, { recursive: true, force: true });
    }
  });
});
