// =============================================================
// Partner ⇄ opportunity capability matching (§5.1 Stage 4). Pure, deterministic,
// and explainable — extends the existing /recommend scoring (NAICS / set-aside /
// capabilities / track record) with matching + missing capabilities, certification
// fit, geography fit, an honest "why recommended" narrative, data limitations, and
// an insufficient-data flag. It only uses STORED partner + opportunity data — no
// fabricated capabilities, and it never claims a partner is guaranteed to qualify.
// =============================================================

export interface MatchPartner {
  id: string
  name: string
  uei: string | null
  cmmcLevel: number | null
  primaryNaicsCodes: string[]
  primarySetAsides: string[]
  capabilities: string[]
  certifications: string[]
  geography: string | null
}

export interface MatchOpportunity {
  naicsCode: string
  setAsideType: string
  title: string
  description: string | null
  placeOfPerformance: string | null
}

export interface MatchPriorContext {
  // opportunityIds this partner has previously teamed on
  priorOppIds: Set<string>
  // opportunityIds that were WON (any teamed bid)
  wonOppIds: Set<string>
}

export interface MatchFactor { factor: string; points: number; detail: string }
export type FitLevel = 'FULL' | 'PARTIAL' | 'NONE' | 'UNKNOWN'

export interface PartnerMatchResult {
  partnerId: string
  name: string
  uei: string | null
  cmmcLevel: number | null
  score: number // 0-100
  factors: MatchFactor[]
  matchingCapabilities: string[]
  missingRequirements: string[]
  certificationFit: { required: string | null; met: boolean; detail: string }
  geographyFit: { level: FitLevel; detail: string }
  whyRecommended: string
  dataLimitations: string[]
  insufficientData: boolean
}

function twoDigit(code: string): string {
  return (code || '').replace(/[^0-9]/g, '').slice(0, 2)
}
function norm(s: string): string {
  return s.toLowerCase().trim()
}

export function matchPartnerToOpportunity(p: MatchPartner, opp: MatchOpportunity, prior: MatchPriorContext): PartnerMatchResult {
  const factors: MatchFactor[] = []
  const dataLimitations: string[] = []
  const missingRequirements: string[] = []

  const haystack = `${opp.title} ${opp.description ?? ''}`.toLowerCase()
  const oppSector = twoDigit(opp.naicsCode)
  const hasSetAside = !!opp.setAsideType && opp.setAsideType !== 'NONE'

  // --- NAICS (0-40) ---
  let naicsPts = 0
  let naicsDetail = 'no NAICS overlap'
  if (opp.naicsCode && p.primaryNaicsCodes.includes(opp.naicsCode)) {
    naicsPts = 40
    naicsDetail = `exact NAICS ${opp.naicsCode}`
  } else if (oppSector && p.primaryNaicsCodes.some((c) => twoDigit(c) === oppSector)) {
    naicsPts = 20
    naicsDetail = `same NAICS sector ${oppSector}`
  } else if (opp.naicsCode) {
    missingRequirements.push(`NAICS ${opp.naicsCode} not in partner's primary codes`)
  }
  factors.push({ factor: 'NAICS', points: naicsPts, detail: naicsDetail })

  // --- Set-aside / certification (0-25) ---
  let saPts = 0
  let saDetail = 'set-aside not matched'
  let certMet = false
  if (!hasSetAside) {
    saPts = 10
    saDetail = 'opportunity is unrestricted'
    certMet = true
  } else if (p.primarySetAsides.includes(opp.setAsideType) || p.certifications.includes(opp.setAsideType)) {
    saPts = 25
    saDetail = `carries ${opp.setAsideType}`
    certMet = true
  } else {
    missingRequirements.push(`does not carry the ${opp.setAsideType} set-aside`)
  }
  factors.push({ factor: 'Set-aside', points: saPts, detail: saDetail })
  const certificationFit = {
    required: hasSetAside ? opp.setAsideType : null,
    met: certMet,
    detail: hasSetAside ? (certMet ? `partner carries ${opp.setAsideType}` : `partner does not carry ${opp.setAsideType}`) : 'opportunity has no set-aside requirement',
  }

  // --- Capabilities (0-25) ---
  const matchingCapabilities = p.capabilities.filter((c) => c.trim() && haystack.includes(norm(c)))
  const capPts = Math.min(25, matchingCapabilities.length * 10)
  factors.push({
    factor: 'Capabilities',
    points: capPts,
    detail: matchingCapabilities.length ? `matches: ${matchingCapabilities.join(', ')}` : 'no capability keywords matched',
  })
  // Capabilities the partner lists but which do NOT appear in the notice text —
  // shown as "not evidenced" rather than "missing", since the opportunity has no
  // structured capability requirement list (a stated data limitation).
  dataLimitations.push('Capability matching is keyword-based against the notice title/description, not a structured requirement list.')

  // --- Track record (0-10) ---
  let trackPts = 0
  let trackDetail = 'no prior teaming'
  if (prior.priorOppIds.size) {
    const wonWith = [...prior.priorOppIds].some((oId) => prior.wonOppIds.has(oId))
    trackPts = wonWith ? 10 : 5
    trackDetail = wonWith ? 'won a prior bid together' : 'teamed before'
  }
  factors.push({ factor: 'Track record', points: trackPts, detail: trackDetail })

  // --- Geography fit (informational, not scored) ---
  let geoLevel: FitLevel = 'UNKNOWN'
  let geoDetail = 'partner geography or place of performance not recorded'
  if (p.geography && opp.placeOfPerformance) {
    const g = norm(p.geography)
    const pop = norm(opp.placeOfPerformance)
    if (pop.includes(g) || g.includes(pop) || g.split(/[,;/]/).some((t) => t.trim() && pop.includes(t.trim()))) {
      geoLevel = 'FULL'
      geoDetail = `partner geography "${p.geography}" overlaps place of performance "${opp.placeOfPerformance}"`
    } else {
      geoLevel = 'NONE'
      geoDetail = `no overlap between partner geography and "${opp.placeOfPerformance}"`
    }
  } else {
    if (!p.geography) dataLimitations.push('Partner geography is not recorded.')
    if (!opp.placeOfPerformance) dataLimitations.push('Opportunity place of performance is not recorded.')
  }
  const geographyFit = { level: geoLevel, detail: geoDetail }

  const score = naicsPts + saPts + capPts + trackPts

  // Insufficient data when there is essentially nothing to match on.
  const insufficientData = p.primaryNaicsCodes.length === 0 && p.capabilities.length === 0 && p.primarySetAsides.length === 0 && p.certifications.length === 0

  const positives: string[] = []
  if (naicsPts >= 40) positives.push('exact NAICS match')
  else if (naicsPts > 0) positives.push('same NAICS sector')
  if (saPts === 25) positives.push(`holds the ${opp.setAsideType} set-aside`)
  if (matchingCapabilities.length) positives.push(`${matchingCapabilities.length} matching capabilit${matchingCapabilities.length === 1 ? 'y' : 'ies'}`)
  if (trackPts) positives.push(trackDetail)
  const whyRecommended = insufficientData
    ? 'Insufficient partner data to assess fit — add NAICS codes, capabilities, or certifications.'
    : positives.length
      ? `Recommended based on ${positives.join('; ')}. Historical fit signal only — not a guarantee the partner qualifies.`
      : 'Low fit on the recorded signals; review manually before teaming.'

  return {
    partnerId: p.id, name: p.name, uei: p.uei, cmmcLevel: p.cmmcLevel,
    score, factors, matchingCapabilities, missingRequirements, certificationFit, geographyFit,
    whyRecommended, dataLimitations: Array.from(new Set(dataLimitations)), insufficientData,
  }
}
