import { existsSync } from "node:fs";
import { appendFile, chmod, mkdir, readFile } from "node:fs/promises";
import path from "node:path";
import type { AgentMessage } from "@earendil-works/pi-agent-core";

export interface SessionFileSystem {
  exists(path: string): boolean;
  read(path: string): Promise<string>;
  append(path: string, data: string): Promise<void>;
  makeDirectory(path: string): Promise<void>;
  setMode(path: string, mode: number): Promise<void>;
}
const nativeFileSystem: SessionFileSystem = {
  exists: existsSync,
  read: (file) => readFile(file, "utf-8"),
  append: (file, data) => appendFile(file, data, { encoding: "utf-8", mode: 0o666 }),
  makeDirectory: (dir) => mkdir(dir, { recursive: true, mode: 0o777 }).then(() => undefined),
  setMode: (file, mode) => chmod(file, mode),
};

const defaultDirectory = process.env.SESSIONS_DIR || path.join(process.cwd(), "data", "sessions");

function validateName(name: string, label: string): void {
  if (!/^[a-zA-Z0-9_-]+$/.test(name)) throw new Error(`不正な${label}: ${name}`);
}
function createSessionService(directory: string, fs: SessionFileSystem) {
  const filePath = (group: string, session: string) => path.join(directory, group, `${session}.jsonl`);
  const ensureDir = async (group: string) => {
    const dir = path.join(directory, group);
    await fs.makeDirectory(dir);
    await fs.setMode(dir, 0o777).catch(() => {});
  };
  const load = async (groupName: string, sessionId: string): Promise<AgentMessage[]> => {
    validateName(groupName, "グループ名");
    validateName(sessionId, "セッションID");
    const file = filePath(groupName, sessionId);
    if (!fs.exists(file)) return [];
    const text = await fs.read(file);
    return text.split("\n").filter((line) => line.trim()).map((line) => {
      const msg: AgentMessage = JSON.parse(line);
      if ("reasoning" in msg) delete msg.reasoning;
      if ("reasoning_content" in msg) delete msg.reasoning_content;
      if (msg.role === "assistant" && Array.isArray(msg.content)) msg.content = msg.content.filter((block) => block.type !== "thinking");
      return msg;
    });
  };
  const append = async (groupName: string, sessionId: string, message: AgentMessage): Promise<void> => {
    validateName(groupName, "グループ名");
    validateName(sessionId, "セッションID");
    await ensureDir(groupName);
    const file = filePath(groupName, sessionId);
    await fs.setMode(file, 0o666).catch(() => {});
    const rest = { ...message };
    if ("reasoning" in rest) delete rest.reasoning;
    const sanitized = rest.role === "assistant"
      ? { ...rest, content: rest.content.filter((block) => block.type !== "thinking") }
      : rest;
    await fs.append(file, `${JSON.stringify(sanitized)}\n`);
  };
  return { load, append };
}

const defaultService = createSessionService(defaultDirectory, nativeFileSystem);
export function createSessionStore(directory: string, fs: SessionFileSystem): typeof defaultService {
  return createSessionService(directory, fs);
}
export const loadMessages = defaultService.load;
export const appendMessage = defaultService.append;
