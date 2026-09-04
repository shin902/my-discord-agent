const DEFAULT_RUNTIME_URL = "http://127.0.0.1:8787";

/** Host cron entry point for the runtime-only Reddit maintenance operation. */
export async function refreshRedditCookiesInRuntime(): Promise<void> {
  const baseUrl = (
    process.env.AGENT_REACH_RUNTIME_URL ?? DEFAULT_RUNTIME_URL
  ).replace(/\/$/, "");
  const token = process.env.AGENT_REACH_REFRESH_TOKEN;
  if (!token)
    throw new Error("Agent Reach Tool Runtime refresh token is unavailable");
  const response = await fetch(`${baseUrl}/maintenance/reddit-cookie-refresh`, {
    method: "POST",
    headers: { authorization: `Bearer ${token}` },
  });
  if (!response.ok) {
    const text = await response.text().catch(() => "");
    throw new Error(
      text || `Tool Runtime refresh failed (HTTP ${response.status})`,
    );
  }
}
