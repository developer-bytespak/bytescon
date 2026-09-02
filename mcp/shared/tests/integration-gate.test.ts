/**
 * Unit tests for the loud-fail DB-gated integration gate.
 *
 * Contract (CLAUDE.md / suite README limitation 2):
 *   - DATABASE_URL set         -> false (run integration tests).
 *   - unset + CI truthy        -> THROW (fail loudly, name the missing var).
 *   - unset + not CI           -> true (skip, with a visible console warning).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { shouldSkipIntegrationTests } from "../src/lib/integration-gate.js";

const ENV_KEYS = ["DATABASE_URL", "CI"] as const;

describe("shouldSkipIntegrationTests() loud-fail gate (unit)", () => {
  let saved: Record<string, string | undefined>;

  beforeEach(() => {
    saved = {};
    for (const k of ENV_KEYS) {
      saved[k] = process.env[k];
      delete process.env[k];
    }
  });

  afterEach(() => {
    for (const k of ENV_KEYS) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
    vi.restoreAllMocks();
  });

  it("returns false when DATABASE_URL is set (run integration tests)", () => {
    process.env.DATABASE_URL = "postgresql://u:p@localhost:5432/db";
    process.env.CI = "true";
    expect(shouldSkipIntegrationTests()).toBe(false);
  });

  it("throws loudly when CI is set and DATABASE_URL is missing", () => {
    process.env.CI = "true";
    expect(() => shouldSkipIntegrationTests()).toThrow(/DATABASE_URL is not set but CI is set/);
    // The message names the missing var so the failure is actionable.
    expect(() => shouldSkipIntegrationTests()).toThrow(/DATABASE_URL/);
  });

  it("skips with a visible console warning locally (no CI, no DATABASE_URL)", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    expect(shouldSkipIntegrationTests()).toBe(true);
    expect(warn).toHaveBeenCalled();
    expect(String(warn.mock.calls[0]![0])).toMatch(/NOT silently passing/);
  });

  it("treats CI=false and CI=0 as not-CI (skip, do not throw)", () => {
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    process.env.CI = "false";
    expect(shouldSkipIntegrationTests()).toBe(true);
    process.env.CI = "0";
    expect(shouldSkipIntegrationTests()).toBe(true);
  });
});
