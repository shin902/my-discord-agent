import { NonRetryableError } from "../utils/error.js";
import { MemoryCoreClient, MemoryCoreError } from "./memory-core.js";
import type { MemoryCaptureBackend, MemoryCaptureTurn } from "./types.js";

/** TencentDB conversation schema adapter over the shared MemoryCore transport. */
export class TencentDbBackend implements MemoryCaptureBackend {
  private readonly client: MemoryCoreClient;

  constructor(settings: unknown, signal?: AbortSignal) {
    try {
      this.client = new MemoryCoreClient(settings, signal);
    } catch (error) {
      if (error instanceof MemoryCoreError && !error.retryable) {
        throw new NonRetryableError(error.message);
      }
      throw error;
    }
  }

  async exportTurn(turn: MemoryCaptureTurn): Promise<void> {
    try {
      await this.client.request("/v3/conversation/add", {
        method: "POST",
        body: {
          session_id: turn.sessionId,
          team_id: this.client.settings.teamId,
          agent_id: this.client.settings.agentId,
          user_id: turn.source.actorId,
          messages: [
            { role: "user", ...turn.user },
            { role: "assistant", ...turn.assistant },
          ],
        },
      });
    } catch (error) {
      if (error instanceof MemoryCoreError && !error.retryable) {
        throw new NonRetryableError(error.message);
      }
      throw error;
    }
  }
}
