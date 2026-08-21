import { getProxyPort } from "../proxy/credential-proxy-server.js";

export async function acknowledgeEmail(emailId: string): Promise<void> {
  const res = await fetch(
    `http://localhost:${getProxyPort()}/graph/me/messages/${encodeURIComponent(emailId)}`,
    {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ isRead: true }),
    },
  );
  if (!res.ok) throw new Error(`メール既読化失敗: ${res.status}`);
}
