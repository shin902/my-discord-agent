import path from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("node:fs/promises", () => ({
  readFile: vi.fn(),
}));

const { readFile } = await import("node:fs/promises");

const {
  loadRawBots,
  loadRawConfig,
  loadRawCredentials,
  loadRawCron,
  loadRawGroups,
  loadRawProviders,
} = await import("./config.js");

const canonicalPath = (fileName: string) =>
  path.join(process.cwd(), "config", fileName);
const canonicalLoaderCases = [
  [loadRawConfig, "config.json", {}],
  [loadRawGroups, "groups.json", []],
  [loadRawCredentials, "credentials.json", []],
  [loadRawProviders, "providers.json", []],
  [loadRawCron, "cron.json", []],
  [loadRawBots, "bots.json", {}],
] as const;

const rejectsWithMessage = (message: string) => (result: Promise<unknown>) =>
  expect(result).rejects.toThrow(message);
const resolvesTo = (value: unknown) => (result: Promise<unknown>) =>
  expect(result).resolves.toEqual(value);
const rejectsWithCode = (code: string) => (result: Promise<unknown>) =>
  expect(result).rejects.toMatchObject({ code });
const missingFile = Object.assign(new Error("ENOENT"), { code: "ENOENT" });

const missingFileCases = [
  [
    "groups",
    loadRawGroups,
    rejectsWithMessage("config/groups.json が見つかりません"),
  ],
  [
    "credentials",
    loadRawCredentials,
    rejectsWithMessage("config/credentials.json が見つかりません"),
  ],
  ["providers", loadRawProviders, resolvesTo([])],
  ["bots", loadRawBots, resolvesTo({})],
  ["cron", loadRawCron, rejectsWithCode("ENOENT")],
] as const;

beforeEach(() => {
  vi.clearAllMocks();
});

describe("config loaders", () => {
  it("read canonical config files", async () => {
    for (const [loader, fileName, expected] of canonicalLoaderCases) {
      vi.mocked(readFile).mockResolvedValueOnce(JSON.stringify(expected));
      await expect(loader()).resolves.toEqual(expected);
      expect(readFile).toHaveBeenLastCalledWith(
        canonicalPath(fileName),
        "utf-8",
      );
    }
    expect(readFile).toHaveBeenCalledTimes(canonicalLoaderCases.length);
  });

  it.each(
    missingFileCases,
  )("%s preserves missing-file behavior", async (_name, loader, assert) => {
    vi.mocked(readFile).mockRejectedValue(missingFile);
    await assert(loader());
  });
});
