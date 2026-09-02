/**
 * Mock PrismaLikeClient factory for shared unit tests.
 *
 * No database rows are ever created by these tests; all ids use the
 * shared-mcp-test- prefix anyway so any accidental persistence would be
 * identifiable and collision-free on the shared dev DB.
 */
import { vi } from "vitest";
import type { PrismaApiTokenRecord, PrismaLikeClient } from "../../src/lib/prisma-client.js";

export const TEST_PREFIX = "shared-mcp-test-";

export interface MockPrisma extends PrismaLikeClient {
  apiToken: {
    findUnique: ReturnType<typeof vi.fn>;
    update: ReturnType<typeof vi.fn>;
  };
  mcpAuditLog: {
    create: ReturnType<typeof vi.fn>;
  };
  $disconnect: ReturnType<typeof vi.fn>;
}

export function makeTokenRow(overrides?: Partial<PrismaApiTokenRecord>): PrismaApiTokenRecord {
  return {
    id: `${TEST_PREFIX}token-id`,
    tokenHash: `${"a".repeat(64)}`,
    consultingFirmId: `${TEST_PREFIX}firm-id`,
    tier: "CORE",
    kind: "MCP",
    revokedAt: null,
    expiresAt: null,
    ...overrides,
  };
}

export function makeMockPrisma(tokenRow: PrismaApiTokenRecord | null = null): MockPrisma {
  return {
    apiToken: {
      findUnique: vi.fn().mockResolvedValue(tokenRow),
      update: vi.fn().mockResolvedValue({}),
    },
    mcpAuditLog: {
      create: vi.fn().mockResolvedValue({ id: 1n }),
    },
    $disconnect: vi.fn().mockResolvedValue(undefined),
  };
}
