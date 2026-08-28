// =============================================================
// Proposal section drafting — exact system prompt, deterministic no-key fallback
// (label + placeholders + Human Review Required, no fabrication), and the
// deterministic outline-from-requirements.
// =============================================================
import { describe, it, expect } from 'vitest'
import { PROPOSAL_DRAFTING_SYSTEM_PROMPT, AI_DRAFT_LABEL, buildDeterministicSectionDraft, buildOutlineFromRequirements, SectionDraftInput } from './proposalSectionDraft'

describe('PROPOSAL_DRAFTING_SYSTEM_PROMPT', () => {
  it('is the exact verbatim prompt (key clauses present, unshortened)', () => {
    expect(PROPOSAL_DRAFTING_SYSTEM_PROMPT).toContain('You are the Proposal Drafting Assistant inside Bytescon.')
    expect(PROPOSAL_DRAFTING_SYSTEM_PROMPT).toContain('[TECHNICAL APPROACH REQUIRES HUMAN INPUT]')
    expect(PROPOSAL_DRAFTING_SYSTEM_PROMPT).toContain('“AI-GENERATED DRAFT — REQUIRES HUMAN REVIEW.”')
    expect(PROPOSAL_DRAFTING_SYSTEM_PROMPT).toContain('End with a “Human Review Required” section listing every placeholder, unsupported item, conflict, and verification needed before approval.')
    expect(PROPOSAL_DRAFTING_SYSTEM_PROMPT).toContain('Return only the proposal-section draft. Do not add commentary outside the draft.')
  })
})

const input = (over: Partial<SectionDraftInput> = {}): SectionDraftInput => ({
  sectionTitle: 'Technical Approach', requirementText: 'Describe your technical approach.', evaluationCriteria: null,
  companyCapabilities: null, approvedPastPerformance: null, userNotes: null, ...over,
})

describe('buildDeterministicSectionDraft', () => {
  it('is clearly AI-labelled and ends with Human Review Required', () => {
    const d = buildDeterministicSectionDraft(input())
    expect(d.startsWith(AI_DRAFT_LABEL)).toBe(true)
    expect(d).toContain('Human Review Required')
  })
  it('inserts placeholders for missing facts and never fabricates', () => {
    const d = buildDeterministicSectionDraft(input())
    expect(d).toContain('[APPROVED CAPABILITY CONTENT REQUIRED]')
    expect(d).toContain('[PAST PERFORMANCE EXAMPLE REQUIRED]')
    expect(d).toContain('[APPROVED METRIC REQUIRED]')
    // No invented specifics
    expect(d).not.toMatch(/\$\d/)
    expect(d).not.toMatch(/contract (no|number)\s*[:#]?\s*\w/i)
  })
  it('uses supplied approved content verbatim when provided', () => {
    const d = buildDeterministicSectionDraft(input({ companyCapabilities: 'ISO 9001 certified cloud engineering', approvedPastPerformance: 'Navy SeaPort-NxG task order (approved record)' }))
    expect(d).toContain('ISO 9001 certified cloud engineering')
    expect(d).toContain('Navy SeaPort-NxG task order (approved record)')
  })
})

describe('buildOutlineFromRequirements', () => {
  it('groups requirements into ordered section stubs by suggested section / type', () => {
    const outline = buildOutlineFromRequirements([
      { requirementText: 'Submit technical approach.', proposalSection: 'Technical', sectionType: 'INSTRUCTION', isMandatory: true },
      { requirementText: 'Address staffing.', proposalSection: 'Technical', sectionType: 'INSTRUCTION', isMandatory: true },
      { requirementText: 'Provide SF-1449.', proposalSection: null, sectionType: 'DOCUMENT', isMandatory: true },
    ])
    expect(outline[0].title).toBe('Technical') // 2 reqs → first
    expect(outline[0].requirementCount).toBe(2)
    expect(outline.some((s) => s.title === 'Required Forms & Attachments')).toBe(true)
  })
  it('returns an empty outline when there are no requirements', () => {
    expect(buildOutlineFromRequirements([])).toEqual([])
  })
})
