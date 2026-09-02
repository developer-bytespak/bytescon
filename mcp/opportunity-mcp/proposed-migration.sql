-- =============================================================
-- PROPOSED MIGRATION: add_mcp_tables
-- =============================================================
-- This is a HAND-WRITTEN PROPOSAL based on the schema additions in
-- backend/prisma/schema.prisma (models ApiToken, McpAuditLog, enum
-- ApiTokenTier). It is NOT a Prisma-generated migration.
--
-- CLAUDE.md §12 forbids hand-editing a Prisma migration after
-- generation. Therefore: BEFORE APPLYING, regenerate using Prisma:
--
--   cd backend
--   npx prisma migrate dev --create-only --name add_mcp_tables
--
-- That writes the canonical SQL to:
--   backend/prisma/migrations/<timestamp>_add_mcp_tables/migration.sql
--
-- Diff this file against that one. They should match. If they don't,
-- the Prisma-generated version wins; this file is reference only.
--
-- Deploy command (after regeneration):
--   cd backend && npx prisma migrate deploy
--
-- Rollback:
--   DROP TABLE IF EXISTS "mcp_audit_log";
--   DROP TABLE IF EXISTS "api_tokens";
--   DROP TYPE IF EXISTS "ApiTokenTier";
--   (then delete the migration folder)
-- =============================================================

-- CreateEnum
CREATE TYPE "ApiTokenTier" AS ENUM ('CORE', 'PRO', 'VAULT');

-- CreateTable
CREATE TABLE "api_tokens" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "consultingFirmId" TEXT NOT NULL,
    "tokenHash" TEXT NOT NULL,
    "tokenPrefix" TEXT NOT NULL,
    "tier" "ApiTokenTier" NOT NULL DEFAULT 'CORE',
    "scopes" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "lastUsedAt" TIMESTAMP(3),
    "expiresAt" TIMESTAMP(3),
    "revokedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdBy" TEXT,

    CONSTRAINT "api_tokens_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "mcp_audit_log" (
    "id" BIGSERIAL NOT NULL,
    "ts" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "server_name" TEXT NOT NULL,
    "server_version" TEXT NOT NULL,
    "tool_name" TEXT NOT NULL,
    "tenant_id" UUID NOT NULL,
    "user_id" UUID,
    "token_fp" CHAR(16) NOT NULL,
    "input_hash" CHAR(64) NOT NULL,
    "output_bytes" INTEGER NOT NULL,
    "duration_ms" INTEGER NOT NULL,
    "outcome" TEXT NOT NULL,
    "correlation_id" TEXT,
    "client_info" JSONB,

    CONSTRAINT "mcp_audit_log_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "api_tokens_tokenHash_key" ON "api_tokens"("tokenHash");

-- CreateIndex
CREATE INDEX "api_tokens_consultingFirmId_idx" ON "api_tokens"("consultingFirmId");

-- CreateIndex
CREATE INDEX "api_tokens_tokenHash_idx" ON "api_tokens"("tokenHash");

-- CreateIndex
CREATE INDEX "mcp_audit_log_tenant_id_ts_idx" ON "mcp_audit_log"("tenant_id", "ts" DESC);

-- CreateIndex
CREATE INDEX "mcp_audit_log_server_name_tool_name_ts_idx" ON "mcp_audit_log"("server_name", "tool_name", "ts" DESC);

-- =============================================================
-- Optional: enforce append-only on mcp_audit_log at DB level
-- (CLAUDE.md §6.4 retention rule; v0.2 work, included here for review)
-- =============================================================
-- REVOKE UPDATE, DELETE ON "mcp_audit_log" FROM bytescon_user;
-- (Run after creating a separate audit-writer role.)
