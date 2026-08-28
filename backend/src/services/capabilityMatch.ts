// =============================================================
// §6.1E — Capability-based matching.
//
// Replaces keyword-only ranking as the PRIMARY matching method. Keyword
// similarity survives as one weighted dimension among eight, and it can never
// carry a match on its own.
//
// Dimensions: capability · NAICS · PSC · certification/set-aside ·
//             past performance · geography · contract vehicle · keyword
//
// Honesty rules encoded here:
//  - A dimension with no data is ABSENT (null), never zero. Weights are
//    renormalised across the dimensions that actually have data, so a firm is
//    not penalised for a field the source never published.
//  - Capabilities are never invented — only stored FirmCapability rows count.
//  - Certification eligibility comes from §6.1F, which refuses to count an
//    expired certification.
//  - When too few dimensions are assessable the result is flagged
//    hasSufficientData = false and the UI shows an insufficient-data state.
// =============================================================
import { EligibilityState } from '@prisma/client'
import { EligibilityResult } from './setAsideEligibility'

export const MATCH_METHOD = 'capability-match-v1'
export const METHOD_VERSION = 'v1'
/** Below this many assessable dimensions the score is not presented as reliable. */
export const MIN_ASSESSABLE_DIMENSIONS = 3

export const DIMENSION_WEIGHTS = {
  capability: 0.28,
  naics: 0.18,
  psc: 0.10,
  certification: 0.14,
  pastPerformance: 0.12,
  geography: 0.06,
  vehicle: 0.06,
  keyword: 0.06,
} as const

export type DimensionKey = keyof typeof DIMENSION_WEIGHTS

/**
 * A complete weighting over the eight dimensions.
 *
 * §7.2 allows a firm's ADMIN to apply a learned pursuit-preference adjustment,
 * which supplies an alternative map here. The dimensions themselves never
 * change — only their relative weight — so the algorithm, its evidence and its
 * absent-data rules are identical either way.
 */
export type DimensionWeights = Record<DimensionKey, number>

/** How the weighting used for a computation was arrived at. */
export type WeightProfile = 'BASE' | 'PURSUIT_ADJUSTED'

export interface CapabilityInput {
  id: string
  name: string
  category: string
  keywords: string[]
  naicsCodes: string[]
  pscCodes: string[]
  geographies: string[]
  contractVehicles: string[]
  concurrentCapacity: number | null
  capacityNote: string | null
  verification: string
}

export interface PastPerformanceInput {
  id: string
  naicsCode: string | null
  pscCode: string | null
  agency: string | null
  isArchived: boolean
  verificationStatus: string
}

export interface MatchOpportunityInput {
  id: string
  title: string
  description: string | null
  agency: string
  naicsCode: string
  psc: string | null
  setAsideType: string
  placeOfPerformance: string | null
  contractVehicle: string | null
}

export interface MatchFirmInput {
  capabilities: CapabilityInput[]
  registrationNaics: string[]
  pastPerformance: PastPerformanceInput[]
  /** Active pursuits, used only to surface a capacity warning. */
  activePursuitCount: number
}

export interface DimensionScore {
  key: DimensionKey
  /** Null = not assessable from available data. Never coerced to zero. */
  score: number | null
  /** The weight actually used. Differs from baseWeight only under an applied adjustment. */
  weight: number
  /** The unadjusted Section 6 weight, so any learned influence stays visible. */
  baseWeight: number
  evidence: string
  /** Why the dimension is absent, when it is. */
  absentReason?: string
}

export interface CapabilityMatchResult {
  overallScore: number
  dimensions: DimensionScore[]
  matchedCapabilityIds: string[]
  missingCapabilities: string[]
  capacityWarning: string | null
  dataLimitations: string[]
  hasSufficientData: boolean
  matchMethod: string
  methodVersion: string
  /** BASE, or PURSUIT_ADJUSTED when an ADMIN has applied a learned adjustment. */
  weightProfile: WeightProfile
  /** The applied PursuitFeedbackSignal, when one is in force. Null otherwise. */
  appliedSignalId: string | null
  /** The score the same inputs produce under the unadjusted base weighting. */
  baseOverallScore: number
}

export interface WeightingOptions {
  weights?: DimensionWeights
  weightProfile?: WeightProfile
  appliedSignalId?: string | null
}

const STOP_WORDS = new Set([
  'the', 'and', 'for', 'of', 'to', 'a', 'an', 'in', 'on', 'with', 'or', 'by', 'at',
  'services', 'service', 'support', 'contract', 'shall', 'will', 'this', 'that', 'from',
])

export function tokenize(text: string): Set<string> {
  return new Set(
    text.toLowerCase().replace(/[^a-z0-9\s]/g, ' ').split(/\s+/).filter((t) => t.length > 2 && !STOP_WORDS.has(t)),
  )
}

/** Length of the shared NAICS prefix, normalized to 0..1 over 6 digits. */
export function naicsPrefixScore(firmCodes: string[], target: string): number | null {
  if (!target || firmCodes.length === 0) return null
  let best = 0
  for (const code of firmCodes) {
    let shared = 0
    for (let i = 0; i < Math.min(code.length, target.length, 6); i++) {
      if (code[i] === target[i]) shared++
      else break
    }
    best = Math.max(best, shared)
  }
  // A 2-digit sector match is weak; a full 6-digit match is exact.
  return Number((Math.min(best, 6) / 6).toFixed(4))
}

export function pscScore(firmCodes: string[], target: string | null): number | null {
  if (!target || firmCodes.length === 0) return null
  const t = target.toUpperCase()
  let best = 0
  for (const raw of firmCodes) {
    const code = raw.toUpperCase()
    if (code === t) return 1
    // PSC groups by leading characters: first char = category, first two = group.
    if (code.length >= 2 && t.length >= 2 && code.slice(0, 2) === t.slice(0, 2)) best = Math.max(best, 0.7)
    else if (code[0] === t[0]) best = Math.max(best, 0.4)
  }
  return Number(best.toFixed(4))
}

function geographyScore(firmGeos: string[], place: string | null): number | null {
  if (!place) return null
  if (firmGeos.length === 0) return null
  const p = place.toLowerCase()
  for (const geo of firmGeos) {
    const g = geo.toLowerCase().trim()
    if (!g) continue
    // "Nationwide" / "CONUS" is a declared capability to perform anywhere.
    if (/^(nationwide|conus|us|usa|united states|all)$/.test(g)) return 1
    if (p.includes(g) || g.includes(p)) return 1
  }
  return 0
}

function vehicleScore(firmVehicles: string[], vehicle: string | null): number | null {
  if (!vehicle) return null
  if (firmVehicles.length === 0) return null
  const v = vehicle.toLowerCase()
  return firmVehicles.some((fv) => {
    const f = fv.toLowerCase().trim()
    return Boolean(f) && (v.includes(f) || f.includes(v))
  }) ? 1 : 0
}

function eligibilityToScore(state: EligibilityState): number | null {
  switch (state) {
    case EligibilityState.ELIGIBLE: return 1
    case EligibilityState.POSSIBLY_ELIGIBLE: return 0.5
    case EligibilityState.EXPIRING_BEFORE_DEADLINE: return 0.35
    case EligibilityState.NOT_ELIGIBLE: return 0
    // Absent data must not be scored as a zero.
    case EligibilityState.INSUFFICIENT_DATA: return null
    default: return null
  }
}

/**
 * Deterministic, explainable capability match. Pure: no I/O, so identical
 * inputs always produce an identical result.
 *
 * `weighting` is optional and defaults to the canonical Section 6 weights, so
 * every existing caller behaves exactly as before. When a firm's ADMIN has
 * applied a §7.2 pursuit-preference adjustment the caller passes it here; the
 * dimensions, evidence and absent-data rules are untouched and only the
 * relative weighting changes. The unadjusted score is always computed alongside
 * so the learned influence stays visible rather than hidden.
 */
export function computeCapabilityMatch(
  opportunity: MatchOpportunityInput,
  firm: MatchFirmInput,
  eligibility: EligibilityResult,
  weighting: WeightingOptions = {},
): CapabilityMatchResult {
  const w: DimensionWeights = weighting.weights ?? { ...DIMENSION_WEIGHTS }
  const dimensions: DimensionScore[] = []
  const dataLimitations: string[] = []

  const usableCapabilities = firm.capabilities.filter((c) => c.verification !== 'REJECTED')
  const oppText = `${opportunity.title} ${opportunity.description ?? ''}`
  const oppTokens = tokenize(oppText)

  // --- capability -------------------------------------------------
  const matchedCapabilityIds: string[] = []
  const missingCapabilities: string[] = []
  if (usableCapabilities.length === 0) {
    dimensions.push({
      key: 'capability', score: null, weight: w.capability, baseWeight: DIMENSION_WEIGHTS.capability,
      evidence: 'No capability records exist for this firm.',
      absentReason: 'The capability library is empty, so capability overlap cannot be assessed.',
    })
    dataLimitations.push('No capabilities are recorded, so the primary matching dimension could not be assessed.')
  } else {
    let hits = 0
    for (const cap of usableCapabilities) {
      const capTokens = new Set<string>([...tokenize(cap.name), ...cap.keywords.flatMap((k) => [...tokenize(k)])])
      const naicsHit = cap.naicsCodes.some((c) => opportunity.naicsCode.startsWith(c) || c.startsWith(opportunity.naicsCode))
      const pscHit = Boolean(opportunity.psc) && cap.pscCodes.some((c) => c.toUpperCase() === opportunity.psc!.toUpperCase())
      let overlap = 0
      capTokens.forEach((t) => { if (oppTokens.has(t)) overlap++ })
      const tokenHit = capTokens.size > 0 && overlap / capTokens.size >= 0.25

      if (naicsHit || pscHit || tokenHit) {
        matchedCapabilityIds.push(cap.id)
        hits++
      } else {
        missingCapabilities.push(cap.name)
      }
    }
    const score = Number((hits / usableCapabilities.length).toFixed(4))
    dimensions.push({
      key: 'capability', score, weight: w.capability, baseWeight: DIMENSION_WEIGHTS.capability,
      evidence: `${hits} of ${usableCapabilities.length} recorded capabilities align with this notice by NAICS, PSC or scope wording.`,
    })
    const unverified = usableCapabilities.filter((c) => c.verification === 'UNVERIFIED').length
    if (unverified > 0) dataLimitations.push(`${unverified} matched capability record(s) are unverified.`)
  }

  // --- NAICS ------------------------------------------------------
  const firmNaics = [...new Set([...firm.registrationNaics, ...usableCapabilities.flatMap((c) => c.naicsCodes)])]
  const naics = naicsPrefixScore(firmNaics, opportunity.naicsCode)
  dimensions.push({
    key: 'naics', score: naics, weight: w.naics, baseWeight: DIMENSION_WEIGHTS.naics,
    evidence: naics === null
      ? 'No firm NAICS codes recorded, or the notice has no NAICS code.'
      : `Best NAICS prefix overlap with ${opportunity.naicsCode} scores ${(naics * 100).toFixed(0)}%.`,
    ...(naics === null ? { absentReason: 'NAICS is absent on one side, so the dimension is excluded rather than scored zero.' } : {}),
  })
  if (naics === null) dataLimitations.push('NAICS fit could not be assessed.')

  // --- PSC --------------------------------------------------------
  const firmPsc = [...new Set(usableCapabilities.flatMap((c) => c.pscCodes))]
  const psc = pscScore(firmPsc, opportunity.psc)
  dimensions.push({
    key: 'psc', score: psc, weight: w.psc, baseWeight: DIMENSION_WEIGHTS.psc,
    evidence: psc === null
      ? 'The notice has no PSC, or no firm PSC codes are recorded.'
      : `PSC ${opportunity.psc} scores ${(psc * 100).toFixed(0)}% against recorded PSC coverage.`,
    ...(psc === null ? { absentReason: 'PSC absent on one side; excluded from the weighted score.' } : {}),
  })

  // --- certification / set-aside ----------------------------------
  const certScore = eligibilityToScore(eligibility.state)
  dimensions.push({
    key: 'certification', score: certScore, weight: w.certification, baseWeight: DIMENSION_WEIGHTS.certification,
    evidence: eligibility.reason,
    ...(certScore === null ? { absentReason: 'Eligibility could not be determined from stored records.' } : {}),
  })
  if (certScore === null) dataLimitations.push('Set-aside eligibility could not be determined from stored records.')

  // --- past performance -------------------------------------------
  const usablePp = firm.pastPerformance.filter((p) => !p.isArchived)
  if (usablePp.length === 0) {
    dimensions.push({
      key: 'pastPerformance', score: null, weight: w.pastPerformance, baseWeight: DIMENSION_WEIGHTS.pastPerformance,
      evidence: 'No past-performance records available.',
      absentReason: 'No past-performance records exist, so relevance cannot be assessed.',
    })
    dataLimitations.push('No past-performance records were available to assess relevance.')
  } else {
    let best = 0
    for (const pp of usablePp) {
      let s = 0
      if (pp.naicsCode && opportunity.naicsCode) {
        const shared = naicsPrefixScore([pp.naicsCode], opportunity.naicsCode) ?? 0
        s = Math.max(s, shared)
      }
      if (pp.pscCode && opportunity.psc && pp.pscCode.toUpperCase() === opportunity.psc.toUpperCase()) s = Math.max(s, 0.9)
      if (pp.agency && pp.agency.toLowerCase() === opportunity.agency.toLowerCase()) s = Math.max(s, Math.min(1, s + 0.25))
      best = Math.max(best, s)
    }
    dimensions.push({
      key: 'pastPerformance', score: Number(best.toFixed(4)), weight: w.pastPerformance, baseWeight: DIMENSION_WEIGHTS.pastPerformance,
      evidence: `Closest of ${usablePp.length} past-performance record(s) scores ${(best * 100).toFixed(0)}% on NAICS, PSC and agency relevance.`,
    })
  }

  // --- geography ---------------------------------------------------
  const firmGeos = [...new Set(usableCapabilities.flatMap((c) => c.geographies))]
  const geo = geographyScore(firmGeos, opportunity.placeOfPerformance)
  dimensions.push({
    key: 'geography', score: geo, weight: w.geography, baseWeight: DIMENSION_WEIGHTS.geography,
    evidence: geo === null
      ? 'The notice has no place of performance, or no firm geographies are recorded.'
      : geo === 1 ? `Recorded coverage includes ${opportunity.placeOfPerformance}.` : `No recorded coverage for ${opportunity.placeOfPerformance}.`,
    ...(geo === null ? { absentReason: 'Place of performance absent on one side; excluded from the weighted score.' } : {}),
  })

  // --- contract vehicle --------------------------------------------
  const firmVehicles = [...new Set(usableCapabilities.flatMap((c) => c.contractVehicles))]
  const veh = vehicleScore(firmVehicles, opportunity.contractVehicle)
  dimensions.push({
    key: 'vehicle', score: veh, weight: w.vehicle, baseWeight: DIMENSION_WEIGHTS.vehicle,
    evidence: veh === null
      ? 'The notice names no contract vehicle, or no firm vehicles are recorded.'
      : veh === 1 ? `Recorded vehicle access covers ${opportunity.contractVehicle}.` : `No recorded access to ${opportunity.contractVehicle}.`,
    ...(veh === null ? { absentReason: 'Contract vehicle absent on one side; excluded from the weighted score.' } : {}),
  })

  // --- keyword (one input among many, never the whole match) --------
  const allKeywords = new Set<string>(usableCapabilities.flatMap((c) => [...tokenize(c.name), ...c.keywords.flatMap((k) => [...tokenize(k)])]))
  let keyword: number | null = null
  if (allKeywords.size > 0 && oppTokens.size > 0) {
    let overlap = 0
    allKeywords.forEach((t) => { if (oppTokens.has(t)) overlap++ })
    keyword = Number((overlap / allKeywords.size).toFixed(4))
  }
  dimensions.push({
    key: 'keyword', score: keyword, weight: w.keyword, baseWeight: DIMENSION_WEIGHTS.keyword,
    evidence: keyword === null
      ? 'No capability keywords, or no usable notice text, to compare.'
      : `${(keyword * 100).toFixed(0)}% of capability keywords appear in the notice text. Keyword overlap is one input of eight and cannot carry a match on its own.`,
    ...(keyword === null ? { absentReason: 'No keywords or notice text to compare.' } : {}),
  })

  // --- weighted total over ASSESSABLE dimensions only ---------------
  const assessable = dimensions.filter((d) => d.score !== null)
  const totalWeight = assessable.reduce((sum, d) => sum + d.weight, 0)
  const overallScore = totalWeight === 0
    ? 0
    : Math.round((assessable.reduce((sum, d) => sum + (d.score as number) * d.weight, 0) / totalWeight) * 100)

  // The same inputs under the unadjusted base weighting. Reported alongside so
  // an applied learned adjustment can always be seen rather than inferred.
  const baseTotalWeight = assessable.reduce((sum, d) => sum + d.baseWeight, 0)
  const baseOverallScore = baseTotalWeight === 0
    ? 0
    : Math.round((assessable.reduce((sum, d) => sum + (d.score as number) * d.baseWeight, 0) / baseTotalWeight) * 100)

  // --- capacity -----------------------------------------------------
  let capacityWarning: string | null = null
  const capacityCaps = usableCapabilities.filter((c) => typeof c.concurrentCapacity === 'number' && c.concurrentCapacity !== null)
  if (capacityCaps.length > 0) {
    const cap = Math.min(...capacityCaps.map((c) => c.concurrentCapacity as number))
    if (firm.activePursuitCount >= cap) {
      capacityWarning = `You have ${firm.activePursuitCount} active pursuit(s) against a recorded concurrent capacity of ${cap}. Adding this pursuit may exceed stated capacity.`
    }
  }
  const capacityNotes = usableCapabilities.map((c) => c.capacityNote).filter((n): n is string => Boolean(n))
  if (!capacityWarning && capacityNotes.length > 0) capacityWarning = capacityNotes[0]

  const hasSufficientData = assessable.length >= MIN_ASSESSABLE_DIMENSIONS
  if (!hasSufficientData) {
    dataLimitations.unshift(
      `Only ${assessable.length} of ${dimensions.length} matching dimensions could be assessed (minimum ${MIN_ASSESSABLE_DIMENSIONS}). Treat this score as indicative only.`,
    )
  }

  return {
    overallScore,
    dimensions,
    matchedCapabilityIds,
    missingCapabilities,
    capacityWarning,
    dataLimitations,
    hasSufficientData,
    matchMethod: MATCH_METHOD,
    methodVersion: METHOD_VERSION,
    weightProfile: weighting.weightProfile ?? 'BASE',
    appliedSignalId: weighting.appliedSignalId ?? null,
    baseOverallScore,
  }
}

/** Convenience accessor for persisting per-dimension sub-scores. */
export function dimensionScore(result: CapabilityMatchResult, key: DimensionKey): number | null {
  const d = result.dimensions.find((x) => x.key === key)
  if (!d || d.score === null) return null
  return Math.round(d.score * 100)
}
