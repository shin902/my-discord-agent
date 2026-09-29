import { describe, expect, it, vi } from "vitest";
import { refreshRedditCookies } from "../../proxy/reddit-cookie-refresh.js";
import handler from "./reddit-cookie-refresh.js";

vi.mock("../../proxy/reddit-cookie-refresh.js", () => ({
  refreshRedditCookies: vi.fn(),
}));

describe("reddit-cookie-refresh cron", () => {
  it("passes transient failures to the runner without logging credentials", async () => {
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    const error = new Error("private cookie value");
    vi.mocked(refreshRedditCookies).mockRejectedValueOnce(error);
    await expect(handler({} as never)).rejects.toBe(error);
    expect(log.mock.calls.flat().join(" ")).not.toContain(
      "private cookie value",
    );
    log.mockRestore();
  });
});
