/**
 * Prisma client singleton for opportunity-mcp.
 *
 * The MCP package generates its own Prisma client into its node_modules
 * via `npm run prisma:generate` (see package.json) so the bare specifier
 * resolves to the correct generated client. The DATABASE_URL env var
 * points at the same Postgres instance the backend uses. This server
 * only reads `opportunities` / `bid_decisions` / `recipient_profiles` /
 * `compliance_matrices` / `matrix_requirements` and only writes
 * `mcp_audit_log` and `api_tokens.lastUsedAt`.
 */
import { PrismaClient } from "@prisma/client";

declare global {
  // eslint-disable-next-line no-var
  var __mcpPrisma: PrismaClient | undefined;
}

export const prisma: PrismaClient = global.__mcpPrisma ?? new PrismaClient();

if (process.env.NODE_ENV !== "production") {
  global.__mcpPrisma = prisma;
}

export async function disconnectPrisma(): Promise<void> {
  await prisma.$disconnect();
}
