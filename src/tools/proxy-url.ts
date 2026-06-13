export function resolveProxyBaseUrl(provider: string): string {
  const credJson = process.env.CREDENTIAL_PROXY_JSON;
  if (!credJson) throw new Error("CREDENTIAL_PROXY_JSON が設定されていません");
  let creds: Array<{ provider: string; baseUrl: string }>;
  try {
    creds = JSON.parse(credJson);
  } catch {
    throw new Error("CREDENTIAL_PROXY_JSON が不正な JSON です");
  }
  const entry = creds.find((e) => e.provider === provider);
  if (!entry)
    throw new Error(
      `${provider} プロバイダーが CREDENTIAL_PROXY_JSON に見つかりません`,
    );
  return entry.baseUrl.replace(/\/$/, "");
}
