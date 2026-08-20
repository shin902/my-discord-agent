import { describe, expect, it, vi } from "vitest";
import { createGoogleAuth, GoogleAuthRequiredError, type GoogleAuthFileSystem } from "./google-auth.js";

const config = { clientId: "client", clientSecretEnvVar: "SECRET", scopes: ["calendar"] };
const fileSystem = (cache?: string, writer = vi.fn().mockResolvedValue(undefined)): GoogleAuthFileSystem => ({
  readFile: vi.fn().mockImplementation(async () => cache ?? Promise.reject(new Error("ENOENT"))),
  writeFile: writer, mkdir: vi.fn().mockResolvedValue(undefined), chmod: vi.fn().mockResolvedValue(undefined),
});
type ResponseBody = Record<string, string | number>;
const response = (body: ResponseBody) => ({ json: async () => body });

describe("getGoogleAccessToken", () => {
  it("requires initialization", async () => {
    const { getGoogleAccessToken } = createGoogleAuth({ fileSystem: fileSystem() });
    await expect(getGoogleAccessToken("google")).rejects.toThrow("Google Auth が初期化されていません");
  });
  it("reuses a valid cached token", async () => {
    const fetcher = vi.fn();
    const auth = createGoogleAuth({ fetch: fetcher, fileSystem: fileSystem(JSON.stringify({ accessToken: "cached", expiresAt: Date.now() + 3_600_000 })) });
    await auth.initGoogleAuth("google", config, "secret");
    await expect(auth.getGoogleAccessToken("google")).resolves.toBe("cached");
    expect(fetcher).not.toHaveBeenCalled();
  });
  it("refreshes expired tokens and persists them", async () => {
    const writer = vi.fn().mockResolvedValue(undefined);
    const fetcher = vi.fn().mockResolvedValue(response({ access_token: "new", expires_in: 3600 }));
    const auth = createGoogleAuth({ fetch: fetcher, fileSystem: fileSystem(JSON.stringify({ refreshToken: "refresh", expiresAt: 0 }), writer) });
    await auth.initGoogleAuth("google", config, "secret");
    await expect(auth.getGoogleAccessToken("google")).resolves.toBe("new");
    expect(fetcher.mock.calls[0]?.[0]).toBe("https://oauth2.googleapis.com/token");
    expect(String(fetcher.mock.calls[0]?.[1]?.body)).toContain("grant_type=refresh_token");
    expect(writer).toHaveBeenCalled();
  });
  it("starts device flow and persists its result", async () => {
    const writer = vi.fn().mockResolvedValue(undefined);
    const fetcher = vi.fn().mockResolvedValueOnce(response({ device_code: "device", user_code: "CODE", verification_url: "https://example.com/device", expires_in: 1800, interval: 0 })).mockResolvedValueOnce(response({ access_token: "device-token", refresh_token: "refresh", expires_in: 3600 }));
    const auth = createGoogleAuth({ fetch: fetcher, fileSystem: fileSystem(undefined, writer) });
    await auth.initGoogleAuth("google", config, "secret");
    await expect(auth.getGoogleAccessToken("google")).rejects.toBeInstanceOf(GoogleAuthRequiredError);
    await vi.waitFor(() => expect(writer).toHaveBeenCalled());
  });
  it("returns the same pending device flow", async () => {
    vi.useFakeTimers();
    const fetcher = vi.fn().mockResolvedValue(response({ device_code: "device", user_code: "CODE", verification_url: "https://example.com/device", expires_in: 1800, interval: 60 }));
    const auth = createGoogleAuth({ fetch: fetcher, fileSystem: fileSystem() });
    await auth.initGoogleAuth("google", config, "secret");
    const first = auth.getGoogleAccessToken("google").catch((error: Error) => error);
    const second = auth.getGoogleAccessToken("google").catch((error: Error) => error);
    await vi.runAllTicks();
    await expect(first).resolves.toBeInstanceOf(GoogleAuthRequiredError);
    await expect(second).resolves.toBeInstanceOf(GoogleAuthRequiredError);
    expect(fetcher.mock.calls.filter((call) => String(call[0]) === "https://oauth2.googleapis.com/device/code")).toHaveLength(1);
    vi.useRealTimers();
  });
});
