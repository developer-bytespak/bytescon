// =============================================================
// Compliance Gap Analysis Service
// Scans opportunity text for FAR/DFARS clauses and identifies
// gaps in client capability/documentation requirements.
// =============================================================

import { prisma } from '../config/database'

// -------------------------------------------------------------
// FAR/DFARS Clause Library
// Most common clauses encountered in federal opportunities
// -------------------------------------------------------------

export interface ClauseDefinition {
  code: string
  category: 'FAR' | 'DFARS'
  title: string
  shortDescription: string
  plainLanguage: string
  requirementType: 'CERTIFICATION' | 'CAPABILITY' | 'DOCUMENTATION' | 'COMPLIANCE'
  documentNeeded?: string
  severity: 'CRITICAL' | 'HIGH' | 'MEDIUM' | 'LOW'
}

export const CLAUSE_LIBRARY: ClauseDefinition[] = [
  {
    code: 'FAR 52.204-7',
    category: 'FAR',
    title: 'System for Award Management',
    shortDescription: 'Active SAM.gov registration required',
    plainLanguage: 'You must have an active registration in SAM.gov (System for Award Management). Registration must be current—not expired or in renewal.',
    requirementType: 'CERTIFICATION',
    documentNeeded: 'SAM.gov registration confirmation (UEI number)',
    severity: 'CRITICAL',
  },
  {
    code: 'FAR 52.204-10',
    category: 'FAR',
    title: 'Reporting Executive Compensation',
    shortDescription: 'Disclose executive compensation if applicable',
    plainLanguage: 'If you receive 80%+ of revenue from federal contracts AND that revenue exceeds $25M, you must disclose top 5 executive compensation in SAM.gov.',
    requirementType: 'COMPLIANCE',
    severity: 'MEDIUM',
  },
  {
    code: 'FAR 52.219-14',
    category: 'FAR',
    title: 'Limitations on Subcontracting',
    shortDescription: 'Prime contractor must perform minimum % of work',
    plainLanguage: 'For services contracts, you must perform at least 50% of the cost of the contract personnel with your own employees (not subs). For supply contracts, 50% of cost of manufacturing.',
    requirementType: 'CAPABILITY',
    severity: 'HIGH',
  },
  {
    code: 'FAR 52.219-28',
    category: 'FAR',
    title: 'Post-Award Small Business Representation',
    shortDescription: 'Maintain small business status during contract',
    plainLanguage: 'You must remain a small business under the assigned NAICS code throughout the contract. If your status changes (e.g., revenue grows beyond size standard), you must notify the contracting officer.',
    requirementType: 'CERTIFICATION',
    severity: 'HIGH',
  },
  {
    code: 'FAR 52.222-50',
    category: 'FAR',
    title: 'Combating Trafficking in Persons',
    shortDescription: 'Anti-trafficking compliance plan required',
    plainLanguage: 'You must have a compliance plan and certify your subcontractors do not engage in human trafficking. Required for all federal contracts.',
    requirementType: 'DOCUMENTATION',
    documentNeeded: 'Anti-trafficking compliance plan and policy',
    severity: 'MEDIUM',
  },
  {
    code: 'FAR 52.225-5',
    category: 'FAR',
    title: 'Trade Agreements Act',
    shortDescription: 'End products must come from designated countries',
    plainLanguage: 'Products you supply must be made in the U.S. or a country with a U.S. trade agreement (specific list). Excludes most non-WTO countries.',
    requirementType: 'COMPLIANCE',
    severity: 'HIGH',
  },
  {
    code: 'FAR 52.232-33',
    category: 'FAR',
    title: 'Payment by EFT - SAM',
    shortDescription: 'Electronic Funds Transfer required for payment',
    plainLanguage: 'You must accept payment via Electronic Funds Transfer (EFT). Banking info goes in your SAM.gov profile.',
    requirementType: 'COMPLIANCE',
    severity: 'LOW',
  },
  {
    code: 'DFARS 252.204-7012',
    category: 'DFARS',
    title: 'Safeguarding Covered Defense Information',
    shortDescription: 'NIST SP 800-171 cybersecurity controls required',
    plainLanguage: 'If you handle Controlled Unclassified Information (CUI) for DoD, you must implement NIST SP 800-171 cybersecurity controls (110 specific requirements) and report cyber incidents within 72 hours.',
    requirementType: 'CAPABILITY',
    documentNeeded: 'NIST SP 800-171 System Security Plan (SSP) and POA&M',
    severity: 'CRITICAL',
  },
  {
    code: 'DFARS 252.204-7019',
    category: 'DFARS',
    title: 'NIST SP 800-171 DoD Assessment',
    shortDescription: 'Self-assessment score must be in SPRS',
    plainLanguage: 'You must complete a NIST SP 800-171 self-assessment and submit your score (-203 to 110) to DoD\'s Supplier Performance Risk System (SPRS) before contract award.',
    requirementType: 'CERTIFICATION',
    documentNeeded: 'SPRS-submitted assessment score',
    severity: 'CRITICAL',
  },
  {
    code: 'DFARS 252.225-7001',
    category: 'DFARS',
    title: 'Buy American and Balance of Payments',
    shortDescription: 'Defense items must be domestic-end products',
    plainLanguage: 'For DoD contracts, manufactured items must use domestic components or qualifying country components (with limited exceptions for non-availability).',
    requirementType: 'COMPLIANCE',
    severity: 'HIGH',
  },
  {
    code: 'DFARS 252.227-7013',
    category: 'DFARS',
    title: 'Rights in Technical Data — Noncommercial',
    shortDescription: 'Government rights to your technical data',
    plainLanguage: 'The government gets unlimited rights to technical data developed exclusively with government funds, restricted rights for mixed-funded data, and limited rights for privately-developed data.',
    requirementType: 'DOCUMENTATION',
    documentNeeded: 'Asserted rights list and data markings',
    severity: 'MEDIUM',
  },
  {
    code: 'FAR 52.219-9',
    category: 'FAR',
    title: 'Small Business Subcontracting Plan',
    shortDescription: 'Required for contracts > $750K',
    plainLanguage: 'For large business prime contracts over $750K (or $1.5M for construction), you must submit a Small Business Subcontracting Plan with goals for SB, SDB, WOSB, HUBZone, SDVOSB, and VOSB.',
    requirementType: 'DOCUMENTATION',
    documentNeeded: 'Small Business Subcontracting Plan',
    severity: 'HIGH',
  },
]

// -------------------------------------------------------------
// Set-aside specific requirements
// -------------------------------------------------------------

const SET_ASIDE_CAPABILITIES: Record<string, { name: string; cert: string; plain: string }> = {
  SDVOSB: {
    name: 'Service-Disabled Veteran-Owned Small Business',
    cert: 'VetCert (formerly SBA VOSB Verification)',
    plain: 'Owner must be a service-disabled veteran (rated 0%+) who controls daily operations. Must be verified through SBA VetCert program.',
  },
  VOSB: {
    name: 'Veteran-Owned Small Business',
    cert: 'VetCert (SBA Veteran Small Business Certification)',
    plain: 'At least 51% owned and controlled by one or more veterans (no disability rating required). Must be verified through SBA VetCert.',
  },
  WOSB: {
    name: 'Woman-Owned Small Business',
    cert: 'SBA WOSB certification (or third-party)',
    plain: 'At least 51% owned and controlled by women who are U.S. citizens, with at least one woman managing daily operations.',
  },
  EDWOSB: {
    name: 'Economically Disadvantaged Woman-Owned Small Business',
    cert: 'SBA EDWOSB certification',
    plain: 'WOSB-qualified plus owners must meet personal net-worth, income, and asset thresholds (economically disadvantaged criteria).',
  },
  HUBZONE: {
    name: 'HUBZone Small Business',
    cert: 'SBA HUBZone certification',
    plain: 'Principal office in a HUBZone, 35%+ employees living in HUBZones, and ownership by U.S. citizens.',
  },
  SBA_8A: {
    name: '8(a) Business Development',
    cert: 'SBA 8(a) certification',
    plain: '9-year program for small businesses owned by socially & economically disadvantaged individuals. Provides set-aside contracts and mentorship.',
  },
  SMALL_BUSINESS: {
    name: 'Small Business',
    cert: 'SAM.gov small business representation',
    plain: 'Must be at or below the SBA size standard for the assigned NAICS code (revenue or employee count).',
  },
  TOTAL_SMALL_BUSINESS: {
    name: 'Total Small Business Set-Aside',
    cert: 'SAM.gov small business representation',
    plain: 'Restricted to small businesses at or below the SBA size standard for the assigned NAICS code. No additional ownership certification required beyond SAM.gov self-representation.',
  },
  INDIAN: {
    name: 'Indian Economic Enterprise / Buy Indian',
    cert: 'BIA Indian Economic Enterprise certification',
    plain: 'Owned by enrolled members of a federally recognized tribe or by an Indian-owned economic enterprise. Verified through BIA.',
  },
}

// -------------------------------------------------------------
// Analysis function
// -------------------------------------------------------------

export interface ComplianceGap {
  clauseCode: string
  category: 'FAR' | 'DFARS' | 'SET_ASIDE' | 'OTHER'
  title: string
  shortDescription: string
  plainLanguage: string
  requirementType: string
  documentNeeded?: string
  severity: 'CRITICAL' | 'HIGH' | 'MEDIUM' | 'LOW'
  detected: boolean
  status: 'GAP' | 'MET' | 'UNKNOWN'
  recommendation: string
  // Phase 5D: source attribution — KEYWORD, AI, or BOTH
  detectedBy?: 'KEYWORD' | 'AI' | 'BOTH'
  aiConfidence?: number
  aiExcerpt?: string
}

export interface ComplianceAnalysisResult {
  opportunityId: string
  opportunityTitle: string
  agency: string
  setAsideType: string | null
  totalClauses: number
  criticalGaps: number
  highGaps: number
  mediumGaps: number
  lowGaps: number
  gaps: ComplianceGap[]
  recommendations: string[]
  // Phase 5D: AI extraction metadata
  aiExtraction?: {
    enabled: boolean
    modelUsed: string
    tokensUsed: number
    cached: boolean
    aiOnlyClauseCount: number
  }
}

export async function analyzeOpportunityCompliance(
  opportunityId: string,
  consultingFirmId: string,
  opts: { useAi?: boolean } = {}
): Promise<ComplianceAnalysisResult> {
  const opp = await prisma.opportunity.findFirst({
    where: { id: opportunityId, consultingFirmId },
    select: {
      id: true,
      title: true,
      agency: true,
      description: true,
      setAsideType: true,
      naicsCode: true,
      estimatedValue: true,
    },
  })

  if (!opp) {
    throw new Error('Opportunity not found')
  }

  const rawText = [opp.title, opp.description || '', opp.agency].join(' ')
  const text = rawText.toLowerCase()
  // Normalized text — collapses every internal whitespace, dot, and dash
  // between FAR/DFARS prefixes and their digit blocks so the matcher
  // catches "FAR.52.204-7", "FAR  52.204-7", "FAR-52-204-7", "FAR52.204-7",
  // etc. Audit finding #23 — keyword matching was previously brittle to
  // typos and OCR noise in solicitation PDFs.
  const normalizedText = normalizeClauseText(text)
  const isDoD = opp.agency.toLowerCase().match(/defense|army|navy|air force|marine|dod|space force/)
  const value = Number(opp.estimatedValue || 0)

  const gaps: ComplianceGap[] = []

  // Scan clause library
  for (const clause of CLAUSE_LIBRARY) {
    const needle = normalizeClauseText(clause.code.toLowerCase())
    const codeMatch =
      text.includes(clause.code.toLowerCase()) ||
      text.includes(clause.code.replace(/\s/g, '').toLowerCase()) ||
      normalizedText.includes(needle)
    const isDFARSandNotDoD = clause.category === 'DFARS' && !isDoD

    // Skip DFARS if not a DoD agency (unless explicitly mentioned)
    if (isDFARSandNotDoD && !codeMatch) continue

    let detected = codeMatch
    let status: 'GAP' | 'MET' | 'UNKNOWN' = 'UNKNOWN'
    let recommendation = `Review ${clause.code} requirements before bidding.`

    // Heuristics
    if (clause.code === 'FAR 52.219-9' && value < 750_000) {
      continue // Not applicable below threshold
    }
    if (clause.code === 'FAR 52.219-9' && value >= 750_000) {
      detected = true
      status = 'GAP'
      // Audit finding #24: FAR 52.219-9 only applies to OTHER-THAN-SMALL
      // primes. Small-biz primes are exempt. Without a client context in
      // this analyzer we can't auto-resolve, so we flag the gap AND make
      // the exemption explicit in the recommendation.
      recommendation = 'Prepare Small Business Subcontracting Plan with goals before submission. (Exempt if bidder is itself a small business under the solicitation NAICS size standard — verify size status before drafting.)'
    }
    if (clause.code === 'DFARS 252.204-7012' && isDoD) {
      detected = true
      status = 'GAP'
      recommendation = 'Implement NIST SP 800-171 controls and document SSP/POA&M before bidding.'
    }
    if (clause.code === 'DFARS 252.204-7019' && isDoD) {
      detected = true
      status = 'GAP'
      recommendation = 'Complete and submit NIST SP 800-171 self-assessment to SPRS.'
    }
    if (clause.code === 'FAR 52.204-7') {
      detected = true
      status = 'UNKNOWN' // Can't verify SAM.gov from here
      recommendation = 'Verify SAM.gov registration is active before bidding.'
    }
    if (codeMatch) {
      detected = true
      status = 'GAP'
    }

    if (detected) {
      gaps.push({
        clauseCode: clause.code,
        category: clause.category,
        title: clause.title,
        shortDescription: clause.shortDescription,
        plainLanguage: clause.plainLanguage,
        requirementType: clause.requirementType,
        documentNeeded: clause.documentNeeded,
        severity: clause.severity,
        detected,
        status,
        recommendation,
      })
    }
  }

  // Set-aside requirements
  if (opp.setAsideType && opp.setAsideType !== 'NONE' && SET_ASIDE_CAPABILITIES[opp.setAsideType]) {
    const sa = SET_ASIDE_CAPABILITIES[opp.setAsideType]
    gaps.push({
      clauseCode: opp.setAsideType,
      category: 'SET_ASIDE',
      title: sa.name,
      shortDescription: `Requires ${sa.cert}`,
      plainLanguage: sa.plain,
      requirementType: 'CERTIFICATION',
      documentNeeded: sa.cert,
      severity: 'CRITICAL',
      detected: true,
      status: 'GAP',
      recommendation: `Verify ${sa.cert} is active and current before bidding.`,
    })
  }

  // Aggregate counts
  const criticalGaps = gaps.filter(g => g.severity === 'CRITICAL').length
  const highGaps = gaps.filter(g => g.severity === 'HIGH').length
  const mediumGaps = gaps.filter(g => g.severity === 'MEDIUM').length
  const lowGaps = gaps.filter(g => g.severity === 'LOW').length

  // Source attribution: existing keyword-detected gaps default to KEYWORD
  for (const gap of gaps) {
    if (!gap.detectedBy && gap.category !== 'SET_ASIDE') {
      gap.detectedBy = 'KEYWORD'
    }
  }

  // Phase 5D: Optionally augment with AI clause extraction
  let aiMeta: ComplianceAnalysisResult['aiExtraction'] = undefined
  if (opts.useAi) {
    try {
      // Lazy import to keep keyword-only path lean (no Redis touch when unused)
      const { extractClausesFromOpportunity } = await import('./aiClauseExtractor')
      const extraction = await extractClausesFromOpportunity(opportunityId, consultingFirmId)

      let aiOnlyCount = 0
      const existingByCode = new Map(gaps.map(g => [g.clauseCode, g]))

      for (const aiClause of extraction.clauses) {
        const existing = existingByCode.get(aiClause.clauseCode)
        if (existing) {
          // Merge: mark as detected by both, attach AI evidence
          existing.detectedBy = 'BOTH'
          existing.aiConfidence = aiClause.confidence
          existing.aiExcerpt = aiClause.excerpt
        } else {
          // AI found a clause not in our keyword library — add as OTHER severity MEDIUM
          gaps.push({
            clauseCode: aiClause.clauseCode,
            category: aiClause.category === 'OTHER' ? 'OTHER' : aiClause.category,
            title: aiClause.clauseCode,
            shortDescription: 'AI-detected clause reference',
            plainLanguage: `AI extracted this clause from the solicitation. Look up exact requirements in the FAR/DFARS reference. Excerpt: "${aiClause.excerpt}"`,
            requirementType: 'COMPLIANCE',
            severity: 'MEDIUM',
            detected: true,
            status: 'GAP',
            recommendation: `Review ${aiClause.clauseCode} requirements before bidding (AI-detected — verify against current FAR/DFARS).`,
            detectedBy: 'AI',
            aiConfidence: aiClause.confidence,
            aiExcerpt: aiClause.excerpt,
          })
          aiOnlyCount++
        }
      }

      aiMeta = {
        enabled: true,
        modelUsed: extraction.modelUsed,
        tokensUsed: extraction.tokensUsed,
        cached: extraction.cached,
        aiOnlyClauseCount: aiOnlyCount,
      }
    } catch (err: any) {
      // AI is best-effort — never break the keyword analysis
      aiMeta = {
        enabled: false,
        modelUsed: 'error',
        tokensUsed: 0,
        cached: false,
        aiOnlyClauseCount: 0,
      }
    }
  }

  // Recompute counts after possible AI additions
  const finalCritical = gaps.filter(g => g.severity === 'CRITICAL').length
  const finalHigh = gaps.filter(g => g.severity === 'HIGH').length
  const finalMedium = gaps.filter(g => g.severity === 'MEDIUM').length
  const finalLow = gaps.filter(g => g.severity === 'LOW').length

  // Summary recommendations
  const recommendations: string[] = []
  if (finalCritical > 0) {
    recommendations.push(`⚠️ ${finalCritical} CRITICAL requirement${finalCritical === 1 ? '' : 's'} must be met before bidding.`)
  }
  if (finalHigh > 0) {
    recommendations.push(`📋 ${finalHigh} HIGH-priority requirement${finalHigh === 1 ? '' : 's'} require preparation.`)
  }
  if (gaps.some(g => g.documentNeeded)) {
    recommendations.push('📁 Prepare required documents in advance — most cannot be obtained quickly.')
  }
  if (isDoD) {
    recommendations.push('🛡️ DoD opportunity: Ensure NIST SP 800-171 / CMMC compliance is up to date.')
  }
  if (opp.setAsideType && opp.setAsideType !== 'NONE') {
    recommendations.push(`✓ Set-aside: ${opp.setAsideType} — confirm certification status in SAM.gov.`)
  }
  if (aiMeta && aiMeta.aiOnlyClauseCount > 0) {
    recommendations.push(`🤖 ${aiMeta.aiOnlyClauseCount} additional clause${aiMeta.aiOnlyClauseCount === 1 ? '' : 's'} detected by AI — review evidence excerpts.`)
  }

  return {
    opportunityId: opp.id,
    opportunityTitle: opp.title,
    agency: opp.agency,
    setAsideType: opp.setAsideType,
    totalClauses: gaps.length,
    criticalGaps: finalCritical,
    highGaps: finalHigh,
    mediumGaps: finalMedium,
    lowGaps: finalLow,
    gaps: gaps.sort((a, b) => {
      const order = { CRITICAL: 0, HIGH: 1, MEDIUM: 2, LOW: 3 }
      return order[a.severity] - order[b.severity]
    }),
    recommendations,
    aiExtraction: aiMeta,
  }
}

/**
 * Collapse whitespace, dots, and dashes inside clause-code text so the
 * matcher tolerates the dozens of formats solicitations use in the wild:
 *   "FAR 52.204-7", "FAR.52.204-7", "FAR-52-204-7", "FAR  52.204 -7",
 *   "FAR52.204.7", "far 52.204 - 7" — all map to "far52204-7" after
 *   prefix normalization. The trailing dash before the final digit block
 *   is preserved as a single dash so "52.204-7" can't collide with a
 *   different clause "52.2047" if such a thing ever existed.
 */
function normalizeClauseText(input: string): string {
  return input
    // Compress runs of whitespace/dots between the prefix letters and
    // the first digit block, e.g. "FAR . 52" → "FAR52", "DFARS - 252" → "DFARS252".
    .replace(/\b(far|dfars)\s*[.\s-]+\s*(\d)/gi, '$1$2')
    // Then collapse any remaining whitespace inside the numeric span.
    .replace(/(\d)\s+(\d)/g, '$1$2')
    // Collapse internal dots between digit groups: "52.204" → "52204".
    .replace(/(\d)\.(\d)/g, '$1$2')
}
