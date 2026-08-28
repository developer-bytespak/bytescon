// =============================================================
// FAR Context Builder — the regulatory frame every AI inference
// is grounded in. Returns a deterministic, hashed FarContext
// snapshot for an (opportunity, scope) tuple.
//
// The hash is what makes the FAR-foundational pattern work:
//   - LLM cache keys include it (correctness-safe caching)
//   - Audit events record it (every inference is replayable)
//   - Two inferences with the same hash MUST be reproducible
//     against the same regulatory snapshot.
// =============================================================
import * as crypto from 'crypto'
import { prisma } from '../../config/database'
import {
  ClauseRecord,
  findApplicableForOpportunity,
  findPrerequisites,
  inferCmmcLevel,
  inferSection508Required,
  OpportunityProfile,
} from './farCatalogService'

export type FarScope =
  | 'REQUIREMENT_EXTRACTION'
  | 'BID_DECISION'
  | 'COMPLIANCE_MATRIX'
  | 'PROPOSAL_OUTLINE'
  | 'PROPOSAL_DRAFT'
  | 'BID_GUIDANCE'
  | 'AI_ASSISTANT'
  | 'COST_VOLUME'
  | 'SUBCONTRACT'

export interface ClauseRef {
  source: 'FAR' | 'DFARS'
  code: string
  title: string
  summary: string | null
  isBlocking: boolean
  flowDownRequired: boolean
}

export interface FarContext {
  scope: FarScope
  opportunityId: string
  agency: string
  naicsCode: string | null
  setAsideType: string | null
  estimatedValue: number | null
  contractType: string
  isCommercialItem: boolean
  applicableFarClauses: ClauseRef[]
  applicableDfarsClauses: ClauseRef[]
  blockingPrerequisites: ClauseRef[]
  flowDownCandidates: ClauseRef[]
  prohibitedClauseCodes: string[]
  cmmcLevel: number | null
  section508Required: boolean
  costPrincipleAlerts: string[] // FAR 31 hooks active for cost-volume scope
  generatedAt: string
  hash: string
}

function toRef(rec: ClauseRecord): ClauseRef {
  return {
    source: rec.source as 'FAR' | 'DFARS',
    code: rec.code,
    title: rec.title,
    summary: rec.summary,
    isBlocking: rec.isBlocking,
    flowDownRequired: rec.flowDownRequired,
  }
}

function hashContext(ctx: Omit<FarContext, 'hash' | 'generatedAt'>): string {
  // Deterministic JSON: sorted keys, no Date objects.
  const stable = JSON.stringify(ctx, Object.keys(ctx).sort())
  return crypto.createHash('sha256').update(stable).digest('hex').slice(0, 32)
}

/**
 * Build the FarContext for an opportunity + scope. Cheap (one Prisma
 * read for the opportunity; the catalog is in-memory cached).
 */
export async function buildContext(opportunityId: string, scope: FarScope): Promise<FarContext> {
  const opp = await prisma.opportunity.findUnique({
    where: { id: opportunityId },
    select: {
      id: true,
      agency: true,
      naicsCode: true,
      setAsideType: true,
      estimatedValue: true,
      vehicleType: true,
      marketCategory: true,
    },
  })

  if (!opp) {
    throw new Error(`buildContext: opportunity ${opportunityId} not found`)
  }

  const profile: OpportunityProfile = {
    agency: opp.agency,
    naicsCode: opp.naicsCode || null,
    setAsideType: opp.setAsideType || null,
    estimatedValue: opp.estimatedValue ? Number(opp.estimatedValue) : null,
    contractType: inferContractType(opp.vehicleType, opp.marketCategory),
    isCommercialItem: opp.marketCategory === 'COMMERCIAL',
  }

  const applicable = await findApplicableForOpportunity(profile)

  // Resolve blocking prerequisites: clauses with isBlocking=true,
  // PLUS any prerequisites those clauses pull in.
  const blockingSet = new Map<string, ClauseRecord>()
  for (const c of applicable.blocking) {
    blockingSet.set(`${c.source}:${c.code}`, c)
    const prereqs = await findPrerequisites(c.code, c.source as 'FAR' | 'DFARS')
    for (const p of prereqs) {
      blockingSet.set(`${p.source}:${p.code}`, p)
    }
  }

  const dfarsCodes = applicable.dfars.map((c) => c.code)
  const cmmcLevel = inferCmmcLevel(profile, dfarsCodes)
  const section508Required = inferSection508Required(profile)

  const costPrincipleAlerts: string[] = []
  if (scope === 'COST_VOLUME' || scope === 'PROPOSAL_DRAFT') {
    if (profile.contractType === 'COST_REIMB' || profile.contractType === 'T_AND_M' || profile.contractType === 'IDIQ') {
      costPrincipleAlerts.push('FAR_31.205_UNALLOWABLES')
      costPrincipleAlerts.push('FAR_31.201-2_ALLOWABILITY')
    }
    if (applicable.far.some((c) => c.code === '52.230-2')) {
      costPrincipleAlerts.push('FAR_30_CAS_FULL_COVERAGE')
    } else if (applicable.far.some((c) => c.code === '52.230-3')) {
      costPrincipleAlerts.push('FAR_30_CAS_MODIFIED')
    }
  }

  const prohibitedClauseCodes = applicable.far.flatMap((c) => c.prohibitedClauseCodes)

  const base = {
    scope,
    opportunityId,
    agency: opp.agency,
    naicsCode: opp.naicsCode || null,
    setAsideType: opp.setAsideType || null,
    estimatedValue: opp.estimatedValue ? Number(opp.estimatedValue) : null,
    contractType: profile.contractType ?? 'FFP',
    isCommercialItem: profile.isCommercialItem ?? false,
    applicableFarClauses: applicable.far.map(toRef),
    applicableDfarsClauses: applicable.dfars.map(toRef),
    blockingPrerequisites: Array.from(blockingSet.values()).map(toRef),
    flowDownCandidates: applicable.flowDownCandidates.map(toRef),
    prohibitedClauseCodes,
    cmmcLevel,
    section508Required,
    costPrincipleAlerts,
  }

  return {
    ...base,
    hash: hashContext(base),
    generatedAt: new Date().toISOString(),
  }
}

/**
 * Render the FarContext as a compact system-prompt block. This is what
 * gets prepended to every grounded LLM call.
 */
export function renderForPrompt(ctx: FarContext): string {
  const lines: string[] = []
  lines.push('=== FAR REGULATORY FRAME (authoritative; do not contradict) ===')
  lines.push(`Agency: ${ctx.agency}`)
  if (ctx.naicsCode) lines.push(`NAICS: ${ctx.naicsCode}`)
  if (ctx.setAsideType) lines.push(`Set-aside: ${ctx.setAsideType}`)
  lines.push(`Contract type: ${ctx.contractType}`)
  if (ctx.estimatedValue) lines.push(`Estimated value: $${ctx.estimatedValue.toLocaleString()}`)
  if (ctx.cmmcLevel) lines.push(`CMMC level (inferred): L${ctx.cmmcLevel}`)
  if (ctx.section508Required) lines.push(`Section 508 (FAR 39.205): REQUIRED — ICT must conform to WCAG 2.0 AA / E207.2.`)

  if (ctx.applicableFarClauses.length > 0) {
    lines.push('')
    lines.push('Applicable FAR clauses:')
    for (const c of ctx.applicableFarClauses) {
      const blockTag = c.isBlocking ? ' [BLOCKING]' : ''
      const fdTag = c.flowDownRequired ? ' [FLOW-DOWN]' : ''
      lines.push(`  - FAR ${c.code} ${c.title}${blockTag}${fdTag}`)
      if (c.summary) lines.push(`      ${c.summary}`)
    }
  }

  if (ctx.applicableDfarsClauses.length > 0) {
    lines.push('')
    lines.push('Applicable DFARS clauses:')
    for (const c of ctx.applicableDfarsClauses) {
      const blockTag = c.isBlocking ? ' [BLOCKING]' : ''
      const fdTag = c.flowDownRequired ? ' [FLOW-DOWN]' : ''
      lines.push(`  - DFARS ${c.code} ${c.title}${blockTag}${fdTag}`)
      if (c.summary) lines.push(`      ${c.summary}`)
    }
  }

  if (ctx.blockingPrerequisites.length > 0) {
    lines.push('')
    lines.push('Blocking prerequisites (firm must satisfy before bidding):')
    for (const c of ctx.blockingPrerequisites) {
      lines.push(`  - ${c.source} ${c.code} — ${c.title}`)
    }
  }

  if (ctx.costPrincipleAlerts.length > 0) {
    lines.push('')
    lines.push(`Cost-principle alerts: ${ctx.costPrincipleAlerts.join(', ')}`)
    lines.push('FAR 31.205 unallowable categories include entertainment, lobbying, alcohol, bad debts, first-class travel, and contingency reserves.')
  }

  lines.push('')
  lines.push('GROUNDING RULES:')
  lines.push('1. You may not assert past performance, customer names, contract values, or compliance certifications unless the user-provided context supplies an evidence ID. If unsupported, emit `[EVIDENCE_NEEDED: <description>]`.')
  lines.push('2. You may not contradict any clause listed above. If the user request would require contradicting a blocking clause, refuse and explain which clause blocks it.')
  lines.push('3. Cite specific FAR/DFARS clause numbers when making compliance claims.')
  lines.push('=== END FAR REGULATORY FRAME ===')
  lines.push('')

  return lines.join('\n')
}

// -------------------------------------------------------------
// Helpers
// -------------------------------------------------------------

function inferContractType(vehicleType: string | null, marketCategory: string | null): string {
  // SAM.gov vehicleType is "GWAC" | "IDIQ" | "BPA" | "MAS" | "BOA" or null.
  // marketCategory is "SERVICES" | "COMMERCIAL" | "LOGISTICS" etc.
  if (vehicleType === 'IDIQ' || vehicleType === 'GWAC' || vehicleType === 'MAS') return 'IDIQ'
  if (vehicleType === 'BPA' || vehicleType === 'BOA') return 'BPA'
  if (marketCategory === 'COMMERCIAL') return 'COMMERCIAL'
  // Most small-biz set-asides default to firm fixed price
  return 'FFP'
}
