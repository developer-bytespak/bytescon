/**
 * DB-backed integration-test gating, shared across the MCP suite.
 *
 * Historically each server's fixtures defined a local
 * `shouldSkipIntegrationTests()` that returned `!process.env.DATABASE_URL`,
 * so a missing DATABASE_URL silently skipped every integration test and the
 * suite still exited 0. That hid real regressions in CI.
 *
 * New contract:
 *   - In CI (process.env.CI truthy) with DATABASE_URL missing: FAIL LOUDLY.
 *     {@link shouldSkipIntegrationTests} throws naming the missing var so the
 *     run goes red instead of green-with-everything-skipped.
 *   - Locally (no CI) with DATABASE_URL missing: still skip, but emit a
 *     visible console warning so the skip is never silent.
 *   - With DATABASE_URL set: run the integration tests (return false).
 *
 * Per-server fixtures delegate to this single implementation.
 */

/** Truthy check for a CI environment variable (GitHub Actions sets CI=true). */
function isCi(): boolean {
  const ci = process.env.CI;
  return ci !== undefined && ci !== "" && ci.toLowerCase() !== "false" && ci !== "0";
}

let warnedOnce = false;

/**
 * Whether DB-backed integration tests should be skipped for this run.
 *
 * @returns false when DATABASE_URL is set (run the tests); true when it is
 *   unset and not in CI (skip, with a one-time console warning).
 * @throws Error when DATABASE_URL is unset AND running in CI, so the suite
 *   fails loudly instead of skipping silently.
 */
export function shouldSkipIntegrationTests(): boolean {
  if (process.env.DATABASE_URL) {
    return false;
  }
  if (isCi()) {
    throw new Error(
      "DATABASE_URL is not set but CI is set: refusing to silently skip DB-backed " +
        "integration tests. Set DATABASE_URL to a reachable Postgres instance " +
        "(see .github/workflows/ci.yml mcp job) and re-run."
    );
  }
  if (!warnedOnce) {
    warnedOnce = true;
    // eslint-disable-next-line no-console
    console.warn(
      "[mcp-shared] DATABASE_URL is not set: skipping DB-backed integration tests. " +
        "These are NOT silently passing. Set DATABASE_URL locally to run them."
    );
  }
  return true;
}
