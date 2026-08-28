// =============================================================
// Compliance extraction — exact system prompt, JSON validation, dedup-vs-existing.
// =============================================================
import { describe, it, expect } from 'vitest'
import { COMPLIANCE_EXTRACTION_SYSTEM_PROMPT, parseAndValidateRequirements, dedupeAgainstExisting } from './complianceExtraction'

describe('COMPLIANCE_EXTRACTION_SYSTEM_PROMPT', () => {
  it('is the exact verbatim prompt (key clauses present, unshortened)', () => {
    expect(COMPLIANCE_EXTRACTION_SYSTEM_PROMPT).toContain('You are the Solicitation Compliance Extraction Assistant inside Bytescon.')
    expect(COMPLIANCE_EXTRACTION_SYSTEM_PROMPT).toContain('Do not invent, infer, assume, or add requirements that are not supported by the supplied solicitation.')
    expect(COMPLIANCE_EXTRACTION_SYSTEM_PROMPT).toContain('"requirementType": "INSTRUCTION | EVALUATION | FORMAT | SUBMISSION | DOCUMENT | CERTIFICATION | DEADLINE | DELIVERABLE | OTHER"')
    expect(COMPLIANCE_EXTRACTION_SYSTEM_PROMPT).toContain('Return valid JSON only. Do not include markdown, explanations, or commentary outside the JSON.')
  })
})

describe('parseAndValidateRequirements', () => {
  it('parses a valid array and preserves evidence + source refs', () => {
    const raw = JSON.stringify([
      { sourceSection: 'L.4.1', sourcePageNumber: 12, evidenceText: 'shall submit a technical approach', requirementText: 'Submit a technical approach not to exceed 20 pages.', requirementType: 'INSTRUCTION', mandatory: true, suggestedProposalSection: 'Technical', ownerUserId: 'hacker', status: 'NOT_STARTED', extractionMethod: 'AI', extractionConfidence: 0.9, reviewRequired: false, reviewReason: null },
    ])
    const { requirements, errors } = parseAndValidateRequirements(raw)
    expect(errors).toEqual([])
    expect(requirements[0].requirementText).toMatch(/technical approach/)
    expect(requirements[0].evidenceText).toBe('shall submit a technical approach')
    expect(requirements[0].sourcePageNumber).toBe(12)
    expect(requirements[0].ownerUserId).toBeNull() // model-supplied owner is never trusted
  })
  it('drops rows without requirementText and coerces bad types', () => {
    const raw = JSON.stringify([
      { requirementText: '', requirementType: 'INSTRUCTION' },
      { requirementText: 'Provide SF-1449.', requirementType: 'NONSENSE', mandatory: 'yes', extractionConfidence: 5 },
    ])
    const { requirements } = parseAndValidateRequirements(raw)
    expect(requirements.length).toBe(1)
    expect(requirements[0].requirementType).toBe('OTHER') // unknown type coerced
    expect(requirements[0].mandatory).toBe(false) // non-true is not mandatory
    expect(requirements[0].extractionConfidence).toBe(1) // clamped to [0,1]
  })
  it('returns an error for non-JSON and non-array output', () => {
    expect(parseAndValidateRequirements('not json').errors.length).toBeGreaterThan(0)
    expect(parseAndValidateRequirements('{"a":1}').errors[0]).toMatch(/array/i)
  })
  it('tolerates a ```json code fence', () => {
    const raw = '```json\n[{"requirementText":"X","requirementType":"OTHER"}]\n```'
    expect(parseAndValidateRequirements(raw).requirements.length).toBe(1)
  })
})

describe('dedupeAgainstExisting', () => {
  it('removes new rows duplicating existing (verified) requirements, and within-batch dups', () => {
    const fresh = parseAndValidateRequirements(JSON.stringify([
      { requirementText: 'Submit a technical approach not to exceed 20 pages.', requirementType: 'INSTRUCTION' },
      { requirementText: 'submit a  Technical Approach not to exceed 20 pages.  ', requirementType: 'INSTRUCTION' }, // dup (normalized)
      { requirementText: 'Provide past performance references.', requirementType: 'SUBMISSION' },
    ])).requirements
    const existing = [{ requirementText: 'Provide past performance references.' }]
    const result = dedupeAgainstExisting(fresh, existing)
    expect(result.length).toBe(1) // only the technical-approach one, deduped within batch + vs existing
    expect(result[0].requirementText).toMatch(/technical approach/i)
  })
})
