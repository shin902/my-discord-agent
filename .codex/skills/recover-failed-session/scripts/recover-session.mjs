#!/usr/bin/env node

import {
  appendFile,
  copyFile,
  mkdir,
  readFile,
  readdir,
  stat,
  writeFile,
} from "node:fs/promises";
import path from "node:path";
import process from "node:process";

const decoder = new TextDecoder("utf-8", { fatal: true });
const replacementDecoder = new TextDecoder("utf-8");

function usage(message) {
  if (message) console.error(`Error: ${message}\n`);
  console.error(`Usage:
  recover-session.mjs --repo PATH [--session PATH] [--failure-line N]
                      [--channel-id ID] [--prompt TEXT] [--limit N] [--apply]

Dry-run is the default. --apply backs up and edits the session, then appends
one recovery record to data/queue/inbox.jsonl.`);
  process.exit(message ? 2 : 0);
}

function parseArgs(argv) {
  const args = { repo: process.cwd(), limit: 200, apply: false };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--apply") {
      args.apply = true;
    } else if (arg === "--help" || arg === "-h") {
      usage();
    } else if (
      [
        "--repo",
        "--session",
        "--failure-line",
        "--channel-id",
        "--prompt",
        "--limit",
      ].includes(arg)
    ) {
      const value = argv[index + 1];
      if (value === undefined) usage(`${arg} requires a value`);
      index += 1;
      const key = arg.slice(2).replace(/-([a-z])/g, (_, c) => c.toUpperCase());
      args[key] = value;
    } else {
      usage(`unknown argument: ${arg}`);
    }
  }
  args.limit = Number.parseInt(String(args.limit), 10);
  if (!Number.isInteger(args.limit) || args.limit < 1) usage("--limit must be positive");
  if (args.failureLine !== undefined) {
    args.failureLine = Number.parseInt(String(args.failureLine), 10);
    if (!Number.isInteger(args.failureLine) || args.failureLine < 1) {
      usage("--failure-line must be positive");
    }
  }
  return args;
}

async function collectJsonl(root) {
  const files = [];
  async function walk(directory) {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const target = path.join(directory, entry.name);
      if (entry.isDirectory()) await walk(target);
      else if (entry.isFile() && entry.name.endsWith(".jsonl")) files.push(target);
    }
  }
  await walk(root);
  const withStats = await Promise.all(
    files.map(async (file) => ({ file, info: await stat(file) })),
  );
  return withStats.sort((a, b) => b.info.mtimeMs - a.info.mtimeMs);
}

function decodeLine(buffer) {
  try {
    return { text: decoder.decode(buffer), validUtf8: true };
  } catch {
    return { text: replacementDecoder.decode(buffer), validUtf8: false };
  }
}

function messageText(message) {
  const content = message?.content;
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .filter((item) => item && item.type === "text" && typeof item.text === "string")
    .map((item) => item.text)
    .join("\n");
}

function toolCallIds(message) {
  if (message?.role !== "assistant" || !Array.isArray(message.content)) return [];
  return message.content
    .filter((item) => item?.type === "toolCall" && typeof item.id === "string")
    .map((item) => item.id);
}

function classify(message, validUtf8, parsed) {
  if (!validUtf8 || !parsed) return "invalid-utf8";
  const text = `${messageText(message)} ${message?.errorMessage ?? ""}`;
  if (
    /context.{0,50}(exceed|length|window|limit)|maximum context|too many tokens|prompt.{0,20}too long/i.test(
      text,
    )
  ) {
    return "context";
  }
  if (message?.role === "toolResult" && message?.isError === true) return "tool";
  if (/tool.{0,30}(call|use).{0,50}(fail|invalid|parse|error)/i.test(text)) {
    return "tool";
  }
  if (
    /peg-native|expected.{0,20}format|does not match.{0,30}format|invalid.{0,20}(utf|unicode|encoding)|unparsed/i.test(
      text,
    )
  ) {
    return "format";
  }
  if (message?.role === "assistant" && message?.stopReason === "error") {
    return "generic";
  }
  return undefined;
}

function hasLaterSuccessfulAssistant(lines, index) {
  return lines.slice(index + 1).some(
    (line) =>
      line.parsed &&
      line.message?.role === "assistant" &&
      line.message?.stopReason !== "error",
  );
}

async function analyzeSession(file) {
  const buffer = await readFile(file);
  const rawLines = [];
  let start = 0;
  for (let index = 0; index <= buffer.length; index += 1) {
    if (index !== buffer.length && buffer[index] !== 0x0a) continue;
    const raw = buffer.subarray(start, index);
    start = index + 1;
    if (raw.length === 0 && index === buffer.length) continue;
    const decoded = decodeLine(raw);
    let message;
    let parsed = false;
    if (decoded.validUtf8 && decoded.text.trim()) {
      try {
        message = JSON.parse(decoded.text);
        parsed = true;
      } catch {
        parsed = false;
      }
    }
    rawLines.push({
      raw,
      text: decoded.text,
      validUtf8: decoded.validUtf8,
      parsed,
      message,
    });
  }

  const failures = [];
  for (let index = 0; index < rawLines.length; index += 1) {
    const line = rawLines[index];
    const type = classify(line.message, line.validUtf8, line.parsed);
    if (!type) continue;
    const structurallyCorrupt = type === "invalid-utf8";
    if (!structurallyCorrupt && hasLaterSuccessfulAssistant(rawLines, index)) continue;

    let from = index;
    let to = index;
    if (type === "tool" && line.message?.role === "toolResult") {
      const callId = line.message.toolCallId;
      const previous = rawLines[index - 1];
      if (previous?.parsed && toolCallIds(previous.message).includes(callId)) from = index - 1;
    } else if (type === "invalid-utf8") {
      const previous = rawLines[index - 1];
      if (previous?.parsed && toolCallIds(previous.message).length > 0) from = index - 1;
    }

    failures.push({ type, line: index, from, to });
  }
  return { file, buffer, rawLines, failures, info: await stat(file) };
}

function snippet(line) {
  const value = line?.parsed
    ? `${line.message?.role ?? "unknown"} ${line.message?.errorMessage ?? messageText(line.message)}`
    : line?.text ?? "";
  return value.replace(/\s+/g, " ").slice(0, 180);
}

async function resolveSession(args, sessionsRoot) {
  if (args.session) {
    const candidate = path.resolve(args.repo, args.session);
    const relative = path.relative(sessionsRoot, candidate);
    if (relative.startsWith("..") || path.isAbsolute(relative)) {
      throw new Error("--session must be inside data/sessions");
    }
    return analyzeSession(candidate);
  }

  const files = (await collectJsonl(sessionsRoot)).slice(0, args.limit);
  for (const entry of files) {
    const analysis = await analyzeSession(entry.file);
    if (analysis.failures.length > 0) return analysis;
  }
  throw new Error(`no unresolved failure found in the newest ${files.length} sessions`);
}

function selectFailure(analysis, requestedLine) {
  if (analysis.failures.length === 0) {
    throw new Error("the selected session has no unresolved failure");
  }
  if (requestedLine !== undefined) {
    const match = analysis.failures.find((failure) => failure.line + 1 === requestedLine);
    if (!match) throw new Error(`no unresolved failure at line ${requestedLine}`);
    return match;
  }
  return analysis.failures.at(-1);
}

async function readJsonLines(file) {
  try {
    const text = await readFile(file, "utf8");
    return text
      .split("\n")
      .filter((line) => line.trim())
      .flatMap((line) => {
        try {
          return [JSON.parse(line)];
        } catch {
          return [];
        }
      });
  } catch (error) {
    if (error?.code === "ENOENT") return [];
    throw error;
  }
}

async function resolveDestination(repo, groupName, sessionId, channelOverride) {
  const queueDir = path.join(repo, "data", "queue");
  for (const name of ["inbox.jsonl", "dead-letter.jsonl"]) {
    const records = await readJsonLines(path.join(queueDir, name));
    const match = records.find((record) => record.sessionId === sessionId);
    if (match) {
      const { id, retries, enqueuedAt, content, timestamp, ...metadata } = match;
      return {
        channelId: channelOverride ?? metadata.channelId,
        metadata,
        source: `data/queue/${name}`,
      };
    }
  }

  if (/^\d+$/.test(sessionId)) {
    return {
      channelId: channelOverride ?? sessionId,
      metadata: { groupName, sessionId },
      source: "numeric session id",
    };
  }

  const cronFile = path.join(repo, "config", "cron.json");
  const jobs = await readJsonLines(cronFile).then((records) =>
    records.length > 0 ? records : readFile(cronFile, "utf8").then(JSON.parse),
  );
  const jobList = Array.isArray(jobs) ? jobs : [];
  const matches = jobList
    .filter((job) => sessionId === `cron-${job.id}` || sessionId.startsWith(`cron-${job.id}-`))
    .sort((a, b) => b.id.length - a.id.length);
  const job = matches[0];
  if (job) {
    const configOverride = {};
    if (job.model !== undefined) configOverride.model = job.model;
    if (job.tools !== undefined) configOverride.tools = job.tools;
    if (job.skills !== undefined) configOverride.skills = job.skills;
    return {
      channelId: channelOverride ?? job.channelId,
      metadata: {
        groupName: job.groupName ?? groupName,
        sessionId,
        cronDeliveryMode: job.deliveryMode,
        cronSessionMode: job.sessionMode,
        cronJobId: job.id,
        ...(Object.keys(configOverride).length > 0 ? { configOverride } : {}),
      },
      source: "config/cron.json",
    };
  }

  if (channelOverride) {
    return {
      channelId: channelOverride,
      metadata: { groupName, sessionId },
      source: "--channel-id",
    };
  }
  throw new Error("could not resolve channelId; pass --channel-id after verifying destination");
}

function recoveryPrompt(type, customPrompt, options = {}) {
  if (customPrompt) return customPrompt;
  const prompts = {
    format: options.hasSuccessfulToolResult
      ? "直前の応答は出力形式の解析エラーで失敗しました。直前までの成功済みツール結果を再利用し、ツールを再実行せず、要求された最終回答だけを正しい形式で簡潔に再生成してください。"
      : "直前の応答は出力形式の解析エラーで失敗しました。直前の依頼を引き継ぎ、要求された最終回答だけを正しい形式で簡潔に再生成してください。",
    "invalid-utf8":
      "直前の応答は不正なUTF-8バイト列で中断されました。直前の依頼を引き継ぎ、不正文字を含めず、要求された回答を最初から簡潔に再生成してください。",
    tool:
      "直前のツール呼び出しは失敗したため履歴から除去されました。直前の依頼を引き継ぎ、エラー原因を踏まえて必要なツール呼び出しを一度だけ再試行し、その結果を回答してください。",
    context:
      "直前の処理はコンテキスト上限を超えて失敗しました。既存の履歴だけを使い、大きな資料やツール結果を再取得せず、直前の依頼への回答を必要最小限にまとめてください。",
    generic:
      "直前の応答生成はエラーで失敗しました。直前の依頼を引き継ぎ、同じ作業を重複させず、回答を一度だけ再生成してください。",
  };
  return prompts[type];
}

function validateRepaired(lines) {
  const knownCalls = new Set();
  for (let index = 0; index < lines.length; index += 1) {
    const decoded = decodeLine(lines[index]);
    if (!decoded.validUtf8) throw new Error(`repair leaves invalid UTF-8 at line ${index + 1}`);
    let message;
    try {
      message = JSON.parse(decoded.text);
    } catch {
      throw new Error(`repair leaves invalid JSON at line ${index + 1}`);
    }
    for (const id of toolCallIds(message)) knownCalls.add(id);
    if (
      message?.role === "toolResult" &&
      typeof message.toolCallId === "string" &&
      !knownCalls.has(message.toolCallId)
    ) {
      throw new Error(`repair leaves orphan toolResult at line ${index + 1}`);
    }
  }
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const repo = path.resolve(args.repo);
  args.repo = repo;
  const sessionsRoot = path.join(repo, "data", "sessions");
  const analysis = await resolveSession(args, sessionsRoot);
  const failure = selectFailure(analysis, args.failureLine);
  const relative = path.relative(repo, analysis.file);
  const groupName = path.basename(path.dirname(analysis.file));
  const sessionId = path.basename(analysis.file, ".jsonl");
  const destination = await resolveDestination(
    repo,
    groupName,
    sessionId,
    args.channelId,
  );
  if (!destination.channelId) throw new Error("resolved destination has no channelId");
  const previousMessage = analysis.rawLines[failure.from - 1]?.message;
  const prompt = recoveryPrompt(failure.type, args.prompt, {
    hasSuccessfulToolResult:
      previousMessage?.role === "toolResult" && previousMessage?.isError !== true,
  });

  console.log(`Session: ${relative}`);
  console.log(`Failure: ${failure.type} at line ${failure.line + 1}`);
  console.log(`Remove: lines ${failure.from + 1}-${failure.to + 1}`);
  console.log(`Before: ${snippet(analysis.rawLines[failure.from - 1]) || "(none)"}`);
  console.log(`Target: ${snippet(analysis.rawLines[failure.line])}`);
  console.log(`After: ${snippet(analysis.rawLines[failure.to + 1]) || "(none)"}`);
  console.log(`Destination: ${destination.channelId} (${destination.source})`);
  console.log(`Prompt: ${prompt}`);

  if (!args.apply) {
    console.log("Dry-run only; pass --apply to back up, repair, and enqueue.");
    return;
  }

  const currentInfo = await stat(analysis.file);
  if (
    currentInfo.size !== analysis.info.size ||
    currentInfo.mtimeMs !== analysis.info.mtimeMs
  ) {
    throw new Error("session changed during analysis; rerun the command");
  }

  const remaining = analysis.rawLines
    .filter((_, index) => index < failure.from || index > failure.to)
    .map((line) => line.raw);
  validateRepaired(remaining);

  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const backup = path.join(
    repo,
    "data",
    "session-recovery-backups",
    stamp,
    groupName,
    `${sessionId}.jsonl`,
  );
  await mkdir(path.dirname(backup), { recursive: true });
  await copyFile(analysis.file, backup);
  await writeFile(
    analysis.file,
    Buffer.concat(remaining.flatMap((line) => [line, Buffer.from("\n")])),
  );

  const inboxPath = path.join(repo, "data", "queue", "inbox.jsonl");
  const existing = await readJsonLines(inboxPath);
  if (existing.some((record) => record.sessionId === sessionId)) {
    await copyFile(backup, analysis.file);
    throw new Error("session is already queued; restored backup and refused duplicate");
  }

  const now = new Date();
  const queueRecord = {
    id: `msg-${now.getTime()}-${Math.random().toString(36).slice(2, 8)}`,
    retries: 0,
    channelId: String(destination.channelId),
    ...destination.metadata,
    groupName: destination.metadata.groupName ?? groupName,
    sessionId,
    content: prompt,
    timestamp: now.toISOString(),
    enqueuedAt: now.toISOString(),
  };
  await mkdir(path.dirname(inboxPath), { recursive: true });
  await appendFile(inboxPath, `${JSON.stringify(queueRecord)}\n`, "utf8");
  const queued = await readJsonLines(inboxPath);
  if (!queued.some((record) => record.id === queueRecord.id)) {
    throw new Error(`queue append could not be verified; backup is at ${backup}`);
  }

  console.log(`Backup: ${path.relative(repo, backup)}`);
  console.log(`Queued: ${queueRecord.id}`);
}

main().catch((error) => {
  console.error(`Recovery failed: ${error instanceof Error ? error.message : error}`);
  process.exitCode = 1;
});
