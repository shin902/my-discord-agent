import { describe, expect, it } from "vitest";
import {
  formatCurrentDateTime,
  formatSessionTimeAnchor,
  formatWeekday,
} from "./context.js";

describe("time context formatting", () => {
  const timestamp = Date.parse("2026-08-27T22:37:06Z");

  it("formats a fixed hour-level JST session anchor", () => {
    expect(formatSessionTimeAnchor(timestamp)).toBe(
      "## Session time anchor\n\nStarted: 2026-08-28 07:00 JST (Fri)",
    );
  });

  it("formats exact current time with a numeric offset", () => {
    expect(formatCurrentDateTime(timestamp)).toBe("2026-08-28T07:37:06+09:00");
    expect(formatWeekday(timestamp)).toBe("Fri");
  });
});
