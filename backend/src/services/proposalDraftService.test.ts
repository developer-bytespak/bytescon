// =============================================================
// proposalDraftService — offeror-binding tests
//
// Regression guard for the "proposal generated for a random company" bug: the
// draft must be written for the REAL selected offeror, lead from the agency's
// needs, and must NOT instruct the model to fabricate a company/past performance.
// The LLM router is mocked so we can assert exactly what prompt is sent.
// =============================================================
import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('./llm/llmRouter', () => ({ generateWithRouter: vi.fn() }))
vi.mock('./far/farGroundedComplete', () => ({ farGroundedComplete: vi.fn() }))
vi.mock('../utils/logger', () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}))

import { generateProposalDraft, OfferorProfile, buildPastPerformanceBlock } from './proposalDraftService'
import { generateWithRouter } from './llm/llmRouter'

const gen = generateWithRouter as unknown as ReturnType<typeof vi.fn>

const OFFEROR: OfferorProfile = {
  legalName: 'Bytes Platform',
  uei: 'ABC123DEF456',
  cage: '9XYZ1',
  naicsCodes: ['484121'],
  setAsides: ['SDVOSB (Service-Disabled Veteran-Owned Small Business)'],
  contractVehicles: [],
  location: 'Dallas, TX',
  website: null,
  source: 'CLIENT_COMPANY',
}

const VALID = JSON.stringify({
  sections: [{ title: 'Executive Summary', content: 'x'.repeat(120) }],
})

async function run() {
  gen.mockResolvedValue({ text: VALID })
  const draft = await generateProposalDraft(
    'Freight Brokerage Services',
    'Department of Veterans Affairs',
    [],
    { naicsCode: '484121' },
    'firm-1',
    OFFEROR,
    [],
    undefined,
    undefined,
    null, // opportunityId null → uses generateWithRouter (the mocked path)
    null,
  )
  const call = gen.mock.calls[0][0] as { systemPrompt: string; userPrompt: string }
  return { draft, ...call }
}

describe('generateProposalDraft — offeror binding (no fabricated company)', () => {
  beforeEach(() => gen.mockReset())

  it('injects the real offeror legal name + profile into the prompt', async () => {
    const { userPrompt } = await run()
    expect(userPrompt).toContain('Bytes Platform')
    expect(userPrompt).toContain('OFFEROR PROFILE')
    expect(userPrompt).toContain('ABC123DEF456') // UEI verbatim
    expect(userPrompt).toContain('SDVOSB')
  })

  it('leads with the agency needs as the focal point', async () => {
    const { userPrompt } = await run()
    expect(userPrompt).toContain('AGENCY NEEDS')
    expect(userPrompt).toContain('Department of Veterans Affairs')
  })

  it('system prompt forbids inventing a company or past performance', async () => {
    const { systemPrompt } = await run()
    expect(systemPrompt).toMatch(/never invent/i)
    expect(systemPrompt).toContain('[TO BE PROVIDED BY OFFEROR]')
    // The old fabrication driver must be gone.
    expect(systemPrompt).not.toContain('Fill in realistic, professional content throughout')
  })

  it('returns the parsed draft for the right opportunity', async () => {
    const { draft } = await run()
    expect(draft.sections.length).toBeGreaterThan(0)
    expect(draft.opportunityTitle).toBe('Freight Brokerage Services')
    expect(draft.agency).toBe('Department of Veterans Affairs')
  })
})

describe('generateProposalDraft — per-section confidence flags (FIX-6 follow-up)', () => {
  beforeEach(() => gen.mockReset())

  it('instructs the model to self-assess confidence on every section', async () => {
    const { systemPrompt } = await run()
    expect(systemPrompt).toContain('CONFIDENCE SELF-ASSESSMENT')
    expect(systemPrompt).toContain('"HIGH", "MEDIUM", "LOW"')
    expect(systemPrompt).toContain('"confidence": "HIGH"') // present in the JSON example
  })

  it('carries valid confidence values through and drops invalid ones', async () => {
    gen.mockResolvedValue({
      text: JSON.stringify({
        sections: [
          { title: 'Executive Summary', content: 'x'.repeat(120), confidence: 'HIGH' },
          { title: 'Past Performance', content: 'y'.repeat(120), confidence: 'LOW' },
          { title: 'Staffing Plan', content: 'z'.repeat(120), confidence: 'certain' }, // not a valid enum
          { title: 'Price Approach', content: 'w'.repeat(120) }, // absent
        ],
      }),
    })
    const draft = await generateProposalDraft(
      'X', 'Y', [], { naicsCode: '1' }, 'firm-1', OFFEROR, [], undefined, undefined, null, null,
    )
    expect(draft.sections.map(s => s.confidence)).toEqual(['HIGH', 'LOW', undefined, undefined])
  })
})

describe('buildPastPerformanceBlock', () => {
  it('returns empty string for no records', () => {
    expect(buildPastPerformanceBlock([])).toBe('')
  })

  it('formats a record with contract, customer, value, and CPARS', () => {
    const block = buildPastPerformanceBlock([
      {
        contractNumber: 'SAM-NOTICE1',
        customerName: 'General Services Administration',
        customerAgency: 'FAS',
        contractType: 'FFP',
        totalValue: '1500000',
        cparsRating: 'VERY_GOOD',
        scopeSummary: 'Enterprise IT support services',
      },
    ])
    expect(block).toContain('OFFEROR PAST PERFORMANCE')
    expect(block).toContain('SAM-NOTICE1')
    expect(block).toContain('General Services Administration')
    expect(block).toContain('$1,500,000')
    expect(block).toContain('VERY GOOD') // underscores stripped for prose
    expect(block).toContain('Enterprise IT support services')
  })
})

describe('generateProposalDraft — past-performance records injection', () => {
  beforeEach(() => gen.mockReset())

  it('injects supplied past-performance records into the prompt', async () => {
    gen.mockResolvedValue({ text: VALID })
    await generateProposalDraft(
      'Freight Brokerage Services',
      'Department of Veterans Affairs',
      [],
      { naicsCode: '484121' },
      'firm-1',
      OFFEROR,
      [],
      undefined,
      undefined,
      null,
      null,
      [{ contractNumber: 'C-100', customerName: 'VA', scopeSummary: 'Brokered LTL freight' }],
    )
    const { userPrompt } = gen.mock.calls[0][0] as { userPrompt: string }
    // Key on the block delimiter — the bare phrase also appears in the static
    // Past Performance section instruction, so it can't distinguish injection.
    expect(userPrompt).toContain('=== OFFEROR PAST PERFORMANCE')
    expect(userPrompt).toContain('C-100')
    expect(userPrompt).toContain('Brokered LTL freight')
  })

  it('omits the block when no records are supplied (back-compat)', async () => {
    gen.mockResolvedValue({ text: VALID })
    await generateProposalDraft(
      'X',
      'Y',
      [],
      { naicsCode: '1' },
      'firm-1',
      OFFEROR,
      [],
      undefined,
      undefined,
      null,
      null,
    )
    const { userPrompt } = gen.mock.calls[0][0] as { userPrompt: string }
    expect(userPrompt).not.toContain('=== OFFEROR PAST PERFORMANCE')
  })
})
