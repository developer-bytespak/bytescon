// =============================================================
// §7.5 — Agreement, NDA and outreach drafting.
//
// Both paths are tested: the deterministic template and the optional LLM path
// with a mocked provider. The same four guarantees must hold on both:
//
//   DRAFT · legalReviewRequired · not executable · the exact banner
//   DRAFT · sendAllowed false   · humanSendRequired true
//
// The safety flags are FORCED, not read from the model, so a model that returns
// `executionAllowed: true` or `sendAllowed: true` still cannot produce an
// executable document or a sendable message.
// =============================================================
import { describe, it, expect, vi, beforeEach } from 'vitest'
import {
  buildDeterministicAgreementDraft,
  buildDeterministicOutreachDraft,
  parseAgreementLlmOutput,
  parseOutreachLlmOutput,
  draftAgreement,
  draftOutreach,
  agreementUserPayload,
  outreachUserPayload,
  type AgreementDraftFacts,
  type OutreachFacts,
} from './teamingDrafts'
import { LEGAL_REVIEW_BANNER, TEAMING_AGREEMENT_NDA_DRAFT_SYSTEM_PROMPT, PARTNER_OUTREACH_DRAFT_SYSTEM_PROMPT } from './teamingPrompts'
import { AgentBudgetExhaustedError, type AgentExecutionContext } from '../types'

const agreementFacts = (over: Partial<AgreementDraftFacts> = {}): AgreementDraftFacts => ({
  documentType: 'TEAMING_AGREEMENT',
  firmName: 'Bytes Platform',
  partnerId: 'partner-1',
  partnerName: 'Acme Federal',
  partnerRole: 'SUB',
  arrangementType: 'TEAMING_AGREEMENT',
  opportunityId: 'opp-1',
  opportunityTitle: 'Cyber support services',
  agency: 'Department of Defense',
  solicitationNumber: 'W123-26-R-0001',
  capabilityGapsAddressed: ['certification: SDVOSB'],
  partnerContribution: ['incident response'],
  workshare: {
    status: 'PROPOSED', primePercent: 70, partnerPercent: 30,
    description: 'Starting point for discussion.', rationale: 'Derived from recorded gaps.',
    limitations: ['PROPOSED only.'],
  },
  certificationEvidence: ['SDVOSB'],
  ...over,
})

const outreachFacts = (over: Partial<OutreachFacts> = {}): OutreachFacts => ({
  partnerId: 'partner-1',
  partnerName: 'Acme Federal',
  contactName: 'Jordan Lee',
  contactAddress: 'jordan@acmefederal.example',
  opportunityId: 'opp-1',
  opportunityTitle: 'Cyber support services',
  solicitationNumber: 'W123-26-R-0001',
  agency: 'Department of Defense',
  capabilityGaps: ['certification: SDVOSB'],
  matchEvidence: [{ reason: 'NAICS overlap', evidence: '541512 matches' }],
  hasAgreementDraft: true,
  ...over,
})

/** A context whose budget guard is fully controllable. */
function makeCtx(over: {
  allowed?: boolean
  generate?: (req: { systemPrompt?: string; userPrompt: string }, opts: { task: string }) => Promise<{ text: string }>
} = {}): { ctx: AgentExecutionContext; generate: ReturnType<typeof vi.fn>; check: ReturnType<typeof vi.fn> } {
  const check = vi.fn().mockResolvedValue(
    over.allowed === false
      ? { allowed: false, reason: 'The run token budget is exhausted.', scope: 'RUN' }
      : { allowed: true, remainingTokens: 10_000, remainingCostUsd: 1 },
  )
  const generate = vi.fn(
    over.generate ??
      (async () => ({ text: '{}', inputTokens: 1, outputTokens: 1, estimatedCostUsd: 0, provider: 'mock', model: 'mock' })),
  )
  const ctx = {
    agentKey: 'TEAMING',
    consultingFirmId: 'firm-1',
    runId: 'run-1',
    autonomyLevel: 'PROPOSE',
    budget: { check, generate, consumed: () => ({ tokenInput: 0, tokenOutput: 0, estimatedCostUsd: 0 }) },
    log: vi.fn(),
    heartbeat: vi.fn(),
    audit: vi.fn(),
    canApply: () => false,
    signal: new AbortController().signal,
  } as unknown as AgentExecutionContext
  return { ctx, generate, check }
}

beforeEach(() => { vi.clearAllMocks() })

// -------------------------------------------------------------
// Deterministic agreement / NDA
// -------------------------------------------------------------

describe('the deterministic agreement draft', () => {
  it('is a DRAFT that requires legal review and is not executable', () => {
    const d = buildDeterministicAgreementDraft(agreementFacts())
    expect(d.status).toBe('DRAFT')
    expect(d.legalReviewRequired).toBe(true)
    expect(d.executionAllowed).toBe(false)
    expect(d.source).toBe('DETERMINISTIC_TEMPLATE')
  })

  it('carries the exact legal banner', () => {
    expect(buildDeterministicAgreementDraft(agreementFacts()).banner).toBe('REQUIRES LEGAL REVIEW — NOT EXECUTABLE')
  })

  it('never claims a signature, an execution or an approval', () => {
    const text = JSON.stringify(buildDeterministicAgreementDraft(agreementFacts()))
    for (const word of ['"SIGNED"', '"EXECUTED"', 'signatureDate', 'signedAt', 'executedAt']) {
      expect(text, word).not.toContain(word)
    }
  })

  it('records missing facts as unresolved items rather than inventing them', () => {
    const d = buildDeterministicAgreementDraft(agreementFacts({ solicitationNumber: null, agency: null }))
    expect(d.unresolvedItems).toContain('Solicitation number is not recorded.')
    expect(d.unresolvedItems).toContain('Contracting agency is not recorded.')
  })

  it('never invents governing law or jurisdiction', () => {
    const d = buildDeterministicAgreementDraft(agreementFacts())
    expect(d.unresolvedItems.join(' ')).toContain('Governing law and jurisdiction are not recorded')
    expect(JSON.stringify(d)).not.toMatch(/laws of the State of/i)
  })

  it('labels a proposed workshare PROPOSED and warns it is not agreed', () => {
    const d = buildDeterministicAgreementDraft(agreementFacts())
    expect(d.scope.workshare.status).toBe('PROPOSED')
    const clause = d.clauses.find((c) => c.clauseKey === 'WORKSHARE')!
    expect(clause.draftText).toContain('PROPOSED (not agreed)')
    expect(d.warnings.join(' ')).toContain('is not agreed and is not binding')
  })

  it('states no workshare at all when none is available', () => {
    const d = buildDeterministicAgreementDraft(agreementFacts({
      workshare: { status: 'NOT_AVAILABLE', primePercent: null, partnerPercent: null, description: null, rationale: null, limitations: [] },
    }))
    expect(d.clauses.find((c) => c.clauseKey === 'WORKSHARE')!.draftText).toContain('No workshare is recorded or proposed')
  })

  it('asserts no certification status when none is recorded', () => {
    const d = buildDeterministicAgreementDraft(agreementFacts({ certificationEvidence: [] }))
    expect(d.unresolvedItems.join(' ')).toContain('no certification status is asserted')
  })

  it('marks every clause as requiring legal review', () => {
    const d = buildDeterministicAgreementDraft(agreementFacts())
    expect(d.clauses.length).toBeGreaterThan(0)
    for (const c of d.clauses) expect(c.legalReviewRequired, c.clauseKey).toBe(true)
  })

  it('gives an NDA its own unresolved confidentiality terms', () => {
    const d = buildDeterministicAgreementDraft(agreementFacts({ documentType: 'NDA' }))
    expect(d.documentType).toBe('NDA')
    expect(d.unresolvedItems.join(' ')).toContain('Confidentiality term length')
    expect(d.unresolvedItems.join(' ')).not.toContain('Exclusivity, subcontract intent')
  })

  it('produces the human-editable body from the existing §5.1 template service', () => {
    const d = buildDeterministicAgreementDraft(agreementFacts())
    expect(d.documentText).toContain('DRAFT')
    expect(d.documentText.length).toBeGreaterThan(200)
  })

  it('is deterministic for identical facts', () => {
    const a = JSON.stringify(buildDeterministicAgreementDraft(agreementFacts()))
    const b = JSON.stringify(buildDeterministicAgreementDraft(agreementFacts()))
    expect(a).toBe(b)
  })
})

// -------------------------------------------------------------
// Deterministic outreach
// -------------------------------------------------------------

describe('the deterministic outreach draft', () => {
  it('is a DRAFT that cannot be sent without a person', () => {
    const d = buildDeterministicOutreachDraft(outreachFacts())
    expect(d.status).toBe('DRAFT')
    expect(d.sendAllowed).toBe(false)
    expect(d.humanSendRequired).toBe(true)
    expect(d.sendControl.allowed).toBe(false)
  })

  it('explains that a human must send it', () => {
    expect(buildDeterministicOutreachDraft(outreachFacts()).sendControl.reason)
      .toBe('Partner outreach must be reviewed and sent by an authorized human user.')
  })

  it('never invents a contact address', () => {
    const d = buildDeterministicOutreachDraft(outreachFacts({ contactAddress: null, contactName: null }))
    expect(d.recipient.contactAddress).toBeNull()
    expect(d.unresolvedItems.join(' ')).toContain('No contact address is recorded')
  })

  it('makes no claim that the partner is qualified or selected', () => {
    const message = buildDeterministicOutreachDraft(outreachFacts()).message
    for (const claim of ['qualified', 'approved', 'selected', 'preferred', 'committed', 'exclusive']) {
      expect(message.toLowerCase(), claim).not.toContain(claim)
    }
  })

  it('makes no prediction about winning', () => {
    const message = buildDeterministicOutreachDraft(outreachFacts()).message.toLowerCase()
    for (const claim of ['will win', 'likely to win', 'inside track', 'government support']) {
      expect(message, claim).not.toContain(claim)
    }
  })

  it('exposes no win probability or internal score', () => {
    const text = JSON.stringify(buildDeterministicOutreachDraft(outreachFacts()))
    expect(text).not.toMatch(/probability/i)
    expect(text).not.toMatch(/\bweight\b/i)
  })

  it('describes an agreement only as a draft requiring review', () => {
    const message = buildDeterministicOutreachDraft(outreachFacts()).message
    expect(message).toContain('It is a draft only and requires review')
    expect(message).not.toMatch(/agreement is in place/i)
  })

  it('states explicitly that nothing is an offer or a commitment', () => {
    expect(buildDeterministicOutreachDraft(outreachFacts()).message)
      .toContain('Nothing in this message is an offer, a commitment, or a representation that any agreement exists.')
  })

  it('warns when there is no matching evidence rather than inventing a reason', () => {
    const d = buildDeterministicOutreachDraft(outreachFacts({ matchEvidence: [] }))
    expect(d.whyThisPartner).toHaveLength(0)
    expect(d.warnings.join(' ')).toContain('states no reason the partner is relevant')
  })

  it('grounds every stated reason in supplied evidence', () => {
    const d = buildDeterministicOutreachDraft(outreachFacts())
    expect(d.message).toContain('NAICS overlap (541512 matches)')
  })
})

// -------------------------------------------------------------
// LLM path — agreement
// -------------------------------------------------------------

describe('the LLM agreement path', () => {
  const validOutput = (over: Record<string, unknown> = {}) =>
    JSON.stringify({
      documentType: 'TEAMING_AGREEMENT',
      status: 'DRAFT',
      banner: LEGAL_REVIEW_BANNER,
      legalReviewRequired: true,
      executionAllowed: false,
      scope: { summary: 'Model summary', capabilityGapsAddressed: ['certification: SDVOSB'], proposedPartnerContribution: ['IR'], workshare: { status: 'PROPOSED', primePercent: 70, partnerPercent: 30, description: 'x' } },
      clauses: [{ clauseKey: 'SCOPE', title: 'Scope', draftText: 'Model text', sourceType: 'SUPPLIED_FACT', sourceReferences: [], legalReviewRequired: true, assumptions: [] }],
      assumptions: [], unresolvedItems: ['Addresses missing'], warnings: [],
      ...over,
    })

  it('uses the canonical prompt constant, alone', async () => {
    const { ctx, generate } = makeCtx({ generate: async () => ({ text: validOutput() }) })
    await draftAgreement(ctx, agreementFacts(), { useLlm: true })
    expect(generate).toHaveBeenCalledTimes(1)
    expect(generate.mock.calls[0][0].systemPrompt).toBe(TEAMING_AGREEMENT_NDA_DRAFT_SYSTEM_PROMPT)
  })

  it('routes through the TEAMING_AGREEMENT_DRAFT task', async () => {
    const { ctx, generate } = makeCtx({ generate: async () => ({ text: validOutput() }) })
    await draftAgreement(ctx, agreementFacts(), { useLlm: true })
    expect(generate.mock.calls[0][1].task).toBe('TEAMING_AGREEMENT_DRAFT')
  })

  it('checks the budget BEFORE reaching the provider', async () => {
    const { ctx, generate, check } = makeCtx({ allowed: false })
    await draftAgreement(ctx, agreementFacts(), { useLlm: true })
    expect(check).toHaveBeenCalled()
    expect(generate).not.toHaveBeenCalled()
  })

  it('records BUDGET_EXHAUSTED and falls back rather than failing', async () => {
    const { ctx } = makeCtx({ allowed: false })
    const result = await draftAgreement(ctx, agreementFacts(), { useLlm: true })
    expect(result.limitations.join(' ')).toContain('BUDGET_EXHAUSTED')
    expect(result.draft.source).toBe('DETERMINISTIC_TEMPLATE')
    expect(result.draft.legalReviewRequired).toBe(true)
  })

  it('never calls the provider when the LLM is not in use', async () => {
    const { ctx, generate, check } = makeCtx()
    const result = await draftAgreement(ctx, agreementFacts(), { useLlm: false })
    expect(generate).not.toHaveBeenCalled()
    expect(check).not.toHaveBeenCalled()
    expect(result.draft.source).toBe('DETERMINISTIC_TEMPLATE')
  })

  it('accepts well-formed output and marks it LLM_ASSISTED', async () => {
    const { ctx } = makeCtx({ generate: async () => ({ text: validOutput() }) })
    const result = await draftAgreement(ctx, agreementFacts(), { useLlm: true })
    expect(result.draft.source).toBe('LLM_ASSISTED')
    expect(result.draft.promptVersion).toBe('teaming-agreement-nda-draft-v1')
    expect(result.draft.clauses[0].draftText).toBe('Model text')
  })

  it('overrides a model that tries to make the document executable', () => {
    const fallback = buildDeterministicAgreementDraft(agreementFacts())
    const { draft, warnings } = parseAgreementLlmOutput(validOutput({ executionAllowed: true }), fallback)
    expect(draft.executionAllowed).toBe(false)
    expect(warnings.join(' ')).toContain('That flag was overridden')
  })

  it('overrides a model that tries to waive legal review', () => {
    const fallback = buildDeterministicAgreementDraft(agreementFacts())
    const { draft, warnings } = parseAgreementLlmOutput(validOutput({ legalReviewRequired: false }), fallback)
    expect(draft.legalReviewRequired).toBe(true)
    expect(warnings.join(' ')).toContain('every generated draft requires legal review')
  })

  it('always re-applies the exact banner, whatever the model said', () => {
    const fallback = buildDeterministicAgreementDraft(agreementFacts())
    const { draft } = parseAgreementLlmOutput(validOutput({ banner: 'READY TO SIGN' }), fallback)
    expect(draft.banner).toBe(LEGAL_REVIEW_BANNER)
  })

  it.each([
    ['not JSON at all', 'this is not json'],
    ['a JSON array', '[]'],
    ['an unrecognised documentType', JSON.stringify({ documentType: 'CONTRACT', clauses: [{ clauseKey: 'a', draftText: 'b', sourceType: 'SUPPLIED_FACT' }] })],
    ['no clauses', JSON.stringify({ documentType: 'NDA', clauses: [] })],
    ['a malformed clause', JSON.stringify({ documentType: 'NDA', clauses: [{ title: 'no key' }] })],
    ['an unrecognised sourceType', JSON.stringify({ documentType: 'NDA', clauses: [{ clauseKey: 'a', draftText: 'b', sourceType: 'MADE_UP' }] })],
  ])('rejects %s and falls back to the template', (_label, raw) => {
    const fallback = buildDeterministicAgreementDraft(agreementFacts())
    const { draft, warnings } = parseAgreementLlmOutput(raw, fallback)
    expect(draft.source).toBe('DETERMINISTIC_TEMPLATE')
    expect(warnings.join(' ')).toContain('deterministic template was used instead')
  })

  it('falls back when the provider throws', async () => {
    const { ctx } = makeCtx({ generate: async () => { throw new Error('provider down') } })
    const result = await draftAgreement(ctx, agreementFacts(), { useLlm: true })
    expect(result.draft.source).toBe('DETERMINISTIC_TEMPLATE')
    expect(result.limitations.join(' ')).toContain('provider down')
  })

  it('falls back when the budget guard throws mid-call', async () => {
    const { ctx } = makeCtx({
      generate: async () => { throw new AgentBudgetExhaustedError('Run budget exhausted', 'RUN') },
    })
    const result = await draftAgreement(ctx, agreementFacts(), { useLlm: true })
    expect(result.limitations.join(' ')).toContain('BUDGET_EXHAUSTED')
    expect(result.draft.executionAllowed).toBe(false)
  })
})

// -------------------------------------------------------------
// LLM path — outreach
// -------------------------------------------------------------

describe('the LLM outreach path', () => {
  const validOutput = (over: Record<string, unknown> = {}) =>
    JSON.stringify({
      status: 'DRAFT', sendAllowed: false, humanSendRequired: true, channel: 'EMAIL',
      recipient: { partnerId: 'partner-1', partnerName: 'Acme Federal', contactName: 'Jordan Lee', contactAddress: 'jordan@acmefederal.example' },
      subject: 'Model subject', message: 'Model message body.',
      whyThisPartner: [{ reason: 'NAICS overlap', evidence: '541512 matches' }],
      proposedDiscussionPoints: ['scope'], unresolvedItems: [], warnings: [],
      ...over,
    })

  it('uses the canonical outreach prompt, alone', async () => {
    const { ctx, generate } = makeCtx({ generate: async () => ({ text: validOutput() }) })
    await draftOutreach(ctx, outreachFacts(), { useLlm: true })
    expect(generate.mock.calls[0][0].systemPrompt).toBe(PARTNER_OUTREACH_DRAFT_SYSTEM_PROMPT)
    expect(generate.mock.calls[0][1].task).toBe('TEAMING_OUTREACH')
  })

  it('checks the budget before reaching the provider', async () => {
    const { ctx, generate } = makeCtx({ allowed: false })
    const result = await draftOutreach(ctx, outreachFacts(), { useLlm: true })
    expect(generate).not.toHaveBeenCalled()
    expect(result.limitations.join(' ')).toContain('BUDGET_EXHAUSTED')
    expect(result.draft.sendAllowed).toBe(false)
  })

  it('overrides a model that tries to mark the message sendable', () => {
    const fallback = buildDeterministicOutreachDraft(outreachFacts())
    const { draft, warnings } = parseOutreachLlmOutput(validOutput({ sendAllowed: true }), fallback)
    expect(draft.sendAllowed).toBe(false)
    expect(draft.humanSendRequired).toBe(true)
    expect(warnings.join(' ')).toContain('never sent by the agent')
  })

  it('keeps OUR contact details, never the model\'s', () => {
    const fallback = buildDeterministicOutreachDraft(outreachFacts())
    const { draft } = parseOutreachLlmOutput(
      validOutput({ recipient: { partnerId: 'x', partnerName: 'Someone Else', contactName: 'Fake', contactAddress: 'hallucinated@example.com' } }),
      fallback,
    )
    expect(draft.recipient.contactAddress).toBe('jordan@acmefederal.example')
    expect(draft.recipient.partnerName).toBe('Acme Federal')
  })

  it.each([
    ['not JSON', 'nope'],
    ['an array', '[]'],
    ['an empty message', JSON.stringify({ status: 'DRAFT', message: '   ' })],
    ['no message at all', JSON.stringify({ status: 'DRAFT' })],
  ])('rejects %s and falls back', (_label, raw) => {
    const fallback = buildDeterministicOutreachDraft(outreachFacts())
    const { draft, warnings } = parseOutreachLlmOutput(raw, fallback)
    expect(draft.source).toBe('DETERMINISTIC_TEMPLATE')
    expect(warnings.join(' ')).toContain('deterministic template was used instead')
  })

  it('accepts well-formed output and keeps the send flags off', async () => {
    const { ctx } = makeCtx({ generate: async () => ({ text: validOutput() }) })
    const result = await draftOutreach(ctx, outreachFacts(), { useLlm: true })
    expect(result.draft.source).toBe('LLM_ASSISTED')
    expect(result.draft.message).toBe('Model message body.')
    expect(result.draft.sendAllowed).toBe(false)
    expect(result.draft.humanSendRequired).toBe(true)
  })
})

// -------------------------------------------------------------
// Payload minimisation
// -------------------------------------------------------------

describe('only the minimum reaches the model', () => {
  it('sends exactly the agreement fields it needs', () => {
    const keys = Object.keys(agreementUserPayload(agreementFacts())).sort()
    expect(keys).toEqual([
      'arrangementType', 'capabilityGapsAddressed', 'certificationEvidence',
      'documentType', 'opportunity', 'parties', 'proposedPartnerContribution', 'workshare',
    ])
  })

  it('sends exactly the outreach fields it needs', () => {
    const keys = Object.keys(outreachUserPayload(outreachFacts())).sort()
    expect(keys).toEqual(['capabilityGaps', 'hasAgreementDraft', 'matchEvidence', 'opportunity', 'partner'])
  })

  it('never sends a contact address to the outreach model', () => {
    expect(JSON.stringify(outreachUserPayload(outreachFacts()))).not.toContain('jordan@acmefederal.example')
  })

  it('never sends internal scoring, notes, or another partner', () => {
    const text = JSON.stringify(agreementUserPayload(agreementFacts())) + JSON.stringify(outreachUserPayload(outreachFacts()))
    for (const leak of ['weight', 'probability', 'notes', 'apiKey', 'competitor', 'otherPartner']) {
      expect(text.toLowerCase(), leak).not.toContain(leak.toLowerCase())
    }
  })
})

// -------------------------------------------------------------
// No send path exists at all
// -------------------------------------------------------------

describe('nothing in the drafting module can send', () => {
  it('imports no mail transport and no messaging client', async () => {
    const { readFileSync } = await import('fs')
    const { join } = await import('path')
    const src = readFileSync(join(__dirname, 'teamingDrafts.ts'), 'utf8')
    for (const forbidden of ['nodemailer', 'emailService', 'sendMail', 'twilio', 'sendgrid', 'axios.post']) {
      expect(src.toLowerCase(), forbidden).not.toContain(forbidden.toLowerCase())
    }
  })
})
