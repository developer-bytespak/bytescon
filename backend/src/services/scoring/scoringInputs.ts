// =============================================================
// The one place that turns an opportunity and a client into scoring inputs.
//
// The stored score (scoring and enrichment workers) and the live decision
// (decision engine, which the client portal's tier comes from) used to gather
// these separately, so one opportunity could score differently depending on the
// path. Anything that feeds the win-probability model belongs here.
//
// A signal with no source data stays null. The engine then falls back or, with
// renormalization on, drops the factor, rather than treating a stand-in constant
// as a real measurement.
// =============================================================
import { getAgencyHistoryScore } from '../../engines/agencyProfiler'
import { getDensityScore } from '../../engines/competitiveDensity'
import { computeDeadlineUrgency, type scoreOpportunityForClient } from '../../engines/probabilityEngine'

type ScoringParams = Parameters<typeof scoreOpportunityForClient>[0]

export interface ScoringOpportunity {
  naicsCode: string
  agency: string
  responseDeadline: Date
  estimatedValue?: unknown
  incumbentProbability?: number | null
  competitionCount?: number | null
  offersReceived?: number | null
  agencySdvosbRate?: number | null
  historicalAwardCount?: number | null
  documentIntelScore?: number | null
  title?: string | null
  description?: string | null
}

export interface ScoringClient {
  naicsCodes: string[]
  sdvosb: boolean
  wosb: boolean
  hubzone: boolean
  smallBusiness: boolean
  capabilityKeywords?: string[] | null
}

export function historicalDistributionFrom(historicalAwardCount: number | null | undefined): number | null {
  return historicalAwardCount ? Math.min(historicalAwardCount / 1000, 0.8) : null
}

export async function buildScoringInputs(opportunity: ScoringOpportunity, client: ScoringClient): Promise<ScoringParams> {
  const clientProfile = {
    sdvosb: client.sdvosb,
    wosb: client.wosb,
    hubzone: client.hubzone,
    smallBusiness: client.smallBusiness,
  }
  const [density, agencyHistoryScore] = await Promise.all([
    getDensityScore(opportunity.naicsCode, opportunity.offersReceived ?? opportunity.competitionCount ?? null),
    getAgencyHistoryScore(opportunity.agency, clientProfile),
  ])
  return {
    opportunityNaics: opportunity.naicsCode,
    opportunityEstimatedValue: opportunity.estimatedValue ? Number(opportunity.estimatedValue) : null,
    opportunityAgency: opportunity.agency,
    clientNaics: client.naicsCodes,
    clientProfile,
    clientCapabilityKeywords: client.capabilityKeywords ?? [],
    opportunityText: [opportunity.title, opportunity.description].filter(Boolean).join('\n'),
    incumbentProbability: opportunity.incumbentProbability ?? null,
    competitionCount: opportunity.competitionCount ?? null,
    offersReceived: opportunity.offersReceived ?? null,
    agencySdvosbRate: opportunity.agencySdvosbRate ?? null,
    historicalDistribution: historicalDistributionFrom(opportunity.historicalAwardCount),
    documentAlignmentScore: opportunity.documentIntelScore ?? null,
    agencyHistoryScore,
    deadlineUrgencyScore: computeDeadlineUrgency(opportunity.responseDeadline),
    densityScore: density.score,
  }
}
