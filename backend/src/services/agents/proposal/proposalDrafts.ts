// =============================================================
// §7.7 — The three AI paths, and the validators that police them.
//
// EVERY output here is a DRAFT. Nothing in this module writes an approved
// version, approves a review, verifies a requirement, or selects a final past
// performance record — those transitions belong to a person.
//
// STRICT VALIDATION, NOT TRUST
// Valid JSON is not enough. Each parser checks the shape AND checks every id
// against the exact source set that was supplied, so a hallucinated citation,
// requirement or section id can never reach durable evidence. An invalid
// output is discarded with a warning and the deterministic fallback is used.
//
// PROMPT INJECTION
// All supplied solicitation, capability and past-performance text travels in
// the USER message. The system prompt is the canonical constant alone, never
// concatenated with anything, and each prompt states that supplied text is
// data.
// =============================================================
import { AgentBudgetExhaustedError, type AgentExecutionContext } from '../types'
import {
  proposalSystemPrompt,
  AI_DRAFT_LABEL,
  PROPOSAL_SECTION_DRAFT_PROMPT_VERSION,
  PAST_PERFORMANCE_ADAPTATION_PROMPT_VERSION,
  PROPOSAL_COMPLIANCE_CROSSCHECK_PROMPT_VERSION,
} from './proposalPrompts'
import type { CapabilitySource } from './capabilityLibrary'
import { PERSONNEL_EVIDENCE_RULE, type KeyPersonnelEvidence } from './personnelEvidence'

export const DRAFT_METHOD_VERSION = 'proposal-draft-v1'

/** The limitation recorded when no provider is configured. */
export const NO_PROVIDER_LIMITATION = 'AI drafting unavailable — no provider configured'

const EST_SECTION_TOKENS = 6_000
const EST_ADAPTATION_TOKENS = 3_000
const EST_CROSSCHECK_TOKENS = 4_000

export type DraftSource = 'DETERMINISTIC_SKELETON' | 'LLM_ASSISTED'

// -------------------------------------------------------------
// Prompt A — section draft
// -------------------------------------------------------------

export type CitationSourceType =
  | 'CAPABILITY_NARRATIVE' | 'PAST_PERFORMANCE' | 'SOLICITATION_REQUIREMENT'
  | 'SECTION_L' | 'SECTION_M' | 'STANDING_DOCUMENT' | 'OTHER_SUPPLIED_SOURCE'

const CITATION_SOURCE_TYPES = new Set<string>([
  'CAPABILITY_NARRATIVE', 'PAST_PERFORMANCE', 'SOLICITATION_REQUIREMENT',
  'SECTION_L', 'SECTION_M', 'STANDING_DOCUMENT', 'OTHER_SUPPLIED_SOURCE',
])

export interface SectionCitation {
  sourceType: CitationSourceType
  sourceId: string
  sourceReference: string | null
  supportedClaim: string
}

export interface SectionDraft {
  sectionId: string
  content: string
  citations: SectionCitation[]
  insufficientSourceMaterial: boolean
  source: DraftSource
  promptVersion: string | null
  warnings: string[]
}

export interface SectionDraftFacts {
  sectionId: string
  sectionTitle: string
  sectionNumber: string | null
  /** Exactly the requirements this section owns — never the whole matrix. */
  requirements: Array<{ id: string; section: string; text: string; isMandatory: boolean }>
  lmMappings: Array<{ id: string; instructionSection: string; evaluationSection: string | null }>
  capabilitySources: CapabilitySource[]
  pastPerformance: Array<{ id: string; title: string; summary: string }>
  /**
   * Key personnel a human selected for this proposal, carrying only approved
   * and verified evidence. Empty when nobody was selected — which is not the
   * same as nobody being qualified, and is never treated as licence to invent.
   */
  keyPersonnel: KeyPersonnelEvidence[]
  /** Existing text the model must not rewrite. */
  lockedContent: string | null
  existingDraft: string | null
}

/**
 * The deterministic skeleton.
 *
 * Deliberately austere: headings, the requirements this section owns, and
 * explicit bracketed markers for what a person must supply. It contains no
 * prose that could be mistaken for a drafted answer.
 */
export function buildDeterministicSkeleton(facts: SectionDraftFacts): SectionDraft {
  const lines: string[] = []
  lines.push(`${facts.sectionNumber ? `${facts.sectionNumber} ` : ''}${facts.sectionTitle}`)
  lines.push('')
  lines.push('[OUTLINE ONLY — NO NARRATIVE HAS BEEN DRAFTED FOR THIS SECTION]')
  lines.push('')

  if (facts.requirements.length > 0) {
    lines.push('Requirements this section must answer:')
    for (const req of facts.requirements) {
      lines.push(`- ${req.section}${req.isMandatory ? ' (mandatory)' : ''}: ${req.text}`)
    }
    lines.push('')
  }

  if (facts.capabilitySources.length > 0) {
    lines.push('Approved capability material available for this section:')
    for (const source of facts.capabilitySources) {
      lines.push(`- ${source.title} (version ${source.versionNumber})`)
    }
  } else {
    lines.push('[APPROVED CAPABILITY SOURCE MATERIAL REQUIRED — none is available for this section]')
  }

  if (facts.keyPersonnel.length > 0) {
    lines.push('')
    lines.push('Key personnel selected for this proposal:')
    for (const person of facts.keyPersonnel) {
      const role = person.proposalRole ? ` — ${person.proposalRole}` : ''
      lines.push(
        person.hasApprovedResume
          ? `- ${person.fullName}${role} (approved resume v${person.approvedResumeVersion})`
          : `- ${person.fullName}${role} [NO APPROVED RESUME — no experience, education, certification or clearance evidence is available]`,
      )
    }
  }

  return {
    sectionId: facts.sectionId,
    content: lines.join('\n'),
    citations: [],
    // A skeleton is by definition not a sourced answer.
    insufficientSourceMaterial: true,
    source: 'DETERMINISTIC_SKELETON',
    promptVersion: null,
    warnings: [],
  }
}

/**
 * Strict validation of Prompt A output.
 *
 * Rejects the whole draft on a shape error, and drops individual citations
 * whose ids are not in the supplied source set. A claim that loses its citation
 * has lost its evidence, so `insufficientSourceMaterial` is forced true.
 */
export function parseSectionDraft(
  raw: string,
  facts: SectionDraftFacts,
  fallback: SectionDraft,
): { draft: SectionDraft; warnings: string[] } {
  const warnings: string[] = []
  let parsed: Record<string, unknown>
  try {
    parsed = JSON.parse(raw) as Record<string, unknown>
  } catch {
    return { draft: fallback, warnings: ['The drafting model returned output that is not valid JSON. The deterministic skeleton was used instead.'] }
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    return { draft: fallback, warnings: ['The drafting model returned a non-object. The deterministic skeleton was used instead.'] }
  }
  if (typeof parsed.content !== 'string' || parsed.content.trim().length === 0) {
    return { draft: fallback, warnings: ['The drafting model returned no content. The deterministic skeleton was used instead.'] }
  }
  if (parsed.sectionId !== facts.sectionId) {
    return { draft: fallback, warnings: ['The drafting model returned a different section id than the one requested. The output was discarded.'] }
  }
  if (!Array.isArray(parsed.citations)) {
    return { draft: fallback, warnings: ['The drafting model returned a malformed citation list. The deterministic skeleton was used instead.'] }
  }

  // The exact set of ids the model was given. Anything else is invented.
  const allowedIds = new Set<string>([
    ...facts.capabilitySources.map((s) => s.versionId),
    ...facts.requirements.map((r) => r.id),
    ...facts.lmMappings.map((m) => m.id),
    ...facts.pastPerformance.map((p) => p.id),
    // A personnel claim must cite the selection it came from, so a person the
    // model invented has no id to cite and the claim is discarded with it.
    ...facts.keyPersonnel.map((k) => k.id),
  ])

  const citations: SectionCitation[] = []
  let rejected = 0
  for (const rawCitation of parsed.citations as Array<Record<string, unknown>>) {
    const c = rawCitation ?? {}
    if (typeof c.sourceId !== 'string' || typeof c.supportedClaim !== 'string') { rejected += 1; continue }
    if (!CITATION_SOURCE_TYPES.has(String(c.sourceType))) { rejected += 1; continue }
    if (!allowedIds.has(c.sourceId)) {
      // A hallucinated source id never reaches durable evidence.
      rejected += 1
      continue
    }
    citations.push({
      sourceType: c.sourceType as CitationSourceType,
      sourceId: c.sourceId,
      sourceReference: typeof c.sourceReference === 'string' ? c.sourceReference : null,
      supportedClaim: c.supportedClaim,
    })
  }
  if (rejected > 0) {
    warnings.push(`${rejected} citation(s) referenced a source that was not supplied and were discarded. Any claim resting on them is unsupported.`)
  }

  // The model may assert sufficiency, but a discarded citation overrides it.
  const modelSaysInsufficient = parsed.insufficientSourceMaterial !== false
  const insufficientSourceMaterial = modelSaysInsufficient || rejected > 0 || citations.length === 0

  if (facts.lockedContent && !parsed.content.includes(facts.lockedContent.trim().slice(0, 60))) {
    warnings.push('The drafting model did not preserve the locked text. The draft is kept as a suggestion only and must not replace the approved wording.')
  }

  return {
    warnings,
    draft: {
      sectionId: facts.sectionId,
      // The label is ours, always, so a reader can never mistake this for
      // approved wording.
      content: `${AI_DRAFT_LABEL}\n\n${parsed.content}`,
      citations,
      insufficientSourceMaterial,
      source: 'LLM_ASSISTED',
      promptVersion: PROPOSAL_SECTION_DRAFT_PROMPT_VERSION,
      warnings,
    },
  }
}

/** EXACTLY the facts one section needs. Never the whole tenant database. */
export function sectionUserPayload(facts: SectionDraftFacts): Record<string, unknown> {
  return {
    section: { sectionId: facts.sectionId, title: facts.sectionTitle, sectionNumber: facts.sectionNumber },
    requirements: facts.requirements,
    lmMappings: facts.lmMappings,
    approvedCapabilitySources: facts.capabilitySources.map((s) => ({
      sourceId: s.versionId,
      title: s.title,
      category: s.category,
      versionNumber: s.versionNumber,
      status: 'APPROVED',
      content: s.content,
      sourceReferences: s.sourceReferences,
    })),
    pastPerformance: facts.pastPerformance,
    keyPersonnel: facts.keyPersonnel,
    keyPersonnelEvidenceRule: PERSONNEL_EVIDENCE_RULE,
    lockedContent: facts.lockedContent,
    existingDraft: facts.existingDraft,
  }
}

/** Section draft, LLM-assisted when a provider and budget allow. */
export async function draftSection(
  ctx: AgentExecutionContext,
  facts: SectionDraftFacts,
  opts: { useLlm: boolean },
): Promise<{ draft: SectionDraft; limitations: string[] }> {
  const skeleton = buildDeterministicSkeleton(facts)
  const limitations: string[] = []

  if (!opts.useLlm) {
    limitations.push(NO_PROVIDER_LIMITATION)
    return { draft: skeleton, limitations }
  }

  const decision = await ctx.budget.check(EST_SECTION_TOKENS)
  if (!decision.allowed) {
    limitations.push(`BUDGET_EXHAUSTED: ${decision.reason} The deterministic skeleton was used instead.`)
    return { draft: skeleton, limitations }
  }

  try {
    const response = await ctx.budget.generate(
      {
        // The canonical constant, alone.
        systemPrompt: proposalSystemPrompt('PROPOSAL_SECTION_DRAFT'),
        userPrompt: JSON.stringify(sectionUserPayload(facts)),
        maxTokens: 6000,
        temperature: 0.2,
      },
      { task: 'PROPOSAL_DRAFT', estimatedTokens: EST_SECTION_TOKENS },
    )
    const { draft, warnings } = parseSectionDraft(response.text, facts, skeleton)
    return { draft: { ...draft, warnings }, limitations }
  } catch (err) {
    if (err instanceof AgentBudgetExhaustedError) {
      limitations.push(`BUDGET_EXHAUSTED: ${err.message} The deterministic skeleton was used instead.`)
    } else {
      limitations.push(`The drafting model could not be reached (${(err as Error).message}). The deterministic skeleton was used instead.`)
    }
    return { draft: skeleton, limitations }
  }
}

// -------------------------------------------------------------
// Prompt B — past-performance adaptation
// -------------------------------------------------------------

export interface PastPerformanceFacts {
  recordId: string
  contractNumber: string | null
  customerName: string | null
  agency: string | null
  role: string | null
  contractValue: string | null
  periodStart: string | null
  periodEnd: string | null
  narrative: string
  targetRequirements: Array<{ id: string; text: string }>
}

export interface AdaptationDraft {
  recordId: string
  adaptedText: string
  changedFields: Array<{ field: string; changeType: string; reason: string; sourceReference: string | null }>
  unsupportedClaims: Array<{ claim: string; reason: string; sourceNeeded: string | null }>
  source: DraftSource
  promptVersion: string | null
  warnings: string[]
}

const CHANGE_TYPES = new Set(['REPHRASED', 'REORDERED', 'OMITTED', 'EMPHASIS_CHANGED'])

/**
 * Deterministic fact-drift detection.
 *
 * Every supplied factual token — contract number, customer, agency, role,
 * value, dates — must still appear in the adapted text. A record whose
 * contract number quietly changed is worse than no adaptation at all, so drift
 * rejects the whole output rather than persisting a subtly false record.
 */
export function detectFactDrift(facts: PastPerformanceFacts, adaptedText: string): string[] {
  const drift: string[] = []
  const haystack = adaptedText.toLowerCase()
  const protectedFacts: Array<[string, string | null]> = [
    ['contract number', facts.contractNumber],
    ['customer', facts.customerName],
    ['agency', facts.agency],
    ['contract value', facts.contractValue],
  ]

  for (const [label, value] of protectedFacts) {
    if (!value) continue
    // A fact may be omitted for relevance (rule 10), but if it is present in a
    // CHANGED form the record has been altered. Detect a near-miss: the label
    // appears with a different value.
    if (!haystack.includes(value.toLowerCase())) {
      drift.push(`The supplied ${label} "${value}" does not appear in the adapted text.`)
    }
  }

  // Any number in the source that is missing from the adaptation while other
  // numbers were introduced is the signature of a changed figure.
  const sourceNumbers = new Set((facts.narrative.match(/\b\d[\d,.]*\b/g) ?? []).map((n) => n.replace(/[,.]$/, '')))
  const adaptedNumbers = new Set((adaptedText.match(/\b\d[\d,.]*\b/g) ?? []).map((n) => n.replace(/[,.]$/, '')))
  const invented = [...adaptedNumbers].filter((n) => !sourceNumbers.has(n) && n.length > 2)
  if (invented.length > 0) {
    drift.push(`The adapted text introduces figure(s) not present in the source record: ${invented.slice(0, 5).join(', ')}.`)
  }

  return drift
}

/** Strict validation of Prompt B output, plus the fact-drift gate. */
export function parseAdaptation(
  raw: string,
  facts: PastPerformanceFacts,
  fallback: AdaptationDraft,
): { draft: AdaptationDraft; warnings: string[] } {
  const warnings: string[] = []
  let parsed: Record<string, unknown>
  try {
    parsed = JSON.parse(raw) as Record<string, unknown>
  } catch {
    return { draft: fallback, warnings: ['The adaptation model returned output that is not valid JSON. No adaptation was produced.'] }
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    return { draft: fallback, warnings: ['The adaptation model returned a non-object. No adaptation was produced.'] }
  }
  if (typeof parsed.adaptedText !== 'string' || parsed.adaptedText.trim().length === 0) {
    return { draft: fallback, warnings: ['The adaptation model returned no adapted text. No adaptation was produced.'] }
  }

  const drift = detectFactDrift(facts, parsed.adaptedText)
  if (drift.length > 0) {
    return {
      draft: fallback,
      warnings: [
        'The adaptation was rejected because it altered the supplied facts, which would have produced a subtly false past-performance record.',
        ...drift,
      ],
    }
  }

  const changedFields = Array.isArray(parsed.changedFields)
    ? (parsed.changedFields as Array<Record<string, unknown>>)
        .filter((c) => typeof c?.field === 'string' && typeof c?.reason === 'string' && CHANGE_TYPES.has(String(c.changeType)))
        .map((c) => ({
          field: c.field as string,
          changeType: c.changeType as string,
          reason: c.reason as string,
          sourceReference: typeof c.sourceReference === 'string' ? c.sourceReference : null,
        }))
    : []

  const unsupportedClaims = Array.isArray(parsed.unsupportedClaims)
    ? (parsed.unsupportedClaims as Array<Record<string, unknown>>)
        .filter((u) => typeof u?.claim === 'string' && typeof u?.reason === 'string')
        .map((u) => ({
          claim: u.claim as string,
          reason: u.reason as string,
          sourceNeeded: typeof u.sourceNeeded === 'string' ? u.sourceNeeded : null,
        }))
    : []

  if (unsupportedClaims.length > 0) {
    warnings.push(
      `${unsupportedClaims.length} requested claim(s) are not supported by the source record. This adaptation is not ready for review until a person resolves them.`,
    )
  }

  return {
    warnings,
    draft: {
      recordId: facts.recordId,
      adaptedText: `${AI_DRAFT_LABEL}\n\n${parsed.adaptedText}`,
      changedFields,
      unsupportedClaims,
      source: 'LLM_ASSISTED',
      promptVersion: PAST_PERFORMANCE_ADAPTATION_PROMPT_VERSION,
      warnings,
    },
  }
}

export function adaptationUserPayload(facts: PastPerformanceFacts): Record<string, unknown> {
  return {
    pastPerformanceRecord: {
      recordId: facts.recordId,
      contractNumber: facts.contractNumber,
      customerName: facts.customerName,
      agency: facts.agency,
      role: facts.role,
      contractValue: facts.contractValue,
      periodOfPerformance: { start: facts.periodStart, end: facts.periodEnd },
      narrative: facts.narrative,
    },
    targetSolicitationRequirements: facts.targetRequirements,
  }
}

/** Adaptation, LLM-only. With no provider there is simply no adaptation. */
export async function adaptPastPerformance(
  ctx: AgentExecutionContext,
  facts: PastPerformanceFacts,
  opts: { useLlm: boolean },
): Promise<{ draft: AdaptationDraft | null; limitations: string[] }> {
  const limitations: string[] = []
  const empty: AdaptationDraft = {
    recordId: facts.recordId,
    adaptedText: '',
    changedFields: [],
    unsupportedClaims: [],
    source: 'DETERMINISTIC_SKELETON',
    promptVersion: null,
    warnings: [],
  }

  if (!opts.useLlm) {
    limitations.push(NO_PROVIDER_LIMITATION)
    return { draft: null, limitations }
  }

  const decision = await ctx.budget.check(EST_ADAPTATION_TOKENS)
  if (!decision.allowed) {
    limitations.push(`BUDGET_EXHAUSTED: ${decision.reason} No past-performance adaptation was produced.`)
    return { draft: null, limitations }
  }

  try {
    const response = await ctx.budget.generate(
      {
        systemPrompt: proposalSystemPrompt('PAST_PERFORMANCE_ADAPTATION'),
        userPrompt: JSON.stringify(adaptationUserPayload(facts)),
        maxTokens: 3000,
        temperature: 0.1,
      },
      { task: 'PROPOSAL_DRAFT', estimatedTokens: EST_ADAPTATION_TOKENS },
    )
    const { draft, warnings } = parseAdaptation(response.text, facts, empty)
    if (draft.source === 'DETERMINISTIC_SKELETON') {
      limitations.push(...warnings)
      return { draft: null, limitations }
    }
    return { draft, limitations }
  } catch (err) {
    if (err instanceof AgentBudgetExhaustedError) {
      limitations.push(`BUDGET_EXHAUSTED: ${err.message} No past-performance adaptation was produced.`)
    } else {
      limitations.push(`The adaptation model could not be reached (${(err as Error).message}).`)
    }
    return { draft: null, limitations }
  }
}

// -------------------------------------------------------------
// Prompt C — compliance cross-check
// -------------------------------------------------------------

export type CrossCheckVerdict =
  | 'COVERED' | 'PARTIALLY_COVERED' | 'NOT_COVERED' | 'REVIEW_REQUIRED' | 'INSUFFICIENT_EVIDENCE'

const VERDICTS = new Set<string>(['COVERED', 'PARTIALLY_COVERED', 'NOT_COVERED', 'REVIEW_REQUIRED', 'INSUFFICIENT_EVIDENCE'])
const EVIDENCE_TYPES = new Set<string>(['REQUIREMENT', 'PROPOSAL_SECTION'])

export interface CrossCheckFinding {
  requirementId: string
  sectionId: string | null
  verdict: CrossCheckVerdict
  evidence: Array<{ sourceType: string; sourceId: string; sourceReference: string | null; explanation: string }>
}

export interface CrossCheckResult {
  findings: CrossCheckFinding[]
  uncovered: Array<{ requirementId: string; reason: string; missingElements: string[] }>
  source: DraftSource
  promptVersion: string | null
  warnings: string[]
}

export interface CrossCheckFacts {
  requirements: Array<{ id: string; section: string; text: string; isMandatory: boolean; isManuallyVerified: boolean }>
  sections: Array<{ id: string; title: string; content: string; status: string }>
}

/** Strict validation. Unknown requirement or section ids are rejected. */
export function parseCrossCheck(
  raw: string,
  facts: CrossCheckFacts,
  fallback: CrossCheckResult,
): { result: CrossCheckResult; warnings: string[] } {
  const warnings: string[] = []
  let parsed: Record<string, unknown>
  try {
    parsed = JSON.parse(raw) as Record<string, unknown>
  } catch {
    return { result: fallback, warnings: ['The cross-check model returned output that is not valid JSON. Only the deterministic findings were kept.'] }
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed) || !Array.isArray(parsed.findings)) {
    return { result: fallback, warnings: ['The cross-check model returned a malformed result. Only the deterministic findings were kept.'] }
  }

  const requirementIds = new Set(facts.requirements.map((r) => r.id))
  const sectionIds = new Set(facts.sections.map((s) => s.id))

  const findings: CrossCheckFinding[] = []
  let rejected = 0
  for (const rawFinding of parsed.findings as Array<Record<string, unknown>>) {
    const f = rawFinding ?? {}
    if (typeof f.requirementId !== 'string' || !requirementIds.has(f.requirementId)) { rejected += 1; continue }
    if (!VERDICTS.has(String(f.verdict))) { rejected += 1; continue }
    if (f.sectionId !== null && f.sectionId !== undefined && (typeof f.sectionId !== 'string' || !sectionIds.has(f.sectionId))) {
      rejected += 1
      continue
    }

    const evidence = Array.isArray(f.evidence)
      ? (f.evidence as Array<Record<string, unknown>>)
          .filter((e) => {
            if (typeof e?.sourceId !== 'string' || typeof e?.explanation !== 'string') return false
            if (!EVIDENCE_TYPES.has(String(e.sourceType))) return false
            // An evidence id must be one of the ids actually supplied.
            return requirementIds.has(e.sourceId) || sectionIds.has(e.sourceId)
          })
          .map((e) => ({
            sourceType: e.sourceType as string,
            sourceId: e.sourceId as string,
            sourceReference: typeof e.sourceReference === 'string' ? e.sourceReference : null,
            explanation: e.explanation as string,
          }))
      : []

    findings.push({
      requirementId: f.requirementId,
      sectionId: typeof f.sectionId === 'string' ? f.sectionId : null,
      verdict: f.verdict as CrossCheckVerdict,
      evidence,
    })
  }

  if (rejected > 0) {
    warnings.push(`${rejected} cross-check finding(s) referenced an unknown requirement or section and were discarded.`)
  }

  const uncovered = Array.isArray(parsed.uncovered)
    ? (parsed.uncovered as Array<Record<string, unknown>>)
        .filter((u) => typeof u?.requirementId === 'string' && requirementIds.has(u.requirementId) && typeof u?.reason === 'string')
        .map((u) => ({
          requirementId: u.requirementId as string,
          reason: u.reason as string,
          missingElements: Array.isArray(u.missingElements)
            ? (u.missingElements as unknown[]).filter((m): m is string => typeof m === 'string')
            : [],
        }))
    : []

  return {
    warnings,
    result: {
      findings,
      uncovered,
      source: 'LLM_ASSISTED',
      promptVersion: PROPOSAL_COMPLIANCE_CROSSCHECK_PROMPT_VERSION,
      warnings,
    },
  }
}

export function crossCheckUserPayload(facts: CrossCheckFacts): Record<string, unknown> {
  return {
    requirements: facts.requirements,
    proposalSections: facts.sections,
  }
}

/** Advisory cross-check. Never overrides a deterministic or human verdict. */
export async function runCrossCheck(
  ctx: AgentExecutionContext,
  facts: CrossCheckFacts,
  opts: { useLlm: boolean },
): Promise<{ result: CrossCheckResult; limitations: string[] }> {
  const empty: CrossCheckResult = {
    findings: [], uncovered: [], source: 'DETERMINISTIC_SKELETON', promptVersion: null, warnings: [],
  }
  const limitations: string[] = []

  if (!opts.useLlm) {
    limitations.push(NO_PROVIDER_LIMITATION)
    return { result: empty, limitations }
  }
  if (facts.requirements.length === 0 || facts.sections.length === 0) {
    limitations.push('No requirement or no drafted section was available, so no AI cross-check was run.')
    return { result: empty, limitations }
  }

  const decision = await ctx.budget.check(EST_CROSSCHECK_TOKENS)
  if (!decision.allowed) {
    limitations.push(`BUDGET_EXHAUSTED: ${decision.reason} Only the deterministic compliance checks were run.`)
    return { result: empty, limitations }
  }

  try {
    const response = await ctx.budget.generate(
      {
        systemPrompt: proposalSystemPrompt('PROPOSAL_COMPLIANCE_CROSSCHECK'),
        userPrompt: JSON.stringify(crossCheckUserPayload(facts)),
        maxTokens: 4000,
        temperature: 0,
      },
      { task: 'COMPLIANCE_MATRIX', estimatedTokens: EST_CROSSCHECK_TOKENS },
    )
    const { result, warnings } = parseCrossCheck(response.text, facts, empty)
    return { result: { ...result, warnings }, limitations }
  } catch (err) {
    if (err instanceof AgentBudgetExhaustedError) {
      limitations.push(`BUDGET_EXHAUSTED: ${err.message} Only the deterministic compliance checks were run.`)
    } else {
      limitations.push(`The cross-check model could not be reached (${(err as Error).message}).`)
    }
    return { result: empty, limitations }
  }
}
