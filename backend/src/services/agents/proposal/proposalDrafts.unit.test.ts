// =============================================================
// §7.7 — the validators that stand between a language model and the database.
//
// No database and no provider. Every test hands the parsers hostile output and
// checks that the bad part is discarded rather than persisted: invented
// citation ids, a swapped section id, a changed contract number, an invented
// dollar figure, a finding about a requirement that was never supplied.
//
// The rule these tests encode: a model may draft, but it may never introduce a
// fact. When output cannot be trusted the deterministic fallback wins.
// =============================================================
import { describe, it, expect } from 'vitest'
import {
  buildDeterministicSkeleton,
  parseSectionDraft,
  detectFactDrift,
  parseAdaptation,
  parseCrossCheck,
  sectionUserPayload,
  adaptationUserPayload,
  crossCheckUserPayload,
  NO_PROVIDER_LIMITATION,
  type SectionDraftFacts,
  type SectionDraft,
  type PastPerformanceFacts,
  type AdaptationDraft,
  type CrossCheckFacts,
  type CrossCheckResult,
} from './proposalDrafts'
import { AI_DRAFT_LABEL } from './proposalPrompts'
import type { CapabilitySource } from './capabilityLibrary'

// -------------------------------------------------------------
// Fixtures
// -------------------------------------------------------------

const capabilitySource = (over: Partial<CapabilitySource> = {}): CapabilitySource => ({
  narrativeId: 'nar-1',
  versionId: 'ver-1',
  versionNumber: 1,
  title: 'Security operations',
  category: 'TECHNICAL_NARRATIVE',
  content: 'The contractor operates a 24x7 security operations centre.',
  contentHash: 'hash-1',
  sourceReferences: [],
  approvedAt: new Date('2026-01-01T00:00:00.000Z'),
  approvedByUserId: 'human-1',
  relevanceScore: 40,
  matchedOn: ['keyword:cyber'],
  ...over,
})

const sectionFacts = (over: Partial<SectionDraftFacts> = {}): SectionDraftFacts => ({
  sectionId: 'sec-1',
  sectionTitle: 'Technical Approach',
  sectionNumber: 'L.1',
  requirements: [{ id: 'req-1', section: 'L.1', text: 'Describe your incident response process.', isMandatory: true }],
  lmMappings: [{ id: 'map-1', instructionSection: 'L.1', evaluationSection: 'M.1' }],
  capabilitySources: [capabilitySource()],
  pastPerformance: [{ id: 'pp-1', title: 'DHS SOC support', summary: 'Ran a SOC for DHS.' }],
  keyPersonnel: [],
  lockedContent: null,
  existingDraft: null,
  ...over,
})

const sectionFallback = (facts: SectionDraftFacts): SectionDraft => buildDeterministicSkeleton(facts)

const ppFacts = (over: Partial<PastPerformanceFacts> = {}): PastPerformanceFacts => ({
  recordId: 'pp-1',
  contractNumber: 'W91QUZ-19-C-0042',
  customerName: 'Defense Logistics Agency',
  agency: 'Department of Defense',
  role: 'PRIME',
  contractValue: '4200000',
  periodStart: '2019-03-01',
  periodEnd: '2023-02-28',
  narrative: 'Delivered sustainment support to the Defense Logistics Agency, Department of Defense, as PRIME under contract W91QUZ-19-C-0042 valued at 4200000 across 4 years.',
  targetRequirements: [{ id: 'req-1', text: 'Describe relevant sustainment experience.' }],
  ...over,
})

const ppFallback: AdaptationDraft = {
  recordId: 'pp-1',
  adaptedText: '',
  changedFields: [],
  unsupportedClaims: [],
  source: 'DETERMINISTIC_SKELETON',
  promptVersion: null,
  warnings: [],
}

const crossCheckFacts = (): CrossCheckFacts => ({
  requirements: [
    { id: 'req-1', section: 'L.1', text: 'Describe incident response.', isMandatory: true, isManuallyVerified: false },
    { id: 'req-2', section: 'L.2', text: 'Describe staffing.', isMandatory: true, isManuallyVerified: true },
  ],
  sections: [{ id: 'sec-1', title: 'Technical Approach', content: 'Our incident response runs 24x7.', status: 'DRAFTING' }],
})

const crossCheckFallback: CrossCheckResult = {
  findings: [], uncovered: [], source: 'DETERMINISTIC_SKELETON', promptVersion: null, warnings: [],
}

// =============================================================
// The deterministic skeleton
// =============================================================

describe('buildDeterministicSkeleton', () => {
  it('never invents prose and marks itself as an outline', () => {
    const draft = buildDeterministicSkeleton(sectionFacts())
    expect(draft.source).toBe('DETERMINISTIC_SKELETON')
    expect(draft.content).toContain('[OUTLINE ONLY')
    expect(draft.insufficientSourceMaterial).toBe(true)
    expect(draft.promptVersion).toBeNull()
    expect(draft.citations).toHaveLength(0)
  })

  it('lists the requirements the section owns so nothing is silently dropped', () => {
    const draft = buildDeterministicSkeleton(sectionFacts())
    expect(draft.content).toContain('Describe your incident response process.')
  })

  it('is the honest answer when no provider is configured', () => {
    expect(NO_PROVIDER_LIMITATION).toBe('AI drafting unavailable — no provider configured')
  })
})

// =============================================================
// Prompt A — section draft
// =============================================================

describe('parseSectionDraft', () => {
  const facts = sectionFacts()
  const fallback = sectionFallback(facts)

  it('accepts a well-formed draft and labels it as AI output', () => {
    const raw = JSON.stringify({
      sectionId: 'sec-1',
      content: 'We operate a 24x7 security operations centre.',
      citations: [{ sourceType: 'CAPABILITY_NARRATIVE', sourceId: 'ver-1', sourceReference: null, supportedClaim: 'SOC is 24x7' }],
      insufficientSourceMaterial: false,
    })
    const { draft, warnings } = parseSectionDraft(raw, facts, fallback)
    expect(draft.source).toBe('LLM_ASSISTED')
    expect(draft.content.startsWith(AI_DRAFT_LABEL)).toBe(true)
    expect(draft.citations).toHaveLength(1)
    expect(draft.insufficientSourceMaterial).toBe(false)
    expect(warnings).toHaveLength(0)
  })

  it('falls back to the skeleton on non-JSON output', () => {
    const { draft, warnings } = parseSectionDraft('I cannot do that.', facts, fallback)
    expect(draft).toBe(fallback)
    expect(warnings[0]).toContain('not valid JSON')
  })

  it('falls back when the model answers about a different section', () => {
    const raw = JSON.stringify({ sectionId: 'sec-OTHER', content: 'text', citations: [] })
    const { draft, warnings } = parseSectionDraft(raw, facts, fallback)
    expect(draft).toBe(fallback)
    expect(warnings[0]).toContain('different section id')
  })

  it('discards a citation whose source id was never supplied', () => {
    const raw = JSON.stringify({
      sectionId: 'sec-1',
      content: 'We hold an ISO 27001 certification.',
      citations: [{ sourceType: 'CAPABILITY_NARRATIVE', sourceId: 'ver-INVENTED', supportedClaim: 'ISO 27001' }],
      insufficientSourceMaterial: false,
    })
    const { draft, warnings } = parseSectionDraft(raw, facts, fallback)
    expect(draft.citations).toHaveLength(0)
    expect(warnings.join(' ')).toContain('referenced a source that was not supplied')
    // A rejected citation overrides the model's own claim of sufficiency.
    expect(draft.insufficientSourceMaterial).toBe(true)
  })

  it('discards a citation with an unknown source type', () => {
    const raw = JSON.stringify({
      sectionId: 'sec-1', content: 'text',
      citations: [{ sourceType: 'WIKIPEDIA', sourceId: 'ver-1', supportedClaim: 'x' }],
      insufficientSourceMaterial: false,
    })
    const { draft } = parseSectionDraft(raw, facts, fallback)
    expect(draft.citations).toHaveLength(0)
    expect(draft.insufficientSourceMaterial).toBe(true)
  })

  it('accepts requirement, mapping and past-performance ids as citable sources', () => {
    const raw = JSON.stringify({
      sectionId: 'sec-1', content: 'text',
      citations: [
        { sourceType: 'SOLICITATION_REQUIREMENT', sourceId: 'req-1', supportedClaim: 'a' },
        { sourceType: 'SECTION_L', sourceId: 'map-1', supportedClaim: 'b' },
        { sourceType: 'PAST_PERFORMANCE', sourceId: 'pp-1', supportedClaim: 'c' },
      ],
      insufficientSourceMaterial: false,
    })
    const { draft } = parseSectionDraft(raw, facts, fallback)
    expect(draft.citations).toHaveLength(3)
  })

  it('treats a draft with no citations at all as insufficient', () => {
    const raw = JSON.stringify({ sectionId: 'sec-1', content: 'Confident prose.', citations: [], insufficientSourceMaterial: false })
    const { draft } = parseSectionDraft(raw, facts, fallback)
    expect(draft.insufficientSourceMaterial).toBe(true)
  })

  it('warns when locked human text was not preserved', () => {
    const locked = 'This paragraph was written and approved by a human reviewer.'
    const lockedFacts = sectionFacts({ lockedContent: locked })
    const raw = JSON.stringify({
      sectionId: 'sec-1', content: 'A completely different paragraph.',
      citations: [{ sourceType: 'CAPABILITY_NARRATIVE', sourceId: 'ver-1', supportedClaim: 'x' }],
      insufficientSourceMaterial: false,
    })
    const { warnings } = parseSectionDraft(raw, lockedFacts, sectionFallback(lockedFacts))
    expect(warnings.join(' ')).toContain('must not replace the approved wording')
  })
})

// =============================================================
// Prompt B — past-performance adaptation
// =============================================================

describe('detectFactDrift', () => {
  const facts = ppFacts()

  it('finds no drift when every supplied fact survives', () => {
    expect(detectFactDrift(facts, facts.narrative)).toHaveLength(0)
  })

  it('detects a changed contract number', () => {
    const drift = detectFactDrift(facts, facts.narrative.replace('W91QUZ-19-C-0042', 'W91QUZ-19-C-9999'))
    expect(drift.join(' ')).toContain('W91QUZ-19-C-0042')
  })

  it('detects a changed customer name', () => {
    const drift = detectFactDrift(facts, facts.narrative.replace('Defense Logistics Agency', 'Defense Health Agency'))
    expect(drift.join(' ')).toContain('customer')
  })

  it('detects an invented figure', () => {
    const drift = detectFactDrift(facts, `${facts.narrative} We also supported 98765 endpoints.`)
    expect(drift.join(' ')).toContain('introduces figure(s) not present in the source record')
  })

  it('ignores a small number that could be ordinary prose', () => {
    expect(detectFactDrift(facts, `${facts.narrative} Phase 2 began on schedule.`)).toHaveLength(0)
  })
})

describe('parseAdaptation', () => {
  const facts = ppFacts()

  it('accepts a faithful adaptation and labels it', () => {
    const raw = JSON.stringify({
      recordId: 'pp-1',
      adaptedText: facts.narrative,
      changedFields: [{ field: 'narrative', changeType: 'REPHRASED', reason: 'Emphasised sustainment.', sourceReference: null }],
      unsupportedClaims: [],
    })
    const { draft, warnings } = parseAdaptation(raw, facts, ppFallback)
    expect(draft.source).toBe('LLM_ASSISTED')
    expect(draft.adaptedText.startsWith(AI_DRAFT_LABEL)).toBe(true)
    expect(draft.changedFields).toHaveLength(1)
    expect(warnings).toHaveLength(0)
  })

  it('rejects the whole adaptation when a fact drifted', () => {
    const raw = JSON.stringify({
      recordId: 'pp-1',
      adaptedText: facts.narrative.replace('4200000', '9900000'),
      changedFields: [], unsupportedClaims: [],
    })
    const { draft, warnings } = parseAdaptation(raw, facts, ppFallback)
    expect(draft).toBe(ppFallback)
    expect(warnings[0]).toContain('altered the supplied facts')
  })

  it('discards a change entry with an unknown change type', () => {
    const raw = JSON.stringify({
      recordId: 'pp-1', adaptedText: facts.narrative,
      changedFields: [{ field: 'narrative', changeType: 'FABRICATED', reason: 'because' }],
      unsupportedClaims: [],
    })
    const { draft } = parseAdaptation(raw, facts, ppFallback)
    expect(draft.changedFields).toHaveLength(0)
  })

  it('surfaces unsupported claims as a blocker on the adaptation', () => {
    const raw = JSON.stringify({
      recordId: 'pp-1', adaptedText: facts.narrative, changedFields: [],
      unsupportedClaims: [{ claim: 'CMMI Level 5', reason: 'Not in the source record.', sourceNeeded: 'Appraisal certificate' }],
    })
    const { draft, warnings } = parseAdaptation(raw, facts, ppFallback)
    expect(draft.unsupportedClaims).toHaveLength(1)
    expect(warnings.join(' ')).toContain('not ready for review until a person resolves them')
  })

  it('produces nothing when the model returns empty text', () => {
    const { draft, warnings } = parseAdaptation(JSON.stringify({ recordId: 'pp-1', adaptedText: '   ' }), facts, ppFallback)
    expect(draft).toBe(ppFallback)
    expect(warnings[0]).toContain('no adapted text')
  })
})

// =============================================================
// Prompt C — compliance cross-check
// =============================================================

describe('parseCrossCheck', () => {
  const facts = crossCheckFacts()

  it('accepts findings that reference supplied ids', () => {
    const raw = JSON.stringify({
      findings: [{
        requirementId: 'req-1', sectionId: 'sec-1', verdict: 'COVERED',
        evidence: [{ sourceType: 'PROPOSAL_SECTION', sourceId: 'sec-1', sourceReference: null, explanation: 'States 24x7 response.' }],
      }],
      uncovered: [],
    })
    const { result, warnings } = parseCrossCheck(raw, facts, crossCheckFallback)
    expect(result.findings).toHaveLength(1)
    expect(result.findings[0].evidence).toHaveLength(1)
    expect(warnings).toHaveLength(0)
  })

  it('discards a finding about a requirement that was never supplied', () => {
    const raw = JSON.stringify({ findings: [{ requirementId: 'req-INVENTED', sectionId: null, verdict: 'COVERED', evidence: [] }], uncovered: [] })
    const { result, warnings } = parseCrossCheck(raw, facts, crossCheckFallback)
    expect(result.findings).toHaveLength(0)
    expect(warnings.join(' ')).toContain('unknown requirement or section')
  })

  it('discards a finding pointing at a section that was never supplied', () => {
    const raw = JSON.stringify({ findings: [{ requirementId: 'req-1', sectionId: 'sec-INVENTED', verdict: 'COVERED', evidence: [] }], uncovered: [] })
    const { result } = parseCrossCheck(raw, facts, crossCheckFallback)
    expect(result.findings).toHaveLength(0)
  })

  it('discards a finding with a verdict outside the fixed vocabulary', () => {
    const raw = JSON.stringify({ findings: [{ requirementId: 'req-1', sectionId: null, verdict: 'DEFINITELY_FINE', evidence: [] }], uncovered: [] })
    const { result } = parseCrossCheck(raw, facts, crossCheckFallback)
    expect(result.findings).toHaveLength(0)
  })

  it('keeps the finding but drops evidence pointing at an unsupplied id', () => {
    const raw = JSON.stringify({
      findings: [{
        requirementId: 'req-1', sectionId: 'sec-1', verdict: 'PARTIALLY_COVERED',
        evidence: [
          { sourceType: 'PROPOSAL_SECTION', sourceId: 'sec-GHOST', explanation: 'invented' },
          { sourceType: 'REQUIREMENT', sourceId: 'req-2', explanation: 'real' },
        ],
      }],
      uncovered: [],
    })
    const { result } = parseCrossCheck(raw, facts, crossCheckFallback)
    expect(result.findings).toHaveLength(1)
    expect(result.findings[0].evidence.map((e) => e.sourceId)).toEqual(['req-2'])
  })

  it('falls back when the payload has no findings array', () => {
    const { result, warnings } = parseCrossCheck(JSON.stringify({ verdicts: [] }), facts, crossCheckFallback)
    expect(result).toBe(crossCheckFallback)
    expect(warnings[0]).toContain('malformed result')
  })

  it('filters uncovered entries down to supplied requirement ids', () => {
    const raw = JSON.stringify({
      findings: [],
      uncovered: [
        { requirementId: 'req-2', reason: 'No section addresses staffing.', missingElements: ['key personnel'] },
        { requirementId: 'req-GHOST', reason: 'invented', missingElements: [] },
      ],
    })
    const { result } = parseCrossCheck(raw, facts, crossCheckFallback)
    expect(result.uncovered.map((u) => u.requirementId)).toEqual(['req-2'])
  })
})

// =============================================================
// Payload minimisation — what actually leaves the tenant
// =============================================================

describe('payload minimisation', () => {
  it('sends only the section’s own requirements and approved sources', () => {
    const payload = JSON.stringify(sectionUserPayload(sectionFacts()))
    expect(payload).toContain('req-1')
    expect(payload).toContain('ver-1')
    expect(payload).not.toContain('contentHash')
    expect(payload).not.toContain('relevanceScore')
  })

  it('sends no tenant identifier with a past-performance adaptation', () => {
    const payload = JSON.stringify(adaptationUserPayload(ppFacts()))
    expect(payload).not.toContain('consultingFirmId')
    expect(payload).toContain('W91QUZ-19-C-0042')
  })

  it('sends only the requirements and sections under cross-check', () => {
    const payload = JSON.stringify(crossCheckUserPayload(crossCheckFacts()))
    expect(payload).not.toContain('consultingFirmId')
    expect(payload).toContain('req-1')
    expect(payload).toContain('sec-1')
  })
})
