import type { SessionSource } from "../agent/source.js";

export interface MemoryCaptureTurn {
  groupName: string;
  sessionId: string;
  source: SessionSource;
  user: { content: string; timestamp: string };
  assistant: { content: string; timestamp: string };
}

export interface MemoryCaptureBackend {
  exportTurn(turn: MemoryCaptureTurn): Promise<void>;
}
