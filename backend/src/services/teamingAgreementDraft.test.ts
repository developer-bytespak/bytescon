// =============================================================
// Teaming agreement draft builder — disclaimer, verbatim system prompt,
// placeholders for missing data, no fabrication, unsigned signature blocks.
// =============================================================
import { describe, it, expect } from 'vitest'
import { buildAgreementDraft, TEAMING_AGREEMENT_SYSTEM_PROMPT, DRAFT_DISCLAIMER, DRAFT_CLOSING, AgreementDraftInput } from './teamingAgreementDraft'

const input = (over: Partial<AgreementDraftInput> = {}): AgreementDraftInput => ({
  draftType: 'TEAMING_AGREEMENT', firmName: 'Bytes Platform', partnerName: 'Acme Federal Inc',
  partnerRole: 'SUB', arrangementType: 'TEAMING_AGREEMENT', opportunityTitle: 'Radar Sustainment',
  agency: 'Department of the Navy', solicitationNumber: 'SOL-1', scopePercent: 30,
  workshareDescription: 'Cyber hardening tasks', capabilityContribution: 'Cybersecurity engineering', ...over,
})

describe('TEAMING_AGREEMENT_SYSTEM_PROMPT', () => {
  it('is the exact verbatim prompt (unshortened, key clauses present)', () => {
    expect(TEAMING_AGREEMENT_SYSTEM_PROMPT).toContain('You are the Teaming Agreement Drafting Assistant inside Bytescon.')
    expect(TEAMING_AGREEMENT_SYSTEM_PROMPT).toContain('DRAFT FOR REVIEW — NOT LEGAL ADVICE — NOT EXECUTED.')
    expect(TEAMING_AGREEMENT_SYSTEM_PROMPT).toContain('[GOVERNING LAW TO BE REVIEWED]')
    expect(TEAMING_AGREEMENT_SYSTEM_PROMPT).toContain('This document requires review and approval by authorized representatives and qualified legal counsel before use or execution.')
    expect(TEAMING_AGREEMENT_SYSTEM_PROMPT).toContain('Return only the agreement draft. Do not add commentary outside the document.')
  })
})

describe('buildAgreementDraft', () => {
  it('opens with the mandatory disclaimer and ends with the mandatory closing', () => {
    const d = buildAgreementDraft(input())
    expect(d.startsWith(DRAFT_DISCLAIMER)).toBe(true)
    expect(d.trim().endsWith(DRAFT_CLOSING)).toBe(true)
  })
  it('uses supplied data exactly and marks signatures UNSIGNED', () => {
    const d = buildAgreementDraft(input())
    expect(d).toContain('Bytes Platform')
    expect(d).toContain('Acme Federal Inc')
    expect(d).toContain('30%')
    expect(d).toContain('Cybersecurity engineering')
    expect(d).toContain('[UNSIGNED]')
    expect(d).not.toMatch(/has been (signed|executed|approved)/i)
  })
  it('inserts labelled placeholders for missing data (no fabrication)', () => {
    const d = buildAgreementDraft(input({ agency: null, solicitationNumber: null, scopePercent: null, workshareDescription: null, capabilityContribution: null }))
    expect(d).toContain('[WORKSHARE PERCENTAGE REQUIRED]')
    expect(d).toContain('[GOVERNING LAW TO BE REVIEWED]')
    expect(d).toContain('[AGENCY TO BE CONFIRMED]')
  })
  it('produces an NDA-flavoured draft with confidentiality terms', () => {
    const d = buildAgreementDraft(input({ draftType: 'NDA' }))
    expect(d).toContain('NON-DISCLOSURE AGREEMENT — DRAFT')
    expect(d).toMatch(/Confidential Information/)
  })
})
