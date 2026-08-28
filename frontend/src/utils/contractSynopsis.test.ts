import { describe, it, expect } from 'vitest'
import { buildContractSynopsis } from './contractSynopsis'

describe('buildContractSynopsis', () => {
  it('returns empty string for empty / undefined input', () => {
    expect(buildContractSynopsis(undefined)).toBe('')
    expect(buildContractSynopsis('')).toBe('')
    expect(buildContractSynopsis('   ')).toBe('')
  })

  it('strips HTML + FAR boilerplate and leads with the real purpose sentence', () => {
    const input =
      '<p>This is a combined synopsis/solicitation for commercial items prepared in accordance with the format in FAR Subpart 12.6, as supplemented with additional information included in this notice.</p>' +
      '<p>The Department of Veterans Affairs intends to procure janitorial services for the VA Medical Center in St. Louis, MO. The contractor shall provide all labor, supervision, equipment, and materials necessary to perform custodial services.</p>'
    const out = buildContractSynopsis(input)
    expect(out).toMatch(/^The Department of Veterans Affairs intends to procure janitorial services/)
    expect(out).not.toMatch(/combined synopsis|Subpart 12\.6|in accordance with the format/i)
    // "St. Louis, MO." must not be split mid-abbreviation
    expect(out).toContain('St. Louis, MO.')
    expect(out).not.toMatch(/<[^>]+>/)
  })

  it('decodes HTML entities and protects "U.S." from sentence splitting', () => {
    const input =
      'The U.S. Army Corps of Engineers requires construction of a new flood-control levee. &nbsp;The contractor shall furnish all materials &amp; labor. Period of performance is 365 days.'
    const out = buildContractSynopsis(input)
    expect(out).toContain('The U.S. Army Corps of Engineers')
    expect(out).toContain('materials & labor')
    expect(out).not.toContain('&amp;')
    expect(out).not.toContain('&nbsp;')
  })

  it('protects company abbreviations and numeric values', () => {
    const input =
      'Acme Federal Inc. shall provide IT help-desk support. Support is required 24/7. Response time must not exceed 2 hours.'
    const out = buildContractSynopsis(input)
    expect(out).toContain('Acme Federal Inc. shall provide IT help-desk support.')
    expect(out).toContain('24/7')
  })

  it('keeps a numbered requirement list as coherent sentences (does not shatter on "1.")', () => {
    const input =
      'Requirement: 1. Provide grounds maintenance. 2. Maintain irrigation systems. 3. Remove snow and ice within 4 hours of accumulation.'
    const out = buildContractSynopsis(input)
    expect(out).toContain('1. Provide grounds maintenance.')
    expect(out).toContain('2. Maintain irrigation systems.')
    expect(out).toContain('3. Remove snow and ice within 4 hours of accumulation.')
  })

  it('returns empty for boilerplate-only notices so the caller can fall back to a NAICS line', () => {
    expect(buildContractSynopsis('This is a sources sought notice issued in accordance with FAR 5.201.')).toBe('')
    expect(buildContractSynopsis('https://sam.gov/opp/abc123/view  This is a presolicitation notice issued in accordance with FAR 5.201.')).toBe('')
  })

  // ── Bug fix 1: sources-sought / market-research admin filler leak ──
  it('drops content-free sources-sought / market-research admin sentences', () => {
    const input =
      'This notice is a sources sought notice. This is for market research only. No proposals are being requested at this time.'
    expect(buildContractSynopsis(input)).toBe('')
  })

  it('drops "for ... purposes only" admin tails (informational / market research)', () => {
    expect(buildContractSynopsis('This RFI is for informational purposes only.')).toBe('')
    expect(buildContractSynopsis('This is for market research purposes only.')).toBe('')
  })

  it('does NOT over-suppress a sentence that embeds real scope after "only"', () => {
    const input =
      'This sources sought is issued for market research purposes only to identify firms capable of janitorial services at Fort Bragg.'
    const out = buildContractSynopsis(input)
    expect(out).toContain('janitorial services at Fort Bragg')
  })

  // ── Bug fix 2: HTML table cell residue merging into the lead sentence ──
  it('does not let HTML table cell text run into the synopsis', () => {
    const input =
      '<table><tr><th>Item</th><th>Qty</th></tr><tr><td>Widgets</td><td>500</td></tr></table>' +
      '<p>The contractor shall deliver 500 widgets to the depot in Norfolk, VA within 90 days.</p>'
    const out = buildContractSynopsis(input)
    expect(out).toBe('The contractor shall deliver 500 widgets to the depot in Norfolk, VA within 90 days.')
    expect(out).not.toMatch(/Item|Qty|Widgets 500/)
  })

  it('drops table-cell fragments sitting between two real sentences (keeps both sentences)', () => {
    const input =
      '<p>The contractor shall provide widgets.</p>' +
      '<table><tr><td>Item</td><td>Qty</td></tr></table>' +
      '<p>Delivery is to Norfolk, VA.</p>'
    const out = buildContractSynopsis(input)
    expect(out).toContain('The contractor shall provide widgets.')
    expect(out).toContain('Delivery is to Norfolk, VA.')
    expect(out).not.toMatch(/\bItem\b|\bQty\b/)
  })

  it('caps the output to 3 sentences, dropping trailing FAR boilerplate', () => {
    const input =
      'The Department of Energy seeks a contractor to operate and maintain the central utility plant at the National Laboratory campus in Oak Ridge, Tennessee. ' +
      'The contractor shall provide all personnel, equipment, and consumables required to deliver chilled water, steam, and compressed air on a 24/7 basis. ' +
      'Services include preventive and corrective maintenance of boilers, chillers, and the building automation system across forty-two facilities. ' +
      'The provisions and clauses incorporated by reference apply. The Government intends to award a single firm-fixed-price contract.'
    const out = buildContractSynopsis(input)
    expect(out).toMatch(/^The Department of Energy seeks a contractor/)
    expect(out).not.toMatch(/provisions and clauses|incorporated by reference|intends to award/i)
    expect(out.length).toBeLessThanOrEqual(480)
  })

  it('truncates a single very long sentence with an ellipsis at a word boundary', () => {
    const longSentence =
      'The contractor shall provide ' + 'comprehensive operations and maintenance services '.repeat(20) + 'across all facilities.'
    const out = buildContractSynopsis(longSentence)
    expect(out.length).toBeLessThanOrEqual(480)
    expect(out.endsWith('…')).toBe(true)
    // ellipsis is appended directly after a whole word — no dangling space and
    // no partial-word fragment before it
    expect(out).toMatch(/\w…$/)
    expect(out).not.toMatch(/\s…$/)
  })
})
