import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { expect, it } from "vitest";

const execFileAsync = promisify(execFile);

// A separate Node process is essential: a caught SDK error must not hide a
// subsequent native-fetch unhandled rejection behind Vitest's error handlers.
it.each([
  "healthy",
  "timeout",
  "abort",
  "http-error",
  "disconnect",
])("TypeSafe native transport exits cleanly after %s", async (mode) => {
  const transport = new URL("./typesafe-fetch.ts", import.meta.url).href;
  const { stdout, stderr } = await execFileAsync(
    process.execPath,
    [
      "--unhandled-rejections=strict",
      "--import",
      "tsx",
      "--input-type=module",
      "--eval",
      `
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { setImmediate as nextTurn } from "node:timers/promises";
import {
  TypeSafeClient, noul, APITimeoutError, APIUserAbortError,
  APIConnectionError, RateLimitError,
} from "@typesafe-ai/sdk";
import { typesafeFetch } from ${JSON.stringify(transport)};

const mode = ${JSON.stringify(mode)};
const controller = new AbortController();
const answer = { answers: { ok: { type: "noul", noul: 0.9 } } };
let receivedHeaders = false;
const nativeFetch = globalThis.fetch;
globalThis.fetch = async (...args) => {
  const response = await nativeFetch(...args);
  receivedHeaders = true;
  // Abort only after native fetch has exposed the still-incomplete body.
  if (mode === "abort") setImmediate(() => controller.abort());
  return response;
};
const server = createServer((_req, res) => {
  res.writeHead(mode === "http-error" ? 429 : 200, {
    "content-type": "application/json",
    "retry-after-ms": "0",
  });
  if (mode === "healthy") res.end(JSON.stringify(answer));
  else if (mode === "http-error") res.end(JSON.stringify({ error: "fixture" }));
  else {
    res.write('{"answers":');
    if (mode === "disconnect") setImmediate(() => res.destroy());
  }
});
await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
try {
  const client = new TypeSafeClient({
    apiKey: "synthetic",
    baseURL: "http://127.0.0.1:" + server.address().port,
    logLevel: "off",
    timeout: mode === "timeout" ? 250 : 2000,
    retry: { maxRetries: 0 },
    fetch: typesafeFetch,
  });
  const pending = client.systemOne(
    { state: "fixture", questions: { ok: noul("relevant?") } },
    { signal: controller.signal },
  );
  if (mode === "healthy") assert.deepEqual(await pending, answer);
  else {
    const errorType = {
      timeout: APITimeoutError, abort: APIUserAbortError,
      "http-error": RateLimitError, disconnect: APIConnectionError,
    }[mode];
    await assert.rejects(pending, errorType);
  }
  assert.ok(receivedHeaders, "must exercise an in-flight response body");
  await nextTurn();
} finally {
  server.closeAllConnections();
  await new Promise(resolve => server.close(resolve));
}
console.log("normal process exit");
`,
    ],
    { timeout: 10_000 },
  );
  expect(stdout.trim()).toBe("normal process exit");
  expect(stderr).toBe("");
});
