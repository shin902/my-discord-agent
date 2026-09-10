import { hostFetch } from "../tools/host-fetch.js";

export async function acknowledgeEmail(emailId: string): Promise<void> {
  const res = await hostFetch(
    "graph",
    `/me/messages/${encodeURIComponent(emailId)}`,
    {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ isRead: true }),
    },
  );
  if (!res.ok) throw new Error(`メール既読化失敗: ${res.status}`);
}
