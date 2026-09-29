import { execFile, spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { lstat, rm } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import type { AgentToolResult } from "@earendil-works/pi-agent-core";
import { getRuntimeCapability } from "../tools/runtime-capabilities.js";
import {
  TOOL_RUNTIME_INPUT_MAX_BYTES,
  TOOL_RUNTIME_MAX_BYTES,
  type ToolRuntimeRequest,
  type ToolRuntimeResponse,
} from "./tool-runtime-protocol.js";

const execFileAsync = promisify(execFile);
const ROOT = fileURLToPath(new URL("../../", import.meta.url));
const STDERR_MAX_BYTES = 16 * 1024;
const active = new Set<{
  controller: AbortController;
  done: Promise<unknown>;
}>();

export interface ToolRuntimeOptions {
  /** Trusted host configuration; never taken from capability arguments. */
  root?: string;
  image?: string;
  workspace?: string;
}

export function toolRuntimeLabel(root = ROOT): string {
  return `my-discord-agent.tool-runtime=${createHash("sha256").update(resolve(root)).digest("hex").slice(0, 16)}`;
}

async function twitterMountArgs(root: string): Promise<string[]> {
  const state = resolve(root, "data/twitter-cookies.json");
  try {
    const stat = await lstat(state);
    if (
      !stat.isFile() ||
      stat.isSymbolicLink() ||
      stat.uid === 0 ||
      stat.gid === 0
    )
      throw new Error();
    return [
      "-e",
      `TOOL_RUNTIME_UID=${stat.uid}`,
      "-e",
      `TOOL_RUNTIME_GID=${stat.gid}`,
      "--mount",
      `type=bind,src=${state},dst=/var/lib/twitter/twitter-cookies.json,readonly`,
    ];
  } catch {
    throw new Error("X search state is unavailable or invalid");
  }
}

async function redditMountArgs(root: string): Promise<string[]> {
  const cookie = resolve(root, "data/reddit-cookies.json");
  try {
    const cookieStat = await lstat(cookie);
    if (
      !cookieStat.isFile() ||
      cookieStat.isSymbolicLink() ||
      cookieStat.uid === 0 ||
      cookieStat.gid === 0
    )
      throw new Error();
    return [
      "-e",
      `TOOL_RUNTIME_UID=${cookieStat.uid}`,
      "-e",
      `TOOL_RUNTIME_GID=${cookieStat.gid}`,
      "-e",
      "REDDIT_COOKIE_FILE=/var/lib/reddit/reddit-cookies.json",
      "-e",
      `REDDIT_COOKIE_MAX_AGE_DAYS=${process.env.REDDIT_COOKIE_MAX_AGE_DAYS ?? "7"}`,
      "--mount",
      `type=bind,src=${cookie},dst=/var/lib/reddit/reddit-cookies.json,readonly`,
    ];
  } catch {
    throw new Error(
      "Reddit state is unavailable or has invalid ownership; run reddit:login first",
    );
  }
}

export async function buildToolRuntimeArgs(
  request: ToolRuntimeRequest,
  name: string,
  options: ToolRuntimeOptions = {},
): Promise<string[]> {
  const root = options.root ?? ROOT;
  const capability = getRuntimeCapability(request.capability);
  if (!capability) throw new Error("Unknown Runtime capability");
  const workspace = options.workspace;
  if (capability?.tool === "git-clone" && !workspace)
    throw new Error("Git clone requires a trusted group workspace");
  let workspaceMount: string[] = [];
  if (workspace) {
    const stat = await lstat(workspace);
    if (
      !stat.isDirectory() ||
      stat.isSymbolicLink() ||
      stat.uid === 0 ||
      stat.gid === 0
    )
      throw new Error("Group workspace is unavailable or invalid");
    workspaceMount = [
      "-e",
      `TOOL_RUNTIME_UID=${stat.uid}`,
      "-e",
      `TOOL_RUNTIME_GID=${stat.gid}`,
      "--mount",
      `type=bind,src=${workspace},dst=/workspace`,
    ];
  }
  const mounts = capability.needsTwitterCredentials
    ? await twitterMountArgs(root)
    : capability.needsRedditCookies?.(request.args)
      ? await redditMountArgs(root)
      : [];
  if (workspaceMount.length && mounts.length) {
    const credentialUid = mounts.find((arg) =>
      arg.startsWith("TOOL_RUNTIME_UID="),
    );
    const credentialGid = mounts.find((arg) =>
      arg.startsWith("TOOL_RUNTIME_GID="),
    );
    if (
      credentialUid !== workspaceMount[1] ||
      credentialGid !== workspaceMount[3]
    )
      throw new Error("Group workspace and credential owner must match");
  }
  return [
    "run",
    "--rm",
    "--pull=never",
    "-i",
    "--name",
    name,
    "--label",
    toolRuntimeLabel(root),
    "--cap-drop=ALL",
    "--cap-add=NET_ADMIN",
    "--cap-add=SETUID",
    "--cap-add=SETGID",
    "--cap-add=SETPCAP",
    "--security-opt=no-new-privileges:true",
    "--dns=1.1.1.1",
    "--dns=8.8.8.8",
    "-e",
    "HOME=/tmp",
    "-e",
    "CHROMIUM_PATH=/usr/bin/chromium",
    ...mounts,
    ...workspaceMount,
    ...(capability?.tool === "git-clone"
      ? ["-e", `GIT_CLONE_STAGE=.git-clone-${name}`]
      : []),
    options.image ??
      process.env.TOOL_RUNTIME_IMAGE ??
      "my-discord-agent-tool-runtime:latest",
  ];
}

async function runContainer(
  request: ToolRuntimeRequest,
  signal: AbortSignal,
  options: ToolRuntimeOptions,
): Promise<AgentToolResult<unknown>> {
  const name = `my-discord-agent-tool-${randomUUID()}`;
  const stage =
    "capability" in request &&
    request.capability === "git-clone" &&
    options.workspace
      ? resolve(options.workspace, `.git-clone-${name}`)
      : undefined;
  const args = await buildToolRuntimeArgs(request, name, options);
  const input = JSON.stringify(request);
  if (Buffer.byteLength(input) > TOOL_RUNTIME_INPUT_MAX_BYTES)
    throw new Error("Tool Runtime request too large");
  signal.throwIfAborted();
  const child = spawn("docker", args, { stdio: ["pipe", "pipe", "pipe"] });
  let closed = false;
  let exited = false;
  let failure: Error | undefined;
  let cancellation: Promise<void> | undefined;
  const chunks: Buffer[] = [];
  let size = 0;
  const cancel = (reason: Error): void => {
    failure ??= reason;
    cancellation ??= (async () => {
      // An abort can arrive before docker run has created its container. Retry
      // this exact name until it exits; never kill by prefix or only kill the CLI.
      const deadline = Date.now() + 10_000;
      while (!closed) {
        try {
          await execFileAsync("docker", ["kill", name], { timeout: 5_000 });
        } catch {
          /* It may not have been created yet, or --rm already removed it. */
        }
        if (closed) return;
        if (Date.now() >= deadline) {
          failure = new Error(
            "Tool Runtime cancellation could not confirm container exit",
          );
          child.kill("SIGKILL");
          return;
        }
        await new Promise((resolve) => setTimeout(resolve, 50));
      }
    })();
  };
  const abort = () => cancel(new Error("Tool Runtime aborted"));
  signal.addEventListener("abort", abort, { once: true });
  if (signal.aborted) abort();
  child.stdout.on("data", (chunk: Buffer) => {
    size += chunk.length;
    if (size > TOOL_RUNTIME_MAX_BYTES)
      cancel(new Error("Tool Runtime result too large"));
    else chunks.push(chunk);
  });
  // Retain a bounded prefix while continuing to drain the pipe. Diagnostics
  // can contain host paths or private browser state: log only on the host.
  const stderr = Buffer.alloc(STDERR_MAX_BYTES);
  let stderrSize = 0;
  let stderrTruncated = false;
  child.stderr.on("data", (chunk: Buffer) => {
    const copied = chunk.copy(stderr, stderrSize);
    stderrSize += copied;
    stderrTruncated ||= copied < chunk.length;
  });
  child.stdin.on("error", () => {
    /* The close/error event supplies the outcome. */
  });
  const completion = new Promise<number | null>((resolve, reject) => {
    child.once("error", () =>
      reject(
        new Error(
          "Cannot start Tool Runtime; Docker and the prebuilt image are required",
        ),
      ),
    );
    child.once("close", (code) => {
      closed = true;
      exited = true;
      resolve(code);
    });
  });
  child.stdin.end(input);
  try {
    const code = await completion;
    await cancellation;
    if (failure) throw failure;
    if (code !== 0)
      throw new Error(
        "Tool Runtime failed to start or exited unexpectedly; check the prebuilt image and host configuration",
      );
    let response: ToolRuntimeResponse;
    try {
      response = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    } catch {
      throw new Error("Invalid Tool Runtime response");
    }
    if (!response || typeof response !== "object")
      throw new Error("Invalid Tool Runtime response");
    if ("error" in response)
      throw new Error(
        typeof response.error === "string"
          ? response.error
          : "Tool Runtime failed",
      );
    if (!response.result || !Array.isArray(response.result.content))
      throw new Error("Invalid Tool Runtime result");
    return response.result;
  } catch (error) {
    if (stderrSize > 0)
      console.error(
        `[tool-runtime] ${name} stderr${stderrTruncated ? " (truncated at 16 KiB)" : ""}:`,
        stderr.toString("utf8", 0, stderrSize),
      );
    throw error;
  } finally {
    closed = true;
    signal.removeEventListener("abort", abort);
    await cancellation;
    // Only remove the private staging directory after the container has exited.
    if (stage && exited) await rm(stage, { recursive: true, force: true });
  }
}

async function execute(
  request: ToolRuntimeRequest,
  signal: AbortSignal | undefined,
  options: ToolRuntimeOptions,
): Promise<AgentToolResult<unknown>> {
  const controller = new AbortController();
  const entry = {
    controller,
    done: runContainer(
      request,
      AbortSignal.any([controller.signal, ...(signal ? [signal] : [])]),
      options,
    ),
  };
  active.add(entry);
  try {
    return await entry.done;
  } finally {
    active.delete(entry);
  }
}

export async function executeToolRuntime(
  capability: string,
  args: unknown,
  signal?: AbortSignal,
  options: ToolRuntimeOptions = {},
): Promise<AgentToolResult<unknown>> {
  const definition = getRuntimeCapability(capability);
  if (!definition) throw new Error("Unknown Runtime capability");
  return execute({ capability, args }, signal, options);
}

export async function stopToolRuntimes(): Promise<void> {
  const entries = [...active];
  for (const entry of entries) entry.controller.abort();
  await Promise.allSettled(entries.map((entry) => entry.done));
}

export async function cleanupToolRuntimes(
  options: ToolRuntimeOptions = {},
): Promise<void> {
  const { stdout } = await execFileAsync(
    "docker",
    ["ps", "-aq", "--filter", `label=${toolRuntimeLabel(options.root)}`],
    { timeout: 10_000 },
  );
  const ids = stdout.trim().split(/\s+/).filter(Boolean);
  if (ids.length)
    await execFileAsync("docker", ["rm", "-f", ...ids], { timeout: 30_000 });
}
