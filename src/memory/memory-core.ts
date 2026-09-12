import { z } from "zod";

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

const ConnectionSettingsSchema = z.object({
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

export type MemoryCoreConnectionSettings = z.infer<
  typeof ConnectionSettingsSchema
>;

export class MemoryCoreError extends Error {
  constructor(
    message: string,
    readonly retryable: boolean,
  ) {
    super(message);
    this.name = "MemoryCoreError";
  }
}

export function parseMemoryCoreConnectionSettings(
  settings: unknown,
): MemoryCoreConnectionSettings {
  const parsed = ConnectionSettingsSchema.safeParse(settings);
  if (!parsed.success)
    throw new MemoryCoreError("Invalid MemoryCore connection settings", false);
  return parsed.data;
}

type RequestOptions = {
  method?: "GET" | "POST";
  body?: object;
  requireData?: boolean;
};

type Envelope = { code?: unknown; data?: unknown };

function transient(code: number): boolean {
  return code === 408 || code === 429 || code >= 500;
}

function validCode(code: unknown): number | undefined {
  return typeof code === "number" &&
    Number.isSafeInteger(code) &&
    code >= 0 &&
    code <= 999_999
    ? code
    : undefined;
}

/** Shared URL, credentials, timeout, redirect and sanitized error boundary. */
export class MemoryCoreClient {
  readonly settings: MemoryCoreConnectionSettings;
  private readonly headers: Record<string, string>;

  constructor(
    settings: unknown,
    private readonly signal?: AbortSignal,
  ) {
    this.settings = parseMemoryCoreConnectionSettings(settings);
    const token = this.settings.bearerTokenEnv
      ? process.env[this.settings.bearerTokenEnv]
      : undefined;
    if (this.settings.bearerTokenEnv && !token) {
      throw new MemoryCoreError(
        `${this.settings.bearerTokenEnv} is not set`,
        false,
      );
    }
    this.headers = {
      accept: "application/json",
      "x-tdai-service-id": this.settings.serviceId,
      ...(token ? { authorization: `Bearer ${token}` } : {}),
    };
  }

  async request<T>(path: string, options: RequestOptions = {}): Promise<T> {
    const endpoint = this.endpoint(path);
    const headers = {
      ...this.headers,
      ...(options.body ? { "content-type": "application/json" } : {}),
    };
    try {
      new Headers(headers);
    } catch {
      throw new MemoryCoreError(
        "Invalid MemoryCore header configuration",
        false,
      );
    }
    const timeout = AbortSignal.timeout(this.settings.timeoutMs);
    let response: Response;
    try {
      response = await fetch(endpoint.toString(), {
        method: options.method ?? (options.body ? "POST" : "GET"),
        redirect: "error",
        headers,
        body: options.body ? JSON.stringify(options.body) : undefined,
        signal: this.signal ? AbortSignal.any([this.signal, timeout]) : timeout,
      });
    } catch (error) {
      const cause = error instanceof Error ? error.cause : undefined;
      if (cause instanceof Error && cause.message === "unexpected redirect") {
        throw new MemoryCoreError("MemoryCore rejected a redirect", false);
      }
      throw new MemoryCoreError(
        "MemoryCore transport failed or timed out",
        true,
      );
    }

    let envelope: Envelope;
    try {
      envelope = (await response.json()) as Envelope;
    } catch (error) {
      if (!(error instanceof SyntaxError)) {
        throw new MemoryCoreError(
          "MemoryCore response transport failed or timed out",
          true,
        );
      }
      envelope = {};
    }
    const code = validCode(envelope?.code);
    const retryable =
      (!response.ok && transient(response.status)) ||
      (response.ok && code !== undefined && transient(code));
    if (
      !response.ok ||
      code !== 0 ||
      (options.requireData && envelope.data === undefined)
    ) {
      throw new MemoryCoreError(
        `MemoryCore request failed (${response.status}, code ${code ?? "unknown"})`,
        retryable,
      );
    }
    return envelope.data as T;
  }

  private endpoint(path: string): URL {
    const endpoint = new URL(this.settings.baseUrl);
    const route = new URL(path, "https://memory-core.invalid");
    endpoint.pathname = `${endpoint.pathname.replace(/\/$/u, "")}${route.pathname}`;
    endpoint.search = route.search;
    return endpoint;
  }
}
