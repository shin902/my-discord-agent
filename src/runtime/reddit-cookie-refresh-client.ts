const DEFAULT_RUNTIME_URL = "http://127.0.0.1:8787";
const CONNECTION_RETRIES = 5;
const CONNECTION_RETRY_DELAY_MS = 500;
const CONNECTION_ERROR_CODES = new Set([
  "ECONNREFUSED",
  "EHOSTUNREACH",
  "ENETUNREACH",
]);

function isConnectionFailure(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  const cause = error.cause;
  const causeCode =
    cause && typeof cause === "object" && "code" in cause
      ? (cause as { code?: unknown }).code
      : undefined;
  const directCode = (error as Error & { code?: unknown }).code;
  return [causeCode, directCode].some(
    (code) => typeof code === "string" && CONNECTION_ERROR_CODES.has(code),
  );
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

/** Host cron entry point for the runtime-only Reddit maintenance operation. */
export async function refreshRedditCookiesInRuntime(): Promise<void> {
  const baseUrl = (
    process.env.AGENT_REACH_RUNTIME_URL ?? DEFAULT_RUNTIME_URL
  ).replace(/\/$/, "");
  const token = process.env.AGENT_REACH_REFRESH_TOKEN;
  if (!token)
    throw new Error("Agent Reach Tool Runtime refresh token is unavailable");
  let response: Response;
  for (let attempt = 0; ; attempt += 1) {
    try {
      response = await fetch(`${baseUrl}/maintenance/reddit-cookie-refresh`, {
        method: "POST",
        headers: { authorization: `Bearer ${token}` },
      });
      break;
    } catch (error) {
      if (!isConnectionFailure(error) || attempt >= CONNECTION_RETRIES)
        throw error;
      await delay(CONNECTION_RETRY_DELAY_MS);
    }
  }
  if (!response.ok) {
    const text = await response.text().catch(() => "");
    throw new Error(
      text || `Tool Runtime refresh failed (HTTP ${response.status})`,
    );
  }
}
