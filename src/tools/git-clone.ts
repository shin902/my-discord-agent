import { execFile } from "node:child_process";
import { lstat, realpath } from "node:fs/promises";
import { isIP } from "node:net";
import { isAbsolute, relative, resolve } from "node:path";
import { promisify } from "node:util";
import type { AgentTool } from "@earendil-works/pi-agent-core";
import { Type } from "typebox";
import { isPublicIpAddress } from "./agent-reach.js";

const execFileAsync = promisify(execFile);
const WORKSPACE = "/workspace";

export async function cloneGitRepository(
  url: string,
  destination: string,
  run: typeof execFileAsync = execFileAsync,
): Promise<string> {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new Error("Invalid public HTTPS Git URL");
  }
  if (
    !url.startsWith("https://") ||
    parsed.protocol !== "https:" ||
    !parsed.hostname ||
    parsed.hostname.toLowerCase() === "localhost" ||
    parsed.hostname.toLowerCase().endsWith(".localhost") ||
    (isIP(parsed.hostname.replace(/^\[|\]$/g, "")) !== 0 &&
      !isPublicIpAddress(parsed.hostname.replace(/^\[|\]$/g, ""))) ||
    parsed.username ||
    parsed.password ||
    parsed.port ||
    !parsed.pathname ||
    parsed.pathname === "/" ||
    parsed.search ||
    parsed.hash ||
    /\s/.test(url) ||
    [...url].some((character) => character.charCodeAt(0) < 32)
  )
    throw new Error("Invalid public HTTPS Git URL");
  if (
    !destination ||
    isAbsolute(destination) ||
    destination
      .split(/[\\/]/)
      .some((part) => !part || part === "." || part === "..")
  )
    throw new Error("Invalid workspace-relative destination");
  const target = resolve(WORKSPACE, destination);
  if (
    !relative(WORKSPACE, target) ||
    relative(WORKSPACE, target).startsWith("..")
  )
    throw new Error("Destination must be inside workspace");
  const parent = resolve(target, "..");
  const actualParent = await realpath(parent);
  if (actualParent !== WORKSPACE && !actualParent.startsWith(`${WORKSPACE}/`))
    throw new Error("Destination must be inside workspace");
  try {
    await lstat(target);
    throw new Error("Destination already exists");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  await run("git", ["clone", "--", url, target], {
    cwd: WORKSPACE,
    timeout: 120_000,
    maxBuffer: 1024 * 1024,
    env: {
      PATH: process.env.PATH,
      HOME: "/tmp",
      GIT_CONFIG_NOSYSTEM: "1",
      GIT_CONFIG_GLOBAL: "/dev/null",
      GIT_TERMINAL_PROMPT: "0",
      GIT_ASKPASS: "/bin/false",
      GIT_CONFIG_COUNT: "1",
      GIT_CONFIG_KEY_0: "credential.helper",
      GIT_CONFIG_VALUE_0: "",
    },
  });
  return destination;
}

export const gitCloneTool: AgentTool = {
  name: "git-clone",
  label: "Git Clone",
  description:
    "Clone a public HTTPS Git repository into the current group workspace.",
  parameters: Type.Object({
    url: Type.String({ description: "Public HTTPS Git repository URL" }),
    destination: Type.String({
      description: "Workspace-relative destination (must not exist)",
    }),
  }),
  execute: async (_id, args) => {
    const { url, destination } = args as { url: string; destination: string };
    const path = await cloneGitRepository(url, destination);
    return {
      content: [{ type: "text", text: `Cloned into ${path}` }],
      details: {},
    };
  },
};
