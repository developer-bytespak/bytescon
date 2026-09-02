/**
 * Server-specific typed view of the backend-generated Prisma client.
 *
 * @bytescon/mcp-shared exposes the generated client as the minimal
 * PrismaLikeClient (api_tokens + mcp_audit_log + disconnect). knowledge-mcp
 * additionally reads the global regulatory catalog (far_clauses,
 * dfars_clauses), agency_award_profiles, and aggregates opportunities by
 * NAICS. This module declares the structural shape of exactly those reads
 * and provides the single cast boundary from PrismaLikeClient.
 *
 * Column names and nullability verified against
 * backend/prisma/schema.prisma (models FarClause, DfarsClause,
 * AgencyAwardProfile, Opportunity) on 2026-06-11.
 */
import type { PrismaLikeClient } from "@bytescon/mcp-shared";

/** Decimal columns surface as objects with toString(); converted via Number(). */
export type DecimalLike = { toString(): string } | number | null;

/** far_clauses row (full column set). */
export interface FarClauseRow {
  id: string;
  code: string;
  partNumber: string;
  subpartNumber: string | null;
  title: string;
  prescribedAt: string | null;
  applicableContractTypes: string[];
  setAsideTriggers: string[];
  agencyTriggers: string[];
  flowDownRequired: boolean;
  flowDownThreshold: DecimalLike;
  prerequisiteClauseCodes: string[];
  prohibitedClauseCodes: string[];
  commercialItemException: boolean;
  isBlocking: boolean;
  effectiveDate: Date | null;
  lastRevisedDate: Date | null;
  text: string;
  summary: string | null;
  tags: string[];
}

/** dfars_clauses row (full column set; narrower than FAR per schema). */
export interface DfarsClauseRow {
  id: string;
  code: string;
  partNumber: string;
  title: string;
  prescribedAt: string | null;
  applicableContractTypes: string[];
  agencyTriggers: string[];
  flowDownRequired: boolean;
  flowDownThreshold: DecimalLike;
  prerequisiteClauseCodes: string[];
  isBlocking: boolean;
  effectiveDate: Date | null;
  lastRevisedDate: Date | null;
  text: string;
  summary: string | null;
  tags: string[];
}

/** agency_award_profiles row (global, no tenant column). */
export interface AgencyAwardProfileRow {
  id: string;
  agencyName: string;
  avgAwardValue: number | null;
  smallBizRate: number;
  sdvosbRate: number;
  womenOwnedRate: number;
  hubzoneRate: number;
  totalAwards: number;
  typicalNaics: string[];
  lastRefreshedAt: Date;
}

/** Code suggestion projection used by the retrieve tools. */
export interface ClauseCodeSuggestion {
  code: string;
  title: string;
}

/** String filter subset used by this server. */
export interface StringFilter {
  contains?: string;
  startsWith?: string;
  mode?: "insensitive" | "default";
  not?: string;
}

/** WHERE shape for clause table queries. */
export interface ClauseWhere {
  code?: string | StringFilter;
  title?: StringFilter;
  summary?: StringFilter;
  text?: StringFilter;
  OR?: ClauseWhere[];
}

interface ClauseDelegate<Row> {
  findUnique(args: { where: { code: string } }): Promise<Row | null>;
  findMany(args: {
    where: ClauseWhere;
    orderBy?: { code: "asc" | "desc" };
    take?: number;
    select?: Record<string, boolean>;
  }): Promise<Row[]>;
}

/** Result row of the opportunity NAICS groupBy aggregate. */
export interface NaicsGroupRow {
  naicsCode: string;
  _count: { naicsCode: number };
}

/**
 * Structural view of the generated client covering knowledge-mcp's reads.
 * Extends the shared PrismaLikeClient so the same instance serves auth
 * and audit writes.
 */
export interface KnowledgePrismaClient extends PrismaLikeClient {
  farClause: ClauseDelegate<FarClauseRow>;
  dfarsClause: ClauseDelegate<DfarsClauseRow>;
  agencyAwardProfile: {
    findMany(args: {
      where: { agencyName: StringFilter };
      orderBy?: { agencyName: "asc" | "desc" };
      take?: number;
    }): Promise<AgencyAwardProfileRow[]>;
  };
  opportunity: {
    groupBy(args: {
      by: ["naicsCode"];
      where: { agency: StringFilter; naicsCode: StringFilter };
      _count: { naicsCode: true };
      orderBy: { _count: { naicsCode: "desc" } };
      take: number;
    }): Promise<NaicsGroupRow[]>;
  };
}

/**
 * Single cast boundary from the shared minimal client view to the
 * knowledge-mcp typed view. The underlying instance is the full
 * backend-generated PrismaClient, so the cast is safe at runtime.
 *
 * @param prisma - Client provided by the shared bootstrap.
 * @returns The same instance, typed for knowledge-mcp reads.
 */
export function knowledgeClient(prisma: PrismaLikeClient): KnowledgePrismaClient {
  return prisma as KnowledgePrismaClient;
}

/**
 * Convert a Prisma Decimal-like value to number or null.
 *
 * @param value - Decimal object, number, or null.
 * @returns Number value, or null when input is null or undefined.
 */
export function decimalToNumber(value: DecimalLike | undefined): number | null {
  if (value === null || value === undefined) return null;
  return typeof value === "number" ? value : Number(value.toString());
}
