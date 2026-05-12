import { describe, expect, it } from "vitest";
import { isTransientError, TransientError } from "./error.js";

describe("isTransientError", () => {
  it("returns true for timeout errors", () => {
    expect(isTransientError(new Error("Request timeout"))).toBe(true);
    expect(isTransientError(new Error("ETIMEDOUT"))).toBe(true);
  });

  it("returns true for rate limit errors", () => {
    expect(isTransientError(new Error("Rate limit exceeded: 429"))).toBe(true);
  });

  it("returns true for network errors", () => {
    expect(isTransientError(new Error("ECONNRESET"))).toBe(true);
    expect(isTransientError(new Error("ECONNREFUSED"))).toBe(true);
    expect(isTransientError(new Error("socket hang up"))).toBe(true);
    expect(isTransientError(new Error("network error"))).toBe(true);
  });

  it("returns true for temporarily unavailable", () => {
    expect(isTransientError(new Error("Service temporarily unavailable"))).toBe(
      true,
    );
  });

  it("returns false for non-transient errors", () => {
    expect(isTransientError(new Error("File not found"))).toBe(false);
    expect(isTransientError(new Error("Invalid API key"))).toBe(false);
    expect(isTransientError("some string")).toBe(false);
    expect(isTransientError(null)).toBe(false);
  });
});

describe("TransientError", () => {
  it("has the correct name and message", () => {
    const err = new TransientError("something went wrong");
    expect(err.name).toBe("TransientError");
    expect(err.message).toBe("something went wrong");
    expect(err).toBeInstanceOf(Error);
  });
});
