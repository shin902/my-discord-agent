import { z } from "zod";
import { NonRetryableError } from "../utils/error.js";
import type { MemoryCaptureBackend, MemoryCaptureTurn } from "./types.js";

const BaseUrlSchema = z.string().refine((value) => {
  try {
    const url = new URL(value);
    return (
      !url.username &&
      !url.password &&
      !url.search &&
      !url.hash &&
      (url.protocol === "https:" ||
        (url.protocol === "http:" &&
          (url.hostname === "127.0.0.1" || url.hostname === "[::1]")))
    );
  } catch {
    return false;
  }
}, "must be HTTPS or literal loopback HTTP without credentials/query/fragment");

const SettingsSchema = z.object({
  baseUrl: BaseUrlSchema.default("http://127.0.0.1:8420"),
  serviceId: z.string().min(1).default("default"),
  teamId: z.string().min(1).default("default"),
  agentId: z.string().min(1).default("my-discord-agent"),
  bearerTokenEnv: z
    .string()
    .regex(/^[A-Za-z_][A-Za-z0-9_]*$/)
    .optional(),
  timeoutMs: z.number().int().positive().max(120_000).default(10_000),
});

function transient(code: number): boolean {
  return code === 408 || code === 429 || code >= 500;
}

/** All TencentDB wire schema, credentials and error interpretation stay here. */
export class TencentDbBackend implements MemoryCaptureBackend {
  private readonly settings: z.infer<typeof SettingsSchema>;
  private readonly token?: string;

  constructor(
    settings: unknown,
    private readonly signal?: AbortSignal,
  ) {
    const parsed = SettingsSchema.safeParse(settings);
    if (!parsed.success)
      throw new NonRetryableError("Invalid TencentDB export settings");
    this.settings = parsed.data;
    this.token = this.settings.bearerTokenEnv
      ? process.env[this.settings.bearerTokenEnv]
      : undefined;
    if (this.settings.bearerTokenEnv && !this.token) {
      throw new NonRetryableError(`${this.settings.bearerTokenEnv} is not set`);
    }
  }

  async exportTurn(turn: MemoryCaptureTurn): Promise<void> {
    const endpoint = new URL(this.settings.baseUrl);
    endpoint.pathname = `${endpoint.pathname.replace(/\/$/u, "")}/v3/conversation/add`;
    const headers: Record<string, string> = {
      "content-type": "application/json",
      "x-tdai-service-id": this.settings.serviceId,
    };
    if (this.token) headers.authorization = `Bearer ${this.token}`;
    try {
      new Headers(headers);
    } catch {
      throw new NonRetryableError("Invalid TencentDB header configuration");
    }
    const timeout = AbortSignal.timeout(this.settings.timeoutMs);
    let response: Response;
    try {
      response = await fetch(endpoint.toString(), {
        method: "POST",
        redirect: "error",
        headers,
        body: JSON.stringify({
          session_id: turn.sessionId,
          team_id: this.settings.teamId,
          agent_id: this.settings.agentId,
          user_id: turn.source.actorId,
          messages: [
            { role: "user", ...turn.user },
            { role: "assistant", ...turn.assistant },
          ],
        }),
        signal: this.signal ? AbortSignal.any([this.signal, timeout]) : timeout,
      });
    } catch (error) {
      const cause = error instanceof Error ? error.cause : undefined;
      if (cause instanceof Error && cause.message === "unexpected redirect") {
        throw new NonRetryableError("TencentDB rejected a redirect");
      }
      // Do not persist transport details which may contain credentials/URLs.
      throw new Error("TencentDB transport failed or timed out");
    }
    let body: unknown;
    try {
      body = await response.json();
    } catch (error) {
      if (!(error instanceof SyntaxError))
        throw new Error("TencentDB response transport failed or timed out");
      // A malformed envelope is a permanent protocol error (unless HTTP says retry).
      body = null;
    }
    const code =
      body && typeof body === "object" && "code" in body
        ? body.code
        : undefined;
    const validCode =
      typeof code === "number" &&
      Number.isSafeInteger(code) &&
      code >= 0 &&
      code <= 999_999
        ? code
        : undefined;
    if (response.ok && validCode === 0) return;
    const message = `TencentDB conversation/add failed (${response.status}, code ${validCode ?? "unknown"})`;
    // HTTP transport failure takes precedence over an inconsistent envelope.
    if (
      (!response.ok && transient(response.status)) ||
      (response.ok && validCode !== undefined && transient(validCode))
    ) {
      throw new Error(message);
    }
    throw new NonRetryableError(message);
  }
}
