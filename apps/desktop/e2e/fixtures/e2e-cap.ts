import { test } from "@playwright/test";

const raw = process.env.E2E_MAX_TESTS;
const cap =
  raw != null && raw !== "" && !Number.isNaN(Number(raw))
    ? Number(raw)
    : null;

/** When `E2E_MAX_TESTS=35`, skip tests after the first 35 in Playwright file order. */
export const e2eSkipAfter35 = cap === 35;

export function describeAfter35(name: string, fn: () => void): void {
  if (e2eSkipAfter35) {
    test.describe.skip(name, fn);
  } else {
    test.describe(name, fn);
  }
}
