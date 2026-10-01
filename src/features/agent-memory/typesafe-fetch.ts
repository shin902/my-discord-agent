/**
 * TypeSafe SDK 0.6.0 clones responses while their bodies are still arriving.
 * Aborting that native fetch clone can crash Node 22 outside the caller's catch:
 * https://github.com/typesafe-ai/typesafe-sdk-js/issues/2
 * Consume the network body before the SDK can clone it. The SDK's signal still
 * bounds the entire download; its clone only ever sees an in-memory response.
 * This transport is for systemOne JSON responses, not streaming/raw responses.
 */
export async function typesafeFetch(
  input: string,
  init?: RequestInit,
): Promise<Response> {
  const response = await fetch(input, init);
  const body = response.body === null ? null : await response.arrayBuffer();
  return new Response(body, {
    status: response.status,
    statusText: response.statusText,
    headers: response.headers,
  });
}
