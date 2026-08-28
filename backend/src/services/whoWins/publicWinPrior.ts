// =============================================================
// Who-Wins — runtime public-label win prior.
//
// getPublicWinPrior(opportunity, client) returns the calibrated prior:
//   p = σ( logit(shrunk E[1/K] for the opportunity's segment)
//          + ln(clamped relative-strength adjustment) )
// The adjustment compares the client's utility (β·x̃ from its REAL
// public federal history, when it has a UEI in the training corpus)
// against the typical winner's utility in the NAICS-4 — clamped to
// [1/3, 3] odds so it can never zero anyone out or crown anyone king.
// A client with no public history gets the honest answer: somewhat
// below the typical winner, bounded.
//
// Everything here is read-only against the persisted priors/model —
// cheap enough for the scoring worker's sweep, with an in-process TTL
// cache on the hot lookups.
// =============================================================

import { prisma } from '../../config/database'
import { logger } from '../../utils/logger'
import { lookupPrior } from './priorBuilder'
import { bucketFromOpportunitySetAside } from './setAside'
import { candidateFeatures, buildHistories, FEATURE_NAMES } from './whoWinsTrainer'
import { utility } from './conditionalLogit'

const CACHE_TTL_MS = 10 * 60 * 1000
const ODDS_CLAMP = 3 // adjustment bounded to [1/3, 3] odds (docs §1)

interface ActiveModel {
  version: string
  beta: number[]
  means: number[]
  sds: number[]
  segmentMeanUtility: Record<string, number>
  globalMeanUtility: number
}

let modelCache: { value: ActiveModel | null; expiresAt: number } | null = null
const priorCache = new Map<string, { value: SegmentPrior | null; expiresAt: number }>()

interface SegmentPrior {
  pBase: number
  segmentLevel: string
  naicsPrefix: string
  awardCount: number
  meanOffers: number | null
}

export interface PublicWinPriorResult {
  pWin: number
  pBase: number
  adjustmentOdds: number
  expectedOffers: number | null
  segmentLevel: string
  segmentAwardCount: number
  modelVersion: string
}

export async function getActiveWhoWinsModel(): Promise<ActiveModel | null> {
  if (modelCache && modelCache.expiresAt > Date.now()) return modelCache.value
  const row = await prisma.whoWinsModel.findFirst({ where: { status: 'ACTIVE' } })
  let value: ActiveModel | null = null
  if (row) {
    const coefficients = row.coefficients as Record<string, number>
    const featureStats = row.featureStats as Record<string, { mean: number; sd: number }>
    const cfg = row.trainingConfig as { segmentMeanUtility?: Record<string, number>; globalMeanUtility?: number }
    value = {
      version: row.version,
      beta: FEATURE_NAMES.map((n) => coefficients[n] ?? 0),
      means: FEATURE_NAMES.map((n) => featureStats[n]?.mean ?? 0),
      sds: FEATURE_NAMES.map((n) => featureStats[n]?.sd ?? 1),
      segmentMeanUtility: cfg.segmentMeanUtility ?? {},
      globalMeanUtility: cfg.globalMeanUtility ?? 0,
    }
  }
  modelCache = { value, expiresAt: Date.now() + CACHE_TTL_MS }
  return value
}

/** Test hook — drop the in-process caches. */
export function resetWhoWinsCaches(): void {
  modelCache = null
  priorCache.clear()
}

async function segmentPrior(modelVersion: string, naicsCode: string, setAsideType: string | null): Promise<SegmentPrior | null> {
  const bucket = bucketFromOpportunitySetAside(setAsideType)
  const key = `${modelVersion}|${naicsCode.slice(0, 6)}|${bucket}`
  const hit = priorCache.get(key)
  if (hit && hit.expiresAt > Date.now()) return hit.value

  const row = await lookupPrior(modelVersion, naicsCode, bucket)
  const value: SegmentPrior | null = row
    ? {
        // The calibrated level, kept inside sane probability bounds.
        pBase: Math.min(0.9, Math.max(0.02, row.shrunkMeanInvOffers)),
        segmentLevel: row.segmentLevel,
        naicsPrefix: row.naicsPrefix,
        awardCount: row.awardCount,
        meanOffers: row.meanOffers,
      }
    : null
  priorCache.set(key, { value, expiresAt: Date.now() + CACHE_TTL_MS })
  return value
}

const logit = (p: number) => Math.log(p / (1 - p))
const sigma = (z: number) => 1 / (1 + Math.exp(-z))

/**
 * The prior for (opportunity, client). Returns null when no ACTIVE model /
 * priors exist — callers treat null as "feature unavailable", never as 0.
 */
export async function getPublicWinPrior(params: {
  opportunityNaics: string | null
  opportunitySetAside: string | null
  opportunityAgencyName: string | null
  opportunityEstimatedValue: number | null
  clientUei: string | null
}): Promise<PublicWinPriorResult | null> {
  try {
    const naics = (params.opportunityNaics ?? '').replace(/\D/g, '')
    if (naics.length < 2) return null

    const model = await getActiveWhoWinsModel()
    if (!model) return null

    const seg = await segmentPrior(model.version, naics, params.opportunitySetAside)
    if (!seg) return null

    // Relative-strength adjustment from the client's real public history.
    let adjustmentOdds = 1
    const naics4 = naics.slice(0, 4)
    const clientUei = (params.clientUei ?? '').trim().toUpperCase()
    if (/^[A-Z0-9]{12}$/.test(clientUei)) {
      // Pull the client's public awards once and reuse the training feature
      // builder — identical feature semantics to training time.
      const clientAwards = await prisma.publicAwardTraining.findMany({
        where: { OR: [{ recipientUei: clientUei }, { recipientParentUei: clientUei }] },
        select: {
          naicsCode: true, agencyCode: true, setAsideCode: true, offersReceived: true,
          recipientUei: true, recipientParentUei: true, obligatedAmount: true, actionDate: true, fiscalYear: true,
        },
        orderBy: { actionDate: 'asc' },
        take: 2000,
      })
      // Resolve the opportunity's agency NAME (SAM.gov string) to an FPDS
      // agency CODE via the training table — exact case-insensitive match
      // only; a fuzzy join would be noise. No match ⇒ feature reads 0.
      let agencyCode: string | null = null
      if (params.opportunityAgencyName?.trim()) {
        const match = await prisma.publicAwardTraining.findFirst({
          where: { agencyName: { equals: params.opportunityAgencyName.trim(), mode: 'insensitive' } },
          select: { agencyCode: true },
        })
        agencyCode = match?.agencyCode ?? null
      }

      const histories = buildHistories(
        clientAwards.map((r) => ({ ...r, obligatedAmount: Number(r.obligatedAmount) })),
      )
      const feats = candidateFeatures(histories, clientUei, {
        naics4,
        agencyCode,
        bucket: bucketFromOpportunitySetAside(params.opportunitySetAside),
        amount: params.opportunityEstimatedValue ?? 0,
        time: Date.now(),
      })
      const clientU = utility(feats, model.beta, model.means, model.sds)
      const refU = model.segmentMeanUtility[naics4] ?? model.globalMeanUtility
      adjustmentOdds = Math.exp(Math.max(-Math.log(ODDS_CLAMP), Math.min(Math.log(ODDS_CLAMP), clientU - refU)))
    } else {
      // No public history: an unproven entrant sits below the typical winner.
      // Zero-features vs the reference utility, same clamp.
      const zeroU = utility([0, 0, 0, -3, 0], model.beta, model.means, model.sds)
      const refU = model.segmentMeanUtility[naics4] ?? model.globalMeanUtility
      adjustmentOdds = Math.exp(Math.max(-Math.log(ODDS_CLAMP), Math.min(Math.log(ODDS_CLAMP), zeroU - refU)))
    }

    const pWin = Math.min(0.95, Math.max(0.01, sigma(logit(seg.pBase) + Math.log(adjustmentOdds))))
    return {
      pWin,
      pBase: seg.pBase,
      adjustmentOdds,
      expectedOffers: seg.meanOffers,
      segmentLevel: seg.segmentLevel,
      segmentAwardCount: seg.awardCount,
      modelVersion: model.version,
    }
  } catch (err) {
    // The prior is an enhancement — a failure must never break scoring.
    logger.warn('publicWinPrior lookup failed — scoring continues without it', {
      error: (err as Error).message,
    })
    return null
  }
}

/**
 * Blend the calibrated prior with the heuristic score in LOG-ODDS space
 * (docs §6). The prior is the only calibrated component, so it sets the
 * level (w defaults 0.75); the heuristic perturbs within it. Re-fit w by
 * Platt-style stacking once ≥100 real WON/LOST outcomes exist.
 */
export function blendWithPrior(heuristicP: number, priorP: number, w: number): number {
  const h = Math.min(0.98, Math.max(0.02, heuristicP))
  const p = Math.min(0.98, Math.max(0.02, priorP))
  return sigma(w * logit(p) + (1 - w) * logit(h))
}
