/**
 * Typed structural view of the backend-generated Prisma client covering
 * exactly the models and query shapes proposal-mcp uses.
 *
 * @bytescon/mcp-shared loads the real generated client at runtime
 * (createPrismaClient) and types it as the minimal PrismaLikeClient.
 * Per its documented contract, servers needing more models cast the
 * client to their own typed view; this module is that view. Field names
 * verified against backend/prisma/schema.prisma on 2026-06-11
 * (ComplianceMatrix, MatrixRequirement, AdherenceScore, Opportunity).
 */
import type { PrismaLikeClient } from "@bytescon/mcp-shared";

/** compliance_matrices columns this server reads. */
export interface ComplianceMatrixRow {
  id: string;
  opportunityId: string;
  consultingFirmId: string;
  generatedAt: Date;
  updatedAt: Date;
  bidGuidanceJson: unknown;
  bidGuidanceAt: Date | null;
}

/** matrix_requirements columns this server reads. */
export interface MatrixRequirementRow {
  id: string;
  matrixId: string;
  section: string;
  sectionType: string;
  requirementText: string;
  isMandatory: boolean;
  status: string;
  farReference: string | null;
  sortOrder: number;
}

/** Requirement row joined with its parent matrix's opportunityId. */
export interface MatrixRequirementWithMatrixRow extends MatrixRequirementRow {
  matrix: { opportunityId: string };
}

/** adherence_scores columns this server reads. */
export interface AdherenceScoreRow {
  id: string;
  opportunityId: string;
  proposalSectionId: string | null;
  overallScore: number;
  requirementCoverage: number | null;
  evaluationAlignment: number | null;
  evidenceSufficiency: number | null;
  farClauseCoverage: number | null;
  readability: number | null;
  consistency: number | null;
  ambiguity: number | null;
  blockersJson: unknown;
  computedAt: Date;
}

/** opportunities columns used for pricing-template prefill. Decimal columns
 * are typed structurally (toString) and converted with Number(). */
export interface OpportunityPrefillRow {
  id: string;
  title: string;
  agency: string;
  naicsCode: string;
  setAsideType: string;
  estimatedValue: { toString(): string } | null;
  responseDeadline: Date;
}

/**
 * WHERE shape for matrix_requirements queries. The tenant filter lives on
 * the parent matrix relation and MUST be present on every query.
 */
export interface MatrixRequirementWhere {
  matrix: { is: { consultingFirmId: string; opportunityId?: string } };
  sectionType?: string;
  isMandatory?: boolean;
  status?: string;
}

/** The Prisma surface proposal-mcp queries, beyond PrismaLikeClient. */
export interface ProposalDbClient extends PrismaLikeClient {
  complianceMatrix: {
    findFirst(args: {
      where: { consultingFirmId: string; opportunityId: string };
    }): Promise<ComplianceMatrixRow | null>;
  };
  matrixRequirement: {
    count(args: { where: MatrixRequirementWhere }): Promise<number>;
    findMany(args: {
      where: MatrixRequirementWhere;
      orderBy: Array<Record<string, "asc" | "desc">>;
      skip: number;
      take: number;
      include: { matrix: { select: { opportunityId: true } } };
    }): Promise<MatrixRequirementWithMatrixRow[]>;
  };
  adherenceScore: {
    findMany(args: {
      where: { consultingFirmId: string; opportunityId: string };
      orderBy: { computedAt: "desc" };
      take: number;
    }): Promise<AdherenceScoreRow[]>;
  };
  opportunity: {
    findFirst(args: {
      where: { consultingFirmId: string; id: string };
      select: {
        id: true;
        title: true;
        agency: true;
        naicsCode: true;
        setAsideType: true;
        estimatedValue: true;
        responseDeadline: true;
      };
    }): Promise<OpportunityPrefillRow | null>;
  };
}

/**
 * Cast the shared client to this server's typed view. The cast is safe
 * because the runtime object is always the full backend-generated
 * PrismaClient, a superset of both interfaces.
 *
 * @param client - The PrismaLikeClient from ToolHandlerContext.
 * @returns The same client typed as ProposalDbClient.
 */
export function asProposalDb(client: PrismaLikeClient): ProposalDbClient {
  return client as unknown as ProposalDbClient;
}
