import { describe, it, expect } from 'vitest'
import { extractRequirements } from './clauseExtractor.gb107'

describe('GB-107 clause extractor', () => {
  it('extracts FAR clauses with and without the FAR prefix, deduplicated', () => {
    const text =
      'Offerors shall comply with FAR 52.212-1 Instructions to Offerors. ' +
      'See also 52.212-4 and again FAR 52.212-1 for terms.'
    const { requirements, summary } = extractRequirements(text)
    const farRefs = requirements.filter((r) => r.requirementType === 'FAR_CLAUSE').map((r) => r.reference)
    expect(farRefs).toEqual(['52.212-1', '52.212-4'])
    expect(summary.far).toEqual(['52.212-1', '52.212-4'])
  })

  it('extracts DFARS clauses in the 252.2xx-7xxx range only', () => {
    const text =
      'This solicitation incorporates DFARS 252.204-7012 Safeguarding Covered Defense Information ' +
      'and 252.225-7001. The number 252.999-1234 is not a DFARS clause.'
    const { summary } = extractRequirements(text)
    expect(summary.dfars).toEqual(['252.204-7012', '252.225-7001'])
  })

  it('marks clauses mandatory when context says shall/must, informational when may/if applicable', () => {
    const mandatory = extractRequirements('The contractor shall comply with 52.219-14.')
    expect(mandatory.requirements[0].isMandatory).toBe(true)

    const informational = extractRequirements('Clause 52.219-14 may apply if applicable to your quote.')
    expect(informational.requirements[0].isMandatory).toBe(false)
  })

  it('defaults clauses cited without modal language to mandatory', () => {
    const { requirements } = extractRequirements('Incorporated clauses: 52.204-7, 52.204-13.')
    expect(requirements.every((r) => r.isMandatory)).toBe(true)
  })

  it('detects evaluation factors, submission requirements, and delivery terms', () => {
    const text =
      'Award will be made on a best value basis considering the evaluation factors below. ' +
      'Quotes are due no later than 3:00 PM CT and shall not exceed 10 pages. ' +
      'FOB Destination. Period of performance is 12 months.'
    const { requirements, summary } = extractRequirements(text)
    expect(summary.evalFactors).toBeGreaterThanOrEqual(2) // best value + evaluation factors
    expect(summary.submissionReqs).toBeGreaterThanOrEqual(2) // due no later than + shall not exceed
    expect(summary.deliveryReqs).toBeGreaterThanOrEqual(2) // fob destination + period of performance
    const submission = requirements.filter((r) => r.requirementType === 'SUBMISSION_REQ')
    expect(submission.every((r) => r.isMandatory)).toBe(true)
  })

  it('includes surrounding context capped at 500 chars', () => {
    const filler = 'x'.repeat(1000)
    const text = `${filler} FAR 52.212-1 applies here ${filler}`
    const { requirements } = extractRequirements(text)
    expect(requirements[0].extractedText.length).toBeLessThanOrEqual(500)
    expect(requirements[0].extractedText).toContain('52.212-1')
  })

  it('returns empty results for text without requirements', () => {
    const { requirements, summary } = extractRequirements('General notice about an industry day event.')
    expect(requirements).toEqual([])
    expect(summary.far).toEqual([])
    expect(summary.dfars).toEqual([])
  })
})
