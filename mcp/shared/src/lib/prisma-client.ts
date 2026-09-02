/**
 * Prisma client access for Bytescon MCP servers.
 *
 * Design: every shared helper takes an injected client typed as the
 * minimal structural interface {@link PrismaLikeClient}, so unit tests
 * inject mocks and servers stay decoupled from where the generated
 * client lives on disk.
 *
 * Background: opportunity-mcp imports the bare "@prisma/client" specifier
 * and copies the backend-generated client into its own node_modules during
 * `npm run prisma:generate`. That trick depends on each server owning a
 * @prisma/client install plus a copy step, and the relative path math
 * breaks when a package is consumed through the `file:` protocol (the
 * import then resolves from the consumer's node_modules, at a different
 * depth). This loader avoids both problems:
 *
 *   1. If Bytescon_PRISMA_CLIENT_PATH is set, require exactly that path
 *      (absolute path to the generated client entry file or directory).
 *   2. Otherwise walk upward from this module's real on-disk location
 *      (npm installs `file:` dependencies as symlinks, and Node resolves
 *      them to the real path, so this lands inside the repo even when the
 *      package is consumed via "file:../shared") and from process.cwd(),
 *      looking for `backend/node_modules/@prisma/client/index.js`, which
 *      re-exports the backend-generated client in `.prisma/client`.
 *
 * The generated client is CommonJS, so it is loaded with createRequire
 * using an absolute path, which works from any location.
 */
import { existsSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { McpToolError } from "./errors.js";

const requireCjs = createRequire(import.meta.url);

/** Environment variable that overrides generated-client path resolution. */
export const PRISMA_CLIENT_PATH_ENV = "Bytescon_PRISMA_CLIENT_PATH";

/**
 * The api_tokens columns the shared auth helper reads. The real generated
 * row is a superset of this shape.
 */
export interface PrismaApiTokenRecord {
  id: string;
  /** SHA-256 hex of the raw token; its first 16 chars are the audit fingerprint. */
  tokenHash: string;
  consultingFirmId: string;
  tier: string;
  /**
   * Which delivery interface the credential was minted for. Added in §8.4 when
   * the public REST API began sharing this table. Optional here because older
   * generated clients and test mocks predate the column; a row without it is
   * treated as an MCP token, which is exactly what every pre-§8.4 row is.
   */
  kind?: string | null;
  revokedAt: Date | null;
  expiresAt: Date | null;
}

/** Column shape written to mcp_audit_log (camelCase Prisma field names). */
export interface PrismaAuditCreateData {
  serverName: string;
  serverVersion: string;
  toolName: string;
  tenantId: string;
  userId: string | null;
  tokenFp: string;
  inputHash: string;
  outputBytes: number;
  durationMs: number;
  outcome: string;
  correlationId: string | null;
  clientInfo: Record<string, unknown> | null;
}

/**
 * Minimal structural view of the generated PrismaClient covering exactly
 * what the shared helpers touch: api_tokens reads plus best-effort
 * lastUsedAt update, mcp_audit_log appends, and disconnect.
 *
 * Servers needing more models should obtain the full client from
 * {@link createPrismaClient} and cast it to their own typed view, or pass
 * their own generated client cast with `as unknown as PrismaLikeClient`
 * where shared helpers require one.
 */
export interface PrismaLikeClient {
  apiToken: {
    findUnique(args: {
      where: { tokenHash: string } | { id: string };
    }): Promise<PrismaApiTokenRecord | null>;
    update(args: { where: { id: string }; data: { lastUsedAt: Date } }): Promise<unknown>;
  };
  mcpAuditLog: {
    create(args: { data: PrismaAuditCreateData }): Promise<unknown>;
  };
  $disconnect(): Promise<void>;
}

/** Constructor signature of the generated PrismaClient class. */
export interface PrismaClientConstructor {
  new (options?: Record<string, unknown>): PrismaLikeClient;
}

const MAX_WALK_UP_LEVELS = 12;

function findBackendClientFrom(startDir: string): string | null {
  let dir = startDir;
  for (let i = 0; i < MAX_WALK_UP_LEVELS; i++) {
    const candidate = path.join(dir, "backend", "node_modules", "@prisma", "client", "index.js");
    if (existsSync(candidate)) return candidate;
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return null;
}

/**
 * Resolve the absolute path of the backend-generated Prisma client entry.
 *
 * Resolution order: Bytescon_PRISMA_CLIENT_PATH env override, then an upward
 * search from this module's real directory, then from process.cwd().
 *
 * @returns Absolute path suitable for createRequire.
 * @throws McpToolError (INTERNAL_ERROR) when no candidate exists, with a
 *   message explaining how to fix the environment.
 */
export function resolveBackendPrismaClientPath(): string {
  const override = process.env[PRISMA_CLIENT_PATH_ENV];
  if (override) {
    const resolved = path.resolve(override);
    if (!existsSync(resolved)) {
      throw new McpToolError(
        "INTERNAL_ERROR",
        `${PRISMA_CLIENT_PATH_ENV} is set to "${override}" but that path does not exist`
      );
    }
    return resolved;
  }

  const moduleDir = path.dirname(fileURLToPath(import.meta.url));
  const fromModule = findBackendClientFrom(moduleDir);
  if (fromModule) return fromModule;

  const fromCwd = findBackendClientFrom(process.cwd());
  if (fromCwd) return fromCwd;

  throw new McpToolError(
    "INTERNAL_ERROR",
    "Unable to locate the backend-generated Prisma client " +
      "(backend/node_modules/@prisma/client/index.js). " +
      "Run `npx prisma generate --schema=backend/prisma/schema.prisma` from the repo root, " +
      `or set ${PRISMA_CLIENT_PATH_ENV} to the absolute path of the generated client.`
  );
}

/**
 * Load the generated PrismaClient constructor from the backend client.
 *
 * @returns The PrismaClient class, typed as {@link PrismaClientConstructor}.
 * @throws McpToolError (INTERNAL_ERROR) when the path cannot be resolved or
 *   the loaded module does not export a PrismaClient constructor.
 */
export function loadPrismaClientConstructor(): PrismaClientConstructor {
  const entry = resolveBackendPrismaClientPath();
  const mod = requireCjs(entry) as { PrismaClient?: unknown };
  if (typeof mod.PrismaClient !== "function") {
    throw new McpToolError(
      "INTERNAL_ERROR",
      `module at "${entry}" does not export a PrismaClient constructor; ` +
        "verify it is a generated Prisma client"
    );
  }
  return mod.PrismaClient as PrismaClientConstructor;
}

declare global {
  // eslint-disable-next-line no-var
  var __govconMcpSharedPrisma: PrismaLikeClient | undefined;
}

/**
 * Create (or reuse) a process-wide PrismaClient instance backed by the
 * backend-generated client. Mirrors opportunity-mcp's singleton pattern:
 * the instance is cached on globalThis outside production so dev reloads
 * do not leak connections.
 *
 * Reads DATABASE_URL from the environment (Prisma datasource config).
 *
 * @returns A client satisfying {@link PrismaLikeClient}. Cast to your own
 *   typed view for additional models.
 */
export function createPrismaClient(): PrismaLikeClient {
  if (globalThis.__govconMcpSharedPrisma) return globalThis.__govconMcpSharedPrisma;
  const PrismaClientCtor = loadPrismaClientConstructor();
  const client = new PrismaClientCtor();
  if (process.env.NODE_ENV !== "production") {
    globalThis.__govconMcpSharedPrisma = client;
  }
  return client;
}

/**
 * Disconnect a Prisma client, for graceful shutdown handlers.
 *
 * @param client - The client to disconnect.
 * @returns Resolves when the underlying connections are closed.
 */
export async function disconnectPrisma(client: PrismaLikeClient): Promise<void> {
  await client.$disconnect();
}
