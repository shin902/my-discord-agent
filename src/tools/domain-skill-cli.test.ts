import { spawnSync } from "node:child_process";
import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

const temporaryDirectories: string[] = [];

async function fakeToolProxy(): Promise<{ directory: string; log: string }> {
  const directory = await mkdtemp(join(tmpdir(), "domain-skill-cli-"));
  temporaryDirectories.push(directory);
  const log = join(directory, "arguments");
  const executable = join(directory, "tool-proxy");
  await writeFile(
    executable,
    `#!/bin/sh\nprintf '%s\\n' "$1" "$2" > "${log}"\n`,
  );
  await chmod(executable, 0o755);
  return { directory, log };
}

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

describe("domain Skill CLI", () => {
  it.each([
    ["web", "tavily-search"],
    ["github", "read-issue"],
    ["mail", "read-email"],
    ["calendar", "create-event"],
    ["weather", "get-current-weather"],
  ])("%s passes capability and JSON to tool-proxy without transformation", async (skill, capability) => {
    const { directory, log } = await fakeToolProxy();
    const json = '{"value":"two  spaces","optional":null}';
    const result = spawnSync(
      "sh",
      [
        resolve(`templates/SKILLS/${skill}/scripts/${skill}.sh`),
        capability,
        json,
      ],
      { env: { ...process.env, PATH: `${directory}:${process.env.PATH}` } },
    );

    expect(result.status).toBe(0);
    expect(await readFile(log, "utf8")).toBe(`${capability}\n${json}\n`);
  });
});
