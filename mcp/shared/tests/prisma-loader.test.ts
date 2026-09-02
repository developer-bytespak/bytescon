import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { isMcpToolError } from "../src/lib/errors.js";
import {
  loadPrismaClientConstructor,
  PRISMA_CLIENT_PATH_ENV,
  resolveBackendPrismaClientPath,
} from "../src/lib/prisma-client.js";

let savedEnv: string | undefined;
let tmpDir: string | undefined;

beforeEach(() => {
  savedEnv = process.env[PRISMA_CLIENT_PATH_ENV];
});

afterEach(() => {
  if (savedEnv === undefined) {
    delete process.env[PRISMA_CLIENT_PATH_ENV];
  } else {
    process.env[PRISMA_CLIENT_PATH_ENV] = savedEnv;
  }
  if (tmpDir) {
    rmSync(tmpDir, { recursive: true, force: true });
    tmpDir = undefined;
  }
});

describe("prisma client loader (unit)", () => {
  it("honors the Bytescon_PRISMA_CLIENT_PATH env override", () => {
    tmpDir = mkdtempSync(path.join(os.tmpdir(), "shared-mcp-test-loader-"));
    const fake = path.join(tmpDir, "fake-prisma-client.cjs");
    writeFileSync(
      fake,
      "class PrismaClient { constructor() { this.marker = 'shared-mcp-test-fake'; } }\n" +
        "module.exports = { PrismaClient };\n",
      "utf8"
    );
    process.env[PRISMA_CLIENT_PATH_ENV] = fake;

    expect(resolveBackendPrismaClientPath()).toBe(path.resolve(fake));
    const Ctor = loadPrismaClientConstructor();
    const instance = new Ctor() as unknown as { marker: string };
    expect(instance.marker).toBe("shared-mcp-test-fake");
  });

  it("throws INTERNAL_ERROR when the override path does not exist", () => {
    process.env[PRISMA_CLIENT_PATH_ENV] = path.join(
      os.tmpdir(),
      "shared-mcp-test-does-not-exist",
      "index.js"
    );
    try {
      resolveBackendPrismaClientPath();
      expect.unreachable("resolveBackendPrismaClientPath should have thrown");
    } catch (err) {
      expect(isMcpToolError(err)).toBe(true);
      if (isMcpToolError(err)) {
        expect(err.code).toBe("INTERNAL_ERROR");
        expect(err.message).toContain(PRISMA_CLIENT_PATH_ENV);
      }
    }
  });

  it("throws INTERNAL_ERROR when the override module lacks a PrismaClient export", () => {
    tmpDir = mkdtempSync(path.join(os.tmpdir(), "shared-mcp-test-loader-"));
    const fake = path.join(tmpDir, "not-a-client.cjs");
    writeFileSync(fake, "module.exports = { somethingElse: 1 };\n", "utf8");
    process.env[PRISMA_CLIENT_PATH_ENV] = fake;

    try {
      loadPrismaClientConstructor();
      expect.unreachable("loadPrismaClientConstructor should have thrown");
    } catch (err) {
      expect(isMcpToolError(err)).toBe(true);
      if (isMcpToolError(err)) {
        expect(err.code).toBe("INTERNAL_ERROR");
        expect(err.message).toContain("PrismaClient");
      }
    }
  });

  it("resolves the backend generated client by walking up from this repo", () => {
    delete process.env[PRISMA_CLIENT_PATH_ENV];
    const resolved = resolveBackendPrismaClientPath();
    expect(resolved.replace(/\\/g, "/")).toMatch(
      /backend\/node_modules\/@prisma\/client\/index\.js$/
    );
    const Ctor = loadPrismaClientConstructor();
    expect(typeof Ctor).toBe("function");
  });
});
