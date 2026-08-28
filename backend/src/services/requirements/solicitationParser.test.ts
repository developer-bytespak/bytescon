// =============================================================
// §6.3A — Deterministic solicitation parsing.
//
// Under test: separate obligations stay separate, mandatory language drives the
// mandatory flag, section evidence is preserved, clause flow-down is classified
// conservatively, undated milestones are flagged for review, and reprocessing
// the same text produces identical fingerprints (the duplicate guard).
// =============================================================
import { describe, it, expect } from 'vitest'
import {
  parseSolicitation,
  classifyRequirement,
  splitSentences,
  annotateLines,
  parseClauses,
  parseMilestones,
  extractDate,
  requirementFingerprint,
  hashContent,
  EXTRACTOR_VERSION,
} from './solicitationParser'

const SOLICITATION = `
SECTION L INSTRUCTIONS TO OFFERORS
L.1 General
The offeror shall submit a technical volume not to exceed 30 pages. The technical volume must be submitted as a PDF.
L.2 Format
Proposals shall use Times New Roman 12 point type with one inch margins.
Page 4
L.3 Submission
Proposals must be received no later than 03/15/2027. Offerors should acknowledge all amendments.
The offeror shall provide a capability statement and resumes for all key personnel.
SECTION M EVALUATION FACTORS
M.1 Technical Approach
The Government will evaluate the technical volume for feasibility and completeness. Proposals will be evaluated on the soundness of the technical approach.
M.2 Past Performance
The Government shall evaluate past performance relevance and recency.
SECTION I CONTRACT CLAUSES
FAR 52.204-7 System for Award Management. The Contractor shall insert the substance of this clause in all subcontracts.
DFARS 252.204-7012 Safeguarding Covered Defense Information. This clause applies to subcontracts that exceed the micro-purchase threshold.
FAR 52.222-50 Combating Trafficking in Persons.
Questions are due no later than 02/01/2027.
A site visit will be held on March 1, 2027.
`

describe('splitSentences', () => {
  it('splits on sentence boundaries and keeps abbreviations intact', () => {
    const sentences = splitSentences('The offeror shall submit a volume. U.S. citizens must apply. Done.')
    expect(sentences).toHaveLength(3)
    expect(sentences[1]).toContain('U.S. citizens')
  })
})

describe('annotateLines', () => {
  it('attaches the nearest section heading and page marker to each line', () => {
    const lines = annotateLines(SOLICITATION)
    const formatLine = lines.find((l) => l.text.includes('Times New Roman'))
    expect(formatLine?.section).toBe('L.2')
    const submissionLine = lines.find((l) => l.text.includes('no later than 03/15/2027'))
    expect(submissionLine?.page).toBe(4)
  })
})

describe('classifyRequirement', () => {
  it('uses the section letter as the strongest signal', () => {
    expect(classifyRequirement('The Government will evaluate the approach.', 'M.1')).toEqual({ type: 'EVALUATION', lmRole: 'EVALUATION' })
    expect(classifyRequirement('The offeror shall submit a narrative.', 'L.1').lmRole).toBe('INSTRUCTION')
  })

  it('classifies format, submission, certification and deadline wording', () => {
    expect(classifyRequirement('Use Times New Roman 12 point type.', 'L.2').type).toBe('FORMAT')
    expect(classifyRequirement('Proposals must be received by the deadline.', 'L.3').type).toBe('SUBMISSION')
    expect(classifyRequirement('The offeror shall provide a signed SF-33.', 'L.4').type).toBe('CERTIFICATION')
  })
})

describe('parseSolicitation — requirements', () => {
  const result = parseSolicitation(SOLICITATION, { documentName: 'RFP.pdf' })

  it('reports the extractor version and a content hash', () => {
    expect(result.extractorVersion).toBe(EXTRACTOR_VERSION)
    expect(result.sourceHash).toBe(hashContent(SOLICITATION))
    expect(result.sourceHash).toHaveLength(64)
  })

  it('keeps separate obligations in one paragraph as separate requirements', () => {
    const l1 = result.requirements.filter((r) => r.sourceSection === 'L.1')
    // "shall submit a technical volume…" and "must be submitted as a PDF" are
    // two obligations in one paragraph and must not be merged.
    expect(l1.length).toBeGreaterThanOrEqual(2)
  })

  it('marks a requirement mandatory only on mandatory language', () => {
    const mandatory = result.requirements.find((r) => r.requirementText.includes('shall submit a technical volume'))
    expect(mandatory?.isMandatory).toBe(true)
    const conditional = result.requirements.find((r) => r.requirementText.includes('should acknowledge all amendments'))
    expect(conditional?.isMandatory).toBe(false)
  })

  it('separates Section L instructions from Section M evaluation factors', () => {
    const instructions = result.requirements.filter((r) => r.lmRole === 'INSTRUCTION')
    const evaluations = result.requirements.filter((r) => r.lmRole === 'EVALUATION')
    expect(instructions.length).toBeGreaterThan(0)
    expect(evaluations.length).toBeGreaterThan(0)
    expect(evaluations.every((e) => e.sourceSection?.startsWith('M'))).toBe(true)
  })

  it('preserves source section and evidence text on every requirement', () => {
    for (const req of result.requirements) {
      expect(req.evidenceText.length).toBeGreaterThan(0)
      expect(req.fingerprint).toHaveLength(40)
    }
  })

  it('only extracts obligation-bearing sentences, not narrative prose', () => {
    expect(result.requirements.some((r) => r.requirementText.includes('SECTION L INSTRUCTIONS'))).toBe(false)
  })
})

describe('parseSolicitation — duplicate prevention', () => {
  it('produces identical fingerprints on reprocessing (so nothing duplicates)', () => {
    const a = parseSolicitation(SOLICITATION)
    const b = parseSolicitation(SOLICITATION)
    expect(a.requirements.map((r) => r.fingerprint)).toEqual(b.requirements.map((r) => r.fingerprint))
  })

  it('fingerprints ignore case and punctuation but not the section', () => {
    expect(requirementFingerprint('L.1', 'The offeror SHALL submit.')).toBe(requirementFingerprint('L.1', 'the offeror shall submit'))
    expect(requirementFingerprint('L.1', 'The offeror shall submit.')).not.toBe(requirementFingerprint('L.2', 'The offeror shall submit.'))
  })

  it('emits no duplicate fingerprints within one parse', () => {
    const fingerprints = parseSolicitation(SOLICITATION).requirements.map((r) => r.fingerprint)
    expect(new Set(fingerprints).size).toBe(fingerprints.length)
  })
})

describe('parseClauses', () => {
  const clauses = parseClauses(annotateLines(SOLICITATION))

  it('extracts FAR and DFARS clauses by exact number', () => {
    const numbers = clauses.map((c) => c.clauseNumber)
    expect(numbers).toContain('52.204-7')
    expect(numbers).toContain('252.204-7012')
    expect(numbers).toContain('52.222-50')
  })

  it('classifies explicit flow-down language', () => {
    const clause = clauses.find((c) => c.clauseNumber === '52.204-7')!
    expect(clause.flowDownStatus).toBe('EXPLICIT_FLOWDOWN')
    expect(clause.clauseSet).toBe('FAR')
  })

  it('classifies conditional flow-down and captures the condition', () => {
    const clause = clauses.find((c) => c.clauseNumber === '252.204-7012')!
    expect(clause.flowDownStatus).toBe('CONDITIONAL_FLOWDOWN')
    expect(clause.flowDownCondition).toContain('exceed')
    expect(clause.clauseSet).toBe('DFARS')
  })

  it('does not invent flow-down where the text is silent', () => {
    const clause = clauses.find((c) => c.clauseNumber === '52.222-50')!
    expect(clause.flowDownStatus).toBe('NO_EXPLICIT_FLOWDOWN_FOUND')
    expect(clause.flowDownCondition).toBeNull()
  })

  it('preserves evidence text for every clause', () => {
    expect(clauses.every((c) => c.evidenceText.length > 0)).toBe(true)
  })
})

describe('extractDate / parseMilestones', () => {
  it('parses only unambiguous date formats', () => {
    expect(extractDate('due 03/15/2027')?.toISOString().slice(0, 10)).toBe('2027-03-15')
    expect(extractDate('on March 1, 2027')?.toISOString().slice(0, 10)).toBe('2027-03-01')
    expect(extractDate('on 2027-03-01')?.toISOString().slice(0, 10)).toBe('2027-03-01')
    // A bare "3/4" is not guessed at.
    expect(extractDate('some time around 3/4')).toBeNull()
  })

  it('extracts typed milestones with their dates', () => {
    const milestones = parseMilestones(annotateLines(SOLICITATION))
    const types = milestones.map((m) => m.milestoneType)
    expect(types).toContain('QUESTION_DEADLINE')
    expect(types).toContain('PROPOSAL_DEADLINE')
    expect(types).toContain('SITE_VISIT')
  })

  it('flags a milestone with no parseable date for review', () => {
    const milestones = parseMilestones(annotateLines('An industry day will be scheduled at a later date.'))
    expect(milestones[0].reviewRequired).toBe(true)
    expect(milestones[0].reviewReason).toMatch(/No unambiguous date/i)
  })
})

describe('parseSolicitation — standing document needs', () => {
  it('identifies documents the solicitation explicitly requires', () => {
    const needs = parseSolicitation(SOLICITATION).standingDocumentNeeds
    const types = needs.map((n) => n.documentType)
    expect(types).toContain('CAPABILITY_STATEMENT')
    expect(types).toContain('RESUME')
  })
})

describe('parseSolicitation — honest failure', () => {
  it('reports unreadable input rather than returning an empty success', () => {
    const result = parseSolicitation('')
    expect(result.requirements).toEqual([])
    expect(result.warnings[0]).toMatch(/no extractable text/i)
    expect(result.unresolved[0].reason).toBe('UNREADABLE')
  })

  it('warns when no section headings could be detected', () => {
    const result = parseSolicitation('The contractor shall deliver monthly status reports to the government.')
    expect(result.warnings.some((w) => /No section headings/i.test(w))).toBe(true)
  })

  it('records an unresolved item when nothing obligation-bearing is found', () => {
    const result = parseSolicitation('This document describes background information about the program office.')
    expect(result.requirements).toHaveLength(0)
    expect(result.unresolved.some((u) => u.reason === 'AMBIGUOUS')).toBe(true)
  })
})
