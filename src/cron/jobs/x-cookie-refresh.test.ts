import { afterEach, expect, it, vi } from "vitest";
import { refreshXCookies } from "../../proxy/x-cookie-refresh.js";
import handler from "./x-cookie-refresh.js";

vi.mock("../../proxy/x-cookie-refresh.js", () => ({
  refreshXCookies: vi.fn(),
}));
afterEach(() => {
  vi.restoreAllMocks();
  vi.clearAllMocks();
});

it("calls the host helper and rethrows failures without logging private diagnostics", async () => {
  const failure = new Error("private browser state");
  vi.mocked(refreshXCookies).mockRejectedValueOnce(failure);
  const log = vi.spyOn(console, "error").mockImplementation(() => {});
  await expect(handler({} as never)).rejects.toBe(failure);
  expect(refreshXCookies).toHaveBeenCalledExactlyOnceWith();
  expect(log).toHaveBeenCalledOnce();
  expect(JSON.stringify(log.mock.calls)).not.toContain(failure.message);
});
