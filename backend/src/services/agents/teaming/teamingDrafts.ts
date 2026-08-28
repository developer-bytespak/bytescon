// =============================================================
// §7.5 — Agreement, NDA and outreach drafting.
//
// TWO PATHS, ONE GUARANTEE
// Every draft is a DRAFT. The deterministic template path and the optional LLM
// path produce the same non-negotiable flags:
//
//   agreement / NDA  →  status DRAFT · legalReviewRequired true ·
//                       executionAllowed false · the exact legal banner
//   outreach         →  status DRAFT · sendAllowed false · humanSendRequired true
//
// An LLM key is OPTIONAL. With no provider configured, or with the run's budget
// exhausted, or with malformed model output, the deterministic template is used
// and the run continues. NO_LLM_KEY is never fatal.
//
// Nothing in this module sends anything. There is no mail transport, no
// messaging client, and no outbound adapter imported here at all.
// =============================================================
import { buildAgreementDraft, type AgreementDraftInput } from '../../teamingAgreementDraft'
import { AgentBudgetExhaustedError, type AgentExecutionContext } from '../types'
import {
  LEGAL_REVIEW_BANNER,
  LEGAL_REVIEW_REASON,
  OUTREACH_SEND_CONTROL_REASON,
  TEAMING_AGREEMENT_NDA_DRAFT_PROMPT_VERSION,
  PARTNER_OUTREACH_DRAFT_PROMPT_VERSION,
  teamingSystemPrompt,
} from './teamingPrompts'

export const DRAFT_METHOD_VERSION = 'teaming-draft-v1'

/** Rough ceiling used for the pre-flight budget check. */
const ESTIMATED_DRAFT_TOKENS = 4_000
const ESTIMATED_OUTREACH_TOKENS = 1_500

export type DocumentType = 'TEAMING_AGREEMENT' | 'NDA'
export type DraftSource = 'DETERMINISTIC_TEMPLATE' | 'LLM_ASSISTED'

export interface WorkshareProposal {
  status: 'SUPPLIED' | 'PROPOSED' | 'NOT_AVAILABLE'
  primePercent: number | null
  partnerPercent: number | null
  description: string | null
  rationale: string | null
  limitations: string[]
}

export interface AgreementDraftFacts {
  documentType: DocumentType
  firmName: string
  partnerId: string
  partnerName: string
  partnerRole: string
  arrangementType: string
  opportunityId: string | null
  opportunityTitle: string
  agency: string | null
  solicitationNumber: string | null
  capabilityGapsAddressed: string[]
  partnerContribution: string[]
  workshare: WorkshareProposal
  /** Certification claims, already labelled verified/unverified upstream. */
  certificationEvidence: string[]
}

export interface AgreementDraft {
  documentType: DocumentType
  status: 'DRAFT'
  banner: string
  legalReviewRequired: true
  executionAllowed: false
  source: DraftSource
  promptVersion: string | null
  parties: Array<{ partyId: string | null; legalName: string | null; role: string; sourceReference: string | null }>
  opportunity: { opportunityId: string | null; solicitationNumber: string | null; title: string | null; agency: string | null }
  scope: {
    summary: string | null
    capabilityGapsAddressed: string[]
    proposedPartnerContribution: string[]
    workshare: { status: string; primePercent: number | null; partnerPercent: number | null; description: string | null }
  }
  clauses: Array<{
    clauseKey: string
    title: string
    draftText: string
    sourceType: 'SUPPLIED_FACT' | 'SUPPLIED_REQUIREMENT' | 'SUPPLIED_TEMPLATE' | 'PROPOSED_DRAFT_LANGUAGE'
    sourceReferences: string[]
    legalReviewRequired: true
    assumptions: string[]
  }>
  regulatoryReferences: Array<{ reference: string; sourceReference: string; status: string; legalReviewRequired: true }>
  assumptions: string[]
  unresolvedItems: string[]
  warnings: string[]
  legalReview: { required: true; reason: string }
  /** The editable body a human works from. */
  documentText: string
}

export interface OutreachFacts {
  partnerId: string
  partnerName: string
  contactName: string | null
  contactAddress: string | null
  opportunityId: string | null
  opportunityTitle: string
  solicitationNumber: string | null
  agency: string | null
  capabilityGaps: string[]
  matchEvidence: Array<{ reason: string; evidence: string }>
  hasAgreementDraft: boolean
}

export interface OutreachDraft {
  status: 'DRAFT'
  sendAllowed: false
  humanSendRequired: true
  source: DraftSource
  promptVersion: string | null
  channel: 'EMAIL' | 'LINKEDIN' | 'OTHER'
  recipient: { partnerId: string | null; partnerName: string | null; contactName: string | null; contactAddress: string | null }
  subject: string | null
  message: string
  whyThisPartner: Array<{ reason: string; evidence: string }>
  opportunityReference: { opportunityId: string | null; solicitationNumber: string | null; title: string | null }
  proposedDiscussionPoints: string[]
  unresolvedItems: string[]
  warnings: string[]
  sendControl: { allowed: false; reason: string }
}

// -------------------------------------------------------------
// Deterministic agreement / NDA
// -------------------------------------------------------------

/**
 * The template path. Interpolates supplied values only.
 *
 * Nothing here invents governing law, jurisdiction, term length, exclusivity,
 * indemnity, remedies or execution terms — a missing fact becomes an unresolved
 * item, never a plausible-sounding default.
 */
export function buildDeterministicAgreementDraft(facts: AgreementDraftFacts): AgreementDraft {
  const unresolvedItems: string[] = []
  const warnings: string[] = []

  if (!facts.solicitationNumber) unresolvedItems.push('Solicitation number is not recorded.')
  if (!facts.agency) unresolvedItems.push('Contracting agency is not recorded.')
  unresolvedItems.push('Legal names, addresses and authorised representatives for both parties are not recorded and must be supplied.')
  unresolvedItems.push('Governing law and jurisdiction are not recorded and must be determined by counsel.')
  if (facts.documentType === 'NDA') {
    unresolvedItems.push('Confidentiality term length, residuals treatment and compelled-disclosure procedure must be determined by counsel.')
  } else {
    unresolvedItems.push('Exclusivity, subcontract intent and post-award terms must be determined by counsel.')
  }
  if (facts.workshare.status === 'PROPOSED') {
    warnings.push('The workshare below is PROPOSED by the platform from capability evidence. It is not agreed and is not binding.')
  }
  if (facts.certificationEvidence.length === 0) {
    unresolvedItems.push('No partner certification evidence is recorded, so no certification status is asserted in this draft.')
  }

  const documentText = buildAgreementDraft({
    draftType: facts.documentType,
    firmName: facts.firmName,
    partnerName: facts.partnerName,
    partnerRole: facts.partnerRole,
    arrangementType: facts.arrangementType,
    opportunityTitle: facts.opportunityTitle,
    agency: facts.agency,
    solicitationNumber: facts.solicitationNumber,
    scopePercent: facts.workshare.partnerPercent,
    workshareDescription: facts.workshare.description,
    capabilityContribution: facts.partnerContribution.join('; ') || null,
  } satisfies AgreementDraftInput)

  const clauses: AgreementDraft['clauses'] = [
    {
      clauseKey: 'DRAFT_STATUS',
      title: 'Draft status',
      draftText: `${LEGAL_REVIEW_BANNER}. This document is an automatically-assembled first draft populated only from data recorded in Bytescon. It has not been executed and confers no obligation on either party.`,
      sourceType: 'SUPPLIED_TEMPLATE',
      sourceReferences: [],
      legalReviewRequired: true,
      assumptions: [],
    },
    {
      clauseKey: 'PARTIES',
      title: 'Parties',
      draftText: `Prime / sponsoring party: ${facts.firmName}. Teaming party: ${facts.partnerName}. Legal names, addresses and authorised representatives are not recorded and must be supplied before use.`,
      sourceType: 'SUPPLIED_FACT',
      sourceReferences: [facts.partnerId],
      legalReviewRequired: true,
      assumptions: [],
    },
    {
      clauseKey: 'SCOPE',
      title: 'Scope and contribution',
      draftText:
        facts.partnerContribution.length > 0
          ? `The teaming party is contemplated to contribute: ${facts.partnerContribution.join('; ')}. This reflects capability evidence recorded in Bytescon and is not an agreed statement of work.`
          : 'No partner contribution is recorded. Scope must be supplied before use.',
      sourceType: facts.partnerContribution.length > 0 ? 'SUPPLIED_FACT' : 'PROPOSED_DRAFT_LANGUAGE',
      sourceReferences: facts.capabilityGapsAddressed,
      legalReviewRequired: true,
      assumptions: [],
    },
    {
      clauseKey: 'WORKSHARE',
      title: 'Workshare',
      draftText:
        facts.workshare.status === 'NOT_AVAILABLE'
          ? 'No workshare is recorded or proposed. Any allocation must be agreed by the parties.'
          : `${facts.workshare.status === 'PROPOSED' ? 'PROPOSED (not agreed): ' : 'Supplied: '}` +
            `prime ${facts.workshare.primePercent ?? 'TBD'}%, teaming party ${facts.workshare.partnerPercent ?? 'TBD'}%.` +
            (facts.workshare.description ? ` ${facts.workshare.description}` : ''),
      sourceType: facts.workshare.status === 'SUPPLIED' ? 'SUPPLIED_FACT' : 'PROPOSED_DRAFT_LANGUAGE',
      sourceReferences: [],
      legalReviewRequired: true,
      assumptions: facts.workshare.limitations,
    },
    {
      clauseKey: 'LEGAL_REVIEW',
      title: 'Legal review',
      draftText: LEGAL_REVIEW_REASON,
      sourceType: 'SUPPLIED_TEMPLATE',
      sourceReferences: [],
      legalReviewRequired: true,
      assumptions: [],
    },
  ]

  return {
    documentType: facts.documentType,
    status: 'DRAFT',
    banner: LEGAL_REVIEW_BANNER,
    legalReviewRequired: true,
    executionAllowed: false,
    source: 'DETERMINISTIC_TEMPLATE',
    promptVersion: null,
    parties: [
      { partyId: null, legalName: facts.firmName, role: 'PRIME', sourceReference: null },
      { partyId: facts.partnerId, legalName: facts.partnerName, role: 'SUBCONTRACTOR', sourceReference: facts.partnerId },
    ],
    opportunity: {
      opportunityId: facts.opportunityId,
      solicitationNumber: facts.solicitationNumber,
      title: facts.opportunityTitle,
      agency: facts.agency,
    },
    scope: {
      summary: facts.capabilityGapsAddressed.length > 0
        ? `Teaming contemplated to address: ${facts.capabilityGapsAddressed.join('; ')}.`
        : null,
      capabilityGapsAddressed: facts.capabilityGapsAddressed,
      proposedPartnerContribution: facts.partnerContribution,
      workshare: {
        status: facts.workshare.status,
        primePercent: facts.workshare.primePercent,
        partnerPercent: facts.workshare.partnerPercent,
        description: facts.workshare.description,
      },
    },
    clauses,
    regulatoryReferences: [],
    assumptions: ['Every value in this draft came from a record in Bytescon. No term was inferred from common practice.'],
    unresolvedItems,
    warnings,
    legalReview: { required: true, reason: LEGAL_REVIEW_REASON },
    documentText,
  }
}

// -------------------------------------------------------------
// Deterministic outreach
// -------------------------------------------------------------

/** The template path. States only what the supplied evidence supports. */
export function buildDeterministicOutreachDraft(facts: OutreachFacts): OutreachDraft {
  const unresolvedItems: string[] = []
  const warnings: string[] = []

  if (!facts.contactAddress) unresolvedItems.push('No contact address is recorded for this partner. A human must supply one before sending.')
  if (!facts.contactName) unresolvedItems.push('No contact name is recorded for this partner.')
  if (!facts.solicitationNumber) unresolvedItems.push('Solicitation number is not recorded.')
  if (facts.matchEvidence.length === 0) {
    warnings.push('No matching evidence is recorded, so this draft states no reason the partner is relevant.')
  }

  const gapLine = facts.capabilityGaps.length > 0
    ? `We are looking for support with: ${facts.capabilityGaps.join('; ')}.`
    : 'We are exploring teaming support for this opportunity.'

  const whyLines = facts.matchEvidence.map((e) => `- ${e.reason} (${e.evidence})`)

  const message = [
    `Hello${facts.contactName ? ` ${facts.contactName}` : ''},`,
    '',
    `We are evaluating a teaming relationship for ${facts.opportunityTitle}` +
      `${facts.agency ? ` with ${facts.agency}` : ''}` +
      `${facts.solicitationNumber ? ` (solicitation ${facts.solicitationNumber})` : ''}.`,
    '',
    gapLine,
    ...(whyLines.length > 0 ? ['', 'Based on the information we hold, you appear relevant because:', ...whyLines] : []),
    '',
    facts.hasAgreementDraft
      ? 'We have prepared a draft teaming document. It is a draft only and requires review by both parties and by legal counsel before it could be used.'
      : 'If there is mutual interest, a teaming document would need to be prepared and reviewed by both parties and by legal counsel.',
    '',
    'Nothing in this message is an offer, a commitment, or a representation that any agreement exists. We would welcome a conversation about whether a teaming relationship makes sense.',
    '',
    'Kind regards,',
  ].join('\n')

  return {
    status: 'DRAFT',
    sendAllowed: false,
    humanSendRequired: true,
    source: 'DETERMINISTIC_TEMPLATE',
    promptVersion: null,
    channel: 'EMAIL',
    recipient: {
      partnerId: facts.partnerId,
      partnerName: facts.partnerName,
      contactName: facts.contactName,
      contactAddress: facts.contactAddress,
    },
    subject: `Teaming enquiry — ${facts.opportunityTitle}`,
    message,
    whyThisPartner: facts.matchEvidence,
    opportunityReference: {
      opportunityId: facts.opportunityId,
      solicitationNumber: facts.solicitationNumber,
      title: facts.opportunityTitle,
    },
    proposedDiscussionPoints: [
      'Whether the capability areas above are ones you cover',
      'What evidence of relevant past performance you could provide',
      'Whether a mutual non-disclosure agreement would be needed first',
    ],
    unresolvedItems,
    warnings,
    sendControl: { allowed: false, reason: OUTREACH_SEND_CONTROL_REASON },
  }
}

// -------------------------------------------------------------
// Optional LLM paths
// -------------------------------------------------------------

/** Everything a model returned that we are willing to keep. */
function coerceStringArray(v: unknown): string[] {
  return Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : []
}

/**
 * Strict validation of the agreement/NDA contract.
 *
 * The safety flags are NOT taken from the model. They are forced, so a model
 * that returns `executionAllowed: true` cannot make a draft executable.
 */
export function parseAgreementLlmOutput(raw: string, fallback: AgreementDraft): { draft: AgreementDraft; warnings: string[] } {
  const warnings: string[] = []
  let parsed: Record<string, unknown>
  try {
    parsed = JSON.parse(raw) as Record<string, unknown>
  } catch {
    return { draft: fallback, warnings: ['The drafting model returned output that is not valid JSON. The deterministic template was used instead.'] }
  }

  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    return { draft: fallback, warnings: ['The drafting model returned a non-object. The deterministic template was used instead.'] }
  }
  if (parsed.documentType !== 'TEAMING_AGREEMENT' && parsed.documentType !== 'NDA') {
    return { draft: fallback, warnings: ['The drafting model returned an unrecognised documentType. The deterministic template was used instead.'] }
  }
  if (!Array.isArray(parsed.clauses) || parsed.clauses.length === 0) {
    return { draft: fallback, warnings: ['The drafting model returned no clauses. The deterministic template was used instead.'] }
  }

  const VALID_SOURCE_TYPES = new Set(['SUPPLIED_FACT', 'SUPPLIED_REQUIREMENT', 'SUPPLIED_TEMPLATE', 'PROPOSED_DRAFT_LANGUAGE'])
  const clauses: AgreementDraft['clauses'] = []
  for (const c of parsed.clauses as Array<Record<string, unknown>>) {
    if (typeof c?.clauseKey !== 'string' || typeof c?.draftText !== 'string') {
      return { draft: fallback, warnings: ['The drafting model returned a malformed clause. The deterministic template was used instead.'] }
    }
    if (!VALID_SOURCE_TYPES.has(String(c.sourceType))) {
      return { draft: fallback, warnings: ['The drafting model returned a clause with an unrecognised sourceType. The deterministic template was used instead.'] }
    }
    clauses.push({
      clauseKey: c.clauseKey,
      title: typeof c.title === 'string' ? c.title : c.clauseKey,
      draftText: c.draftText,
      sourceType: c.sourceType as AgreementDraft['clauses'][number]['sourceType'],
      sourceReferences: coerceStringArray(c.sourceReferences),
      // Forced, never trusted from the model.
      legalReviewRequired: true,
      assumptions: coerceStringArray(c.assumptions),
    })
  }

  if (parsed.executionAllowed === true) {
    warnings.push('The drafting model attempted to mark the document executable. That flag was overridden: no generated draft is ever executable.')
  }
  if (parsed.legalReviewRequired === false) {
    warnings.push('The drafting model attempted to waive legal review. That flag was overridden: every generated draft requires legal review.')
  }

  const scope = (parsed.scope ?? {}) as Record<string, unknown>
  const ws = (scope.workshare ?? {}) as Record<string, unknown>

  return {
    warnings: [...warnings, ...coerceStringArray(parsed.warnings)],
    draft: {
      ...fallback,
      documentType: parsed.documentType,
      // The three safety flags and the banner are ours, not the model's.
      status: 'DRAFT',
      banner: LEGAL_REVIEW_BANNER,
      legalReviewRequired: true,
      executionAllowed: false,
      source: 'LLM_ASSISTED',
      promptVersion: TEAMING_AGREEMENT_NDA_DRAFT_PROMPT_VERSION,
      scope: {
        summary: typeof scope.summary === 'string' ? scope.summary : fallback.scope.summary,
        capabilityGapsAddressed: coerceStringArray(scope.capabilityGapsAddressed),
        proposedPartnerContribution: coerceStringArray(scope.proposedPartnerContribution),
        workshare: {
          status: typeof ws.status === 'string' ? ws.status : fallback.scope.workshare.status,
          primePercent: typeof ws.primePercent === 'number' ? ws.primePercent : null,
          partnerPercent: typeof ws.partnerPercent === 'number' ? ws.partnerPercent : null,
          description: typeof ws.description === 'string' ? ws.description : null,
        },
      },
      clauses,
      assumptions: coerceStringArray(parsed.assumptions),
      unresolvedItems: coerceStringArray(parsed.unresolvedItems),
      legalReview: { required: true, reason: LEGAL_REVIEW_REASON },
      documentText: [LEGAL_REVIEW_BANNER, '', ...clauses.map((c) => `${c.title}\n${c.draftText}`)].join('\n\n'),
    },
  }
}

/** Strict validation of the outreach contract. Send flags are forced. */
export function parseOutreachLlmOutput(raw: string, fallback: OutreachDraft): { draft: OutreachDraft; warnings: string[] } {
  const warnings: string[] = []
  let parsed: Record<string, unknown>
  try {
    parsed = JSON.parse(raw) as Record<string, unknown>
  } catch {
    return { draft: fallback, warnings: ['The outreach model returned output that is not valid JSON. The deterministic template was used instead.'] }
  }

  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    return { draft: fallback, warnings: ['The outreach model returned a non-object. The deterministic template was used instead.'] }
  }
  if (typeof parsed.message !== 'string' || parsed.message.trim().length === 0) {
    return { draft: fallback, warnings: ['The outreach model returned no message body. The deterministic template was used instead.'] }
  }

  if (parsed.sendAllowed === true) {
    warnings.push('The outreach model attempted to mark the message sendable. That flag was overridden: outreach is never sent by the agent.')
  }

  const why = Array.isArray(parsed.whyThisPartner)
    ? (parsed.whyThisPartner as Array<Record<string, unknown>>)
        .filter((w) => typeof w?.reason === 'string' && typeof w?.evidence === 'string')
        .map((w) => ({ reason: w.reason as string, evidence: w.evidence as string }))
    : []

  const recipient = (parsed.recipient ?? {}) as Record<string, unknown>

  return {
    warnings: [...warnings, ...coerceStringArray(parsed.warnings)],
    draft: {
      ...fallback,
      status: 'DRAFT',
      // Never taken from the model.
      sendAllowed: false,
      humanSendRequired: true,
      source: 'LLM_ASSISTED',
      promptVersion: PARTNER_OUTREACH_DRAFT_PROMPT_VERSION,
      channel: parsed.channel === 'LINKEDIN' || parsed.channel === 'OTHER' ? parsed.channel : 'EMAIL',
      recipient: {
        // Contact details come from OUR record, never from the model, so a
        // hallucinated address can never reach a human's clipboard.
        partnerId: fallback.recipient.partnerId,
        partnerName: fallback.recipient.partnerName,
        contactName: fallback.recipient.contactName,
        contactAddress: fallback.recipient.contactAddress,
      },
      subject: typeof parsed.subject === 'string' ? parsed.subject : fallback.subject,
      message: parsed.message,
      whyThisPartner: why,
      proposedDiscussionPoints: coerceStringArray(parsed.proposedDiscussionPoints),
      unresolvedItems: coerceStringArray(parsed.unresolvedItems),
      sendControl: { allowed: false, reason: OUTREACH_SEND_CONTROL_REASON },
      // Ignored on purpose: `recipient.contactAddress` from the model.
      ...(typeof recipient.contactAddress === 'string' && recipient.contactAddress !== fallback.recipient.contactAddress
        ? {}
        : {}),
    },
  }
}

/**
 * Agreement/NDA draft, LLM-assisted when possible.
 *
 * Ordering matters and is tested: budget is checked BEFORE the provider is
 * reached. On exhaustion the provider is never called, a BUDGET_EXHAUSTED
 * limitation is recorded, and the deterministic draft is returned.
 */
export async function draftAgreement(
  ctx: AgentExecutionContext,
  facts: AgreementDraftFacts,
  opts: { useLlm: boolean },
): Promise<{ draft: AgreementDraft; limitations: string[]; warnings: string[] }> {
  const deterministic = buildDeterministicAgreementDraft(facts)
  const limitations: string[] = []

  if (!opts.useLlm) {
    return { draft: deterministic, limitations, warnings: [] }
  }

  const decision = await ctx.budget.check(ESTIMATED_DRAFT_TOKENS)
  if (!decision.allowed) {
    limitations.push(`BUDGET_EXHAUSTED: ${decision.reason} The deterministic template draft was used instead.`)
    return { draft: deterministic, limitations, warnings: [] }
  }

  try {
    const response = await ctx.budget.generate(
      {
        // The canonical constant, alone. Nothing is appended to it.
        systemPrompt: teamingSystemPrompt('TEAMING_AGREEMENT_NDA_DRAFT'),
        userPrompt: JSON.stringify(agreementUserPayload(facts)),
        maxTokens: 4000,
        temperature: 0,
      },
      { task: 'TEAMING_AGREEMENT_DRAFT', estimatedTokens: ESTIMATED_DRAFT_TOKENS },
    )
    const { draft, warnings } = parseAgreementLlmOutput(response.text, deterministic)
    return { draft, limitations, warnings }
  } catch (err) {
    if (err instanceof AgentBudgetExhaustedError) {
      limitations.push(`BUDGET_EXHAUSTED: ${err.message} The deterministic template draft was used instead.`)
    } else {
      limitations.push(`The drafting model could not be reached (${(err as Error).message}). The deterministic template draft was used instead.`)
    }
    return { draft: deterministic, limitations, warnings: [] }
  }
}

/** Outreach draft, LLM-assisted when possible. Same budget-first ordering. */
export async function draftOutreach(
  ctx: AgentExecutionContext,
  facts: OutreachFacts,
  opts: { useLlm: boolean },
): Promise<{ draft: OutreachDraft; limitations: string[]; warnings: string[] }> {
  const deterministic = buildDeterministicOutreachDraft(facts)
  const limitations: string[] = []

  if (!opts.useLlm) {
    return { draft: deterministic, limitations, warnings: [] }
  }

  const decision = await ctx.budget.check(ESTIMATED_OUTREACH_TOKENS)
  if (!decision.allowed) {
    limitations.push(`BUDGET_EXHAUSTED: ${decision.reason} The deterministic template outreach draft was used instead.`)
    return { draft: deterministic, limitations, warnings: [] }
  }

  try {
    const response = await ctx.budget.generate(
      {
        systemPrompt: teamingSystemPrompt('PARTNER_OUTREACH_DRAFT'),
        userPrompt: JSON.stringify(outreachUserPayload(facts)),
        maxTokens: 1500,
        temperature: 0,
      },
      { task: 'TEAMING_OUTREACH', estimatedTokens: ESTIMATED_OUTREACH_TOKENS },
    )
    const { draft, warnings } = parseOutreachLlmOutput(response.text, deterministic)
    return { draft, limitations, warnings }
  } catch (err) {
    if (err instanceof AgentBudgetExhaustedError) {
      limitations.push(`BUDGET_EXHAUSTED: ${err.message} The deterministic template outreach draft was used instead.`)
    } else {
      limitations.push(`The outreach model could not be reached (${(err as Error).message}). The deterministic template outreach draft was used instead.`)
    }
    return { draft: deterministic, limitations, warnings: [] }
  }
}

// -------------------------------------------------------------
// Payload minimisation
// -------------------------------------------------------------

/**
 * EXACTLY the facts needed to draft this document, and nothing else.
 *
 * No other partner, no other tenant, no internal scoring weights, no win
 * probability, no private notes, no competitor intelligence, no credentials.
 * Asserted field-by-field by test.
 */
export function agreementUserPayload(facts: AgreementDraftFacts): Record<string, unknown> {
  return {
    documentType: facts.documentType,
    parties: {
      prime: { legalName: facts.firmName },
      partner: { partyId: facts.partnerId, legalName: facts.partnerName, role: facts.partnerRole },
    },
    arrangementType: facts.arrangementType,
    opportunity: {
      opportunityId: facts.opportunityId,
      solicitationNumber: facts.solicitationNumber,
      title: facts.opportunityTitle,
      agency: facts.agency,
    },
    capabilityGapsAddressed: facts.capabilityGapsAddressed,
    proposedPartnerContribution: facts.partnerContribution,
    workshare: {
      status: facts.workshare.status,
      primePercent: facts.workshare.primePercent,
      partnerPercent: facts.workshare.partnerPercent,
      description: facts.workshare.description,
    },
    certificationEvidence: facts.certificationEvidence,
  }
}

/** The same minimisation rule for outreach. */
export function outreachUserPayload(facts: OutreachFacts): Record<string, unknown> {
  return {
    partner: { partnerId: facts.partnerId, partnerName: facts.partnerName, contactName: facts.contactName },
    opportunity: {
      opportunityId: facts.opportunityId,
      solicitationNumber: facts.solicitationNumber,
      title: facts.opportunityTitle,
      agency: facts.agency,
    },
    capabilityGaps: facts.capabilityGaps,
    matchEvidence: facts.matchEvidence,
    hasAgreementDraft: facts.hasAgreementDraft,
  }
}
