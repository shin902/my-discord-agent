import { expect } from "vitest";

/**
 * Assert that a value is defined and return it, so tests can avoid `!`
 * non-null assertions that biome's `noNonNullAssertion` rule rejects.
 */
export function expectDefined<T>(value: T | null | undefined): T {
  expect(value).toBeDefined();
  return value as T;
}
