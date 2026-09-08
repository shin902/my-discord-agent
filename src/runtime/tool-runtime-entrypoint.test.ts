import { execFile } from "node:child_process";
import {
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";

const execFileAsync = promisify(execFile);
const temporaryDirectories: string[] = [];
const entrypoint = join(process.cwd(), "scripts/tool-runtime-entrypoint.sh");

async function writeExecutable(path: string, contents: string): Promise<void> {
  await writeFile(path, contents, { mode: 0o700 });
  await chmod(path, 0o700);
}

async function setup(): Promise<{
  directory: string;
  profile: string;
  cookieFile: string;
  capture: string;
  path: string;
}> {
  const directory = await mkdtemp(join(tmpdir(), "tool-runtime-entrypoint-"));
  temporaryDirectories.push(directory);
  const profile = join(directory, "profile");
  const cookieFile = join(directory, "reddit-cookies.json");
  const capture = join(directory, "setpriv.args");
  const bin = join(directory, "bin");
  await mkdir(profile);
  await writeFile(cookieFile, "{}", { mode: 0o600 });
  await mkdir(bin);
  for (const command of ["iptables", "ip6tables"]) {
    await writeExecutable(join(bin, command), "#!/bin/sh\nexit 0\n");
  }
  await writeExecutable(
    join(bin, "setpriv"),
    '#!/bin/sh\nprintf "%s\\n" "$@" > "$TOOL_RUNTIME_SETPRIV_CAPTURE"\n',
  );
  return {
    directory,
    profile,
    cookieFile,
    capture,
    path: `${bin}${delimiter}${process.env.PATH ?? ""}`,
  };
}

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

describe("tool runtime entrypoint identity", () => {
  it("uses the host-supplied identity and drops all capabilities", async () => {
    const fixture = await setup();
    const { uid, gid } = process.getuid
      ? { uid: process.getuid(), gid: process.getgid?.() ?? process.getuid() }
      : { uid: 1000, gid: 1000 };

    await execFileAsync("sh", [entrypoint, "node", "runtime.mjs"], {
      env: {
        ...process.env,
        PATH: fixture.path,
        TOOL_RUNTIME_UID: String(uid),
        TOOL_RUNTIME_GID: String(gid),
        TOOL_RUNTIME_SETPRIV_CAPTURE: fixture.capture,
      },
    });

    const args = (await readFile(fixture.capture, "utf8")).trim().split("\n");
    expect(args).toEqual(
      expect.arrayContaining([
        "--reuid",
        String(uid),
        "--regid",
        String(gid),
        "--clear-groups",
        "--bounding-set=-all",
        "--inh-caps=-all",
        "--ambient-caps=-all",
        "--",
        "node",
        "runtime.mjs",
      ]),
    );
  });

  it("starts without Reddit state using the unprivileged default identity", async () => {
    const fixture = await setup();
    await execFileAsync("sh", [entrypoint, "node", "runtime.mjs"], {
      env: {
        ...process.env,
        PATH: fixture.path,
        TOOL_RUNTIME_SETPRIV_CAPTURE: fixture.capture,
        TOOL_RUNTIME_UID: undefined,
        TOOL_RUNTIME_GID: undefined,
        REDDIT_PROFILE_DIR: undefined,
        REDDIT_COOKIE_FILE: undefined,
      },
    });
    expect((await readFile(fixture.capture, "utf8")).split("\n")).toEqual(
      expect.arrayContaining([
        "--reuid",
        "1000",
        "--regid",
        "--bounding-set=-all",
      ]),
    );
  });

  it.each([
    "0",
    "-1",
    "1000:1000",
    "oops",
  ])("rejects invalid identity %s before starting Node", async (uid) => {
    const fixture = await setup();
    await expect(
      execFileAsync("sh", [entrypoint, "node", "runtime.mjs"], {
        env: {
          ...process.env,
          PATH: fixture.path,
          TOOL_RUNTIME_SETPRIV_CAPTURE: fixture.capture,
          TOOL_RUNTIME_UID: uid,
          TOOL_RUNTIME_GID: "1000",
        },
      }),
    ).rejects.toMatchObject({ stderr: expect.stringContaining("UID/GID") });
  });
});
