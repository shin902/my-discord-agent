import { describe, expect, it } from "vitest";
import { extractXCookies } from "./x-cookie-refresh.js";

describe("extractXCookies", () => {
  it("auth_token と ct0 から Cookie header と CSRF token を抽出する", () => {
    const result = extractXCookies([
      { name: "guest_id", value: "guest", domain: ".x.com" },
      { name: "auth_token", value: "auth-secret", domain: ".x.com" },
      { name: "ct0", value: "csrf-secret", domain: ".x.com" },
    ]);

    expect(result.csrfToken).toBe("csrf-secret");
    expect(result.cookieHeader).toContain("auth_token=auth-secret");
    expect(result.cookieHeader).toContain("ct0=csrf-secret");
  });

  it("auth_token がなければ初回ログインを促す", () => {
    expect(() => extractXCookies([{ name: "ct0", value: "csrf" }])).toThrow(
      "auth_token",
    );
  });

  it("ct0 がなければ再ログインを促す", () => {
    expect(() =>
      extractXCookies([{ name: "auth_token", value: "auth" }]),
    ).toThrow("ct0");
  });
});
