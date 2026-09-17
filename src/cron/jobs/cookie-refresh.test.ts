import { afterEach, describe, expect, it, vi } from "vitest";
import {
  refreshRedditCookiesInRuntime,
  refreshXCookiesInRuntime,
} from "../../runtime/tool-runtime-client.js";
import redditHandler from "./reddit-cookie-refresh.js";
import xHandler from "./x-cookie-refresh.js";

vi.mock("../../runtime/tool-runtime-client.js", () => ({
  refreshRedditCookiesInRuntime: vi.fn(),
  refreshXCookiesInRuntime: vi.fn(),
}));

afterEach(() => {
  vi.restoreAllMocks();
  vi.clearAllMocks();
});

describe("cookie refresh cron handlers", () => {
  it.each([
    ["X", xHandler, refreshXCookiesInRuntime],
    ["Reddit", redditHandler, refreshRedditCookiesInRuntime],
  ])("propagates %s refresh failures to the cron runner", async (_name, handler, refresh) => {
    const failure = new Error("temporary failure");
    vi.mocked(refresh).mockRejectedValueOnce(failure);
    vi.spyOn(console, "error").mockImplementation(() => {});
    await expect(handler({} as never)).rejects.toBe(failure);
  });
});
