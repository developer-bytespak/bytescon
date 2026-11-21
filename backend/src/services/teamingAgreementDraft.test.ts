// =============================================================
// Teaming agreement draft builder — disclaimer, verbatim system prompt,
// placeholders for missing data, no fabrication, unsigned signature blocks.
// =============================================================
import { describe, it, expect } from 'vitest'
import { buildAgreementDraft, partiesOf, TEAMING_AGREEMENT_SYSTEM_PROMPT, DRAFT_DISCLAIMER, DRAFT_CLOSING, AgreementDraftInput } from './teamingAgreementDraft'

const input = (over: Partial<AgreementDraftInput> = {}): AgreementDraftInput => ({
  draftType: 'TEAMING_AGREEMENT', bidderName: 'Bytes Platform', partnerName: 'Acme Federal Inc',
  partnerRole: 'SUB', arrangementType: 'TEAMING_AGREEMENT', opportunityTitle: 'Radar Sustainment',
  agency: 'Department of the Navy', solicitationNumber: 'SOL-1', scopePercent: 30,
  workshareDescription: 'Cyber hardening tasks', capabilityContribution: 'Cybersecurity engineering', ...over,
})

describe('TEAMING_AGREEMENT_SYSTEM_PROMPT', () => {
  it('is the exact verbatim prompt (unshortened, key clauses present)', () => {
    expect(TEAMING_AGREEMENT_SYSTEM_PROMPT).toContain('You are the Teaming Agreement Drafting Assistant inside Bytesgov.')
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

describe('the parties are the company bidding and the partner, in their roles on the bid', () => {
  it('a partner who is a sub makes the bidder the prime', () => {
    const d = buildAgreementDraft(input({ bidderName: 'Meridian Federal', partnerRole: 'SUB' }))
    expect(d).toContain('- Prime contractor: Meridian Federal')
    expect(d).toContain('- Subcontractor: Acme Federal Inc')
    expect(d).toContain('as prime contractor and subcontractor')
  })

  it('a partner who is the prime makes the bidder the sub', () => {
    const parties = partiesOf({ bidderName: 'Meridian Federal', partnerName: 'Big Prime Co', partnerRole: 'PRIME' })
    expect(parties).toEqual([{ title: 'Prime contractor', name: 'Big Prime Co' }, { title: 'Subcontractor', name: 'Meridian Federal' }])
  })

  it('leaves a placeholder rather than naming anyone when the bidder is not recorded', () => {
    const d = buildAgreementDraft(input({ bidderName: null }))
    expect(d).toContain('- Prime contractor: [LEGAL NAME REQUIRED]')
    expect(d).toContain('[BIDDING COMPANY LEGAL NAME REQUIRED]')
  })

  it('a joint venture lists both as members', () => {
    expect(buildAgreementDraft(input({ partnerRole: 'JV_MEMBER' }))).toContain('as joint venture members')
  })
})
