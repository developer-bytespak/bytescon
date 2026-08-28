// =============================================================
// §6.3A — Deterministic solicitation parsing.
//
// This runs FIRST and always. AI is only ever used afterwards, for
// classification, structured extraction, L/M mapping and ambiguity resolution
// where it genuinely adds value — never as the primary parser.
//
// Everything here is pure and side-effect free: same text in, same
// requirements out. That is what makes reprocessing an amendment safe and
// duplicate-free.
// =============================================================
import { createHash } from 'crypto'

export const EXTRACTOR_VERSION = 'deterministic-v1'

export type RequirementType =
  | 'INSTRUCTION' | 'EVALUATION' | 'FORMAT' | 'SUBMISSION' | 'DOCUMENT'
  | 'CERTIFICATION' | 'DEADLINE' | 'DELIVERABLE' | 'CONTRACT_REQUIREMENT' | 'OTHER'

export type LmRole = 'INSTRUCTION' | 'EVALUATION' | null

export interface ParsedRequirement {
  requirementText: string
  evidenceText: string
  requirementType: RequirementType
  lmRole: LmRole
  sourceSection: string | null
  sourcePageNumber: number | null
  isMandatory: boolean
  /** Stable across reprocessing — the duplicate-prevention key. */
  fingerprint: string
  reviewRequired: boolean
  reviewReason: string | null
}

export interface ParsedClause {
  clauseNumber: string
  clauseTitle: string | null
  clauseSet: 'FAR' | 'DFARS' | 'AGENCY' | 'OTHER'
  evidenceText: string
  sourceSection: string | null
  sourcePageNumber: number | null
  /** Deterministic flow-down signal; always REVIEW_REQUIRED-safe. */
  flowDownStatus: 'EXPLICIT_FLOWDOWN' | 'CONDITIONAL_FLOWDOWN' | 'NO_EXPLICIT_FLOWDOWN_FOUND' | 'REVIEW_REQUIRED'
  flowDownCondition: string | null
}

export interface ParsedMilestone {
  milestoneType: string
  title: string
  dateTime: Date | null
  evidenceText: string
  sourceSection: string | null
  sourcePageNumber: number | null
  reviewRequired: boolean
  reviewReason: string | null
}

export interface ParsedStandingDocNeed {
  documentType: string
  documentName: string
  evidenceText: string
  sourceSection: string | null
  sourcePageNumber: number | null
}

export interface ParseResult {
  sourceHash: string
  extractorVersion: string
  requirements: ParsedRequirement[]
  clauses: ParsedClause[]
  milestones: ParsedMilestone[]
  standingDocumentNeeds: ParsedStandingDocNeed[]
  warnings: string[]
  /** Text the parser could not interpret; surfaced honestly, never dropped. */
  unresolved: Array<{ description: string; reason: string }>
}

export function hashContent(text: string): string {
  return createHash('sha256').update(text.replace(/\s+/g, ' ').trim()).digest('hex')
}

/** Fingerprint used to dedupe requirements across reprocessing. */
export function requirementFingerprint(section: string | null, text: string): string {
  const normalized = text.toLowerCase().replace(/[^a-z0-9 ]/g, '').replace(/\s+/g, ' ').trim()
  return createHash('sha256').update(`${(section ?? '').toLowerCase()}|${normalized}`).digest('hex').slice(0, 40)
}

const MANDATORY_PATTERNS = /\b(shall|must|is required to|are required to|will be required|mandatory|no later than)\b/i
const CONDITIONAL_PATTERNS = /\b(should|may|is encouraged|are encouraged|if applicable|as appropriate)\b/i

/** Section headings such as "L.3.2", "SECTION M", "M.2 Technical Approach". */
const SECTION_HEADING = /^\s*(?:SECTION\s+)?([A-M])(?:[.\s-]?(\d+(?:\.\d+)*))?\b[.:\s-]*(.{0,120})$/i
const PAGE_MARKER = /^\s*(?:page\s+)?(\d{1,4})\s*(?:of\s+\d{1,4})?\s*$/i

interface Line {
  text: string
  section: string | null
  page: number | null
}

/**
 * Split into lines carrying their nearest preceding section heading and page
 * marker, so every extracted item keeps a real source reference.
 */
export function annotateLines(text: string): Line[] {
  const out: Line[] = []
  let section: string | null = null
  let page: number | null = null

  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim()
    if (!line) continue

    const pageMatch = PAGE_MARKER.exec(line)
    if (pageMatch) { page = Number(pageMatch[1]); continue }

    const headingMatch = SECTION_HEADING.exec(line)
    if (headingMatch && line.length < 140) {
      const letter = headingMatch[1].toUpperCase()
      const number = headingMatch[2]
      section = number ? `${letter}.${number}` : `Section ${letter}`
      // A heading with trailing prose is both a heading and content.
      const rest = (headingMatch[3] ?? '').trim()
      if (rest.length > 25) out.push({ text: rest, section, page })
      continue
    }
    out.push({ text: line, section, page })
  }
  return out
}

/**
 * Classify a sentence. Section letter is the strongest signal (L = instructions
 * to offerors, M = evaluation factors) and wins over wording.
 */
export function classifyRequirement(sentence: string, section: string | null): { type: RequirementType; lmRole: LmRole } {
  const s = sentence.toLowerCase()
  const letter = section ? section.replace(/^section\s+/i, '').charAt(0).toUpperCase() : null

  if (letter === 'M' || /\b(evaluation factor|will be evaluated|evaluation criteri|adjectival rating|relative importance|technically acceptable)\b/.test(s)) {
    return { type: 'EVALUATION', lmRole: 'EVALUATION' }
  }
  const lmRole: LmRole = letter === 'L' ? 'INSTRUCTION' : null

  if (/\b(page limit|font|times new roman|arial|margin|single-spaced|double-spaced|point type|file format|\.pdf|file name)\b/.test(s)) return { type: 'FORMAT', lmRole }
  if (/\b(submit|submission|deliver to|upload|email to|transmitted|due date|proposals? (?:are|shall|must) be received)\b/.test(s)) return { type: 'SUBMISSION', lmRole }
  if (/\b(certificat|represent|sf-?\d+|form \d|signed|signature|notariz)\b/.test(s)) return { type: 'CERTIFICATION', lmRole }
  if (/\b(no later than|not later than|due by|deadline|close of business|\bcob\b)\b/.test(s)) return { type: 'DEADLINE', lmRole }
  if (/\b(deliverable|cdrl|monthly report|status report|deliver the)\b/.test(s)) return { type: 'DELIVERABLE', lmRole }
  if (/\b(volume|attachment|appendix|exhibit|resume|past performance questionnaire|capability statement)\b/.test(s)) return { type: 'DOCUMENT', lmRole }
  if (letter === 'L') return { type: 'INSTRUCTION', lmRole }
  if (letter === 'C' || /\b(the contractor shall|contractor will provide|period of performance)\b/.test(s)) return { type: 'CONTRACT_REQUIREMENT', lmRole }
  return { type: 'OTHER', lmRole }
}

/** Sentence splitter that keeps common abbreviations intact. */
export function splitSentences(text: string): string[] {
  return text
    .replace(/\b(No|no|Sec|Fig|Approx|e\.g|i\.e|etc|U\.S|Inc|Corp|Ltd|Mr|Ms|Dr)\.\s/g, '$1<DOT> ')
    .split(/(?<=[.!?;])\s+(?=[A-Z(])/)
    .map((s) => s.replace(/<DOT>/g, '.').trim())
    .filter((s) => s.length > 0)
}

const FAR_CLAUSE = /\b(?:FAR\s+)?(52\.\d{3}-\d{1,3}(?:\s+Alt\s+[IVX]+)?)\b/gi
const DFARS_CLAUSE = /\b(?:DFARS\s+)?(252\.\d{3}-\d{4}(?:\s+Alt\s+[IVX]+)?)\b/gi

const FLOWDOWN_EXPLICIT = /\b(shall (?:be )?(?:include|insert|flow ?down)|include(?:d)? in all subcontracts|insert (?:the substance of )?this clause in all subcontracts|flow(?:ed)? down to (?:all )?subcontract)/i
const FLOWDOWN_CONDITIONAL = /\b(subcontracts? (?:that )?exceed|if the subcontract|subcontracts? (?:at|over|above) \$|when the subcontract|other than commercial)/i

export function parseClauses(lines: Line[]): ParsedClause[] {
  const found = new Map<string, ParsedClause>()

  for (const line of lines) {
    const matchers: Array<[RegExp, 'FAR' | 'DFARS']> = [[FAR_CLAUSE, 'FAR'], [DFARS_CLAUSE, 'DFARS']]
    for (const [re, set] of matchers) {
      re.lastIndex = 0
      let m: RegExpExecArray | null
      while ((m = re.exec(line.text)) !== null) {
        const number = m[1].replace(/\s+/g, ' ').trim()
        if (found.has(number)) continue

        // Title: the text that follows the clause number, up to a sentence end.
        const after = line.text.slice(m.index + m[0].length).replace(/^[\s,.:;-]+/, '')
        const title = after.length > 3 ? after.split(/[.;]|\s{2,}/)[0].slice(0, 200).trim() || null : null

        let flowDownStatus: ParsedClause['flowDownStatus'] = 'NO_EXPLICIT_FLOWDOWN_FOUND'
        let flowDownCondition: string | null = null
        if (FLOWDOWN_EXPLICIT.test(line.text)) {
          flowDownStatus = 'EXPLICIT_FLOWDOWN'
        } else if (FLOWDOWN_CONDITIONAL.test(line.text)) {
          flowDownStatus = 'CONDITIONAL_FLOWDOWN'
          flowDownCondition = line.text.slice(0, 500)
        }

        found.set(number, {
          clauseNumber: number,
          clauseTitle: title,
          clauseSet: set,
          evidenceText: line.text.slice(0, 1000),
          sourceSection: line.section,
          sourcePageNumber: line.page,
          flowDownStatus,
          flowDownCondition,
        })
      }
    }
  }
  return [...found.values()]
}

const MILESTONE_PATTERNS: Array<[RegExp, string]> = [
  [/\b(questions?|inquir\w+)\b[^.]{0,80}\b(due|deadline|submitted|received)\b/i, 'QUESTION_DEADLINE'],
  [/\bsite visit\b/i, 'SITE_VISIT'],
  [/\bindustry day\b/i, 'INDUSTRY_DAY'],
  [/\bpre-?proposal conference\b/i, 'PRE_PROPOSAL_CONFERENCE'],
  [/\b(proposals?|offers?|quotes?)\b[^.]{0,80}\b(due|received|submitted)\b/i, 'PROPOSAL_DEADLINE'],
  [/\boral presentation\b/i, 'ORAL_PRESENTATION'],
  [/\b(anticipated|estimated|expected)\s+award\b/i, 'ANTICIPATED_AWARD'],
  [/\bamendment\b[^.]{0,60}\b(issued|released)\b/i, 'AMENDMENT_RELEASE'],
]

// Explicit, unambiguous date forms only. A bare "3/4" is never guessed at.
const DATE_PATTERNS = [
  /\b(\d{1,2})[/-](\d{1,2})[/-](\d{4})\b/,
  /\b(January|February|March|April|May|June|July|August|September|October|November|December)\s+(\d{1,2}),?\s+(\d{4})\b/i,
  /\b(\d{4})-(\d{2})-(\d{2})\b/,
]

const MONTHS = ['january', 'february', 'march', 'april', 'may', 'june', 'july', 'august', 'september', 'october', 'november', 'december']

export function extractDate(text: string): Date | null {
  for (const re of DATE_PATTERNS) {
    const m = re.exec(text)
    if (!m) continue
    if (re === DATE_PATTERNS[0]) {
      const [, mm, dd, yyyy] = m
      const d = new Date(Date.UTC(Number(yyyy), Number(mm) - 1, Number(dd)))
      return Number.isNaN(d.getTime()) ? null : d
    }
    if (re === DATE_PATTERNS[1]) {
      const monthIndex = MONTHS.indexOf(m[1].toLowerCase())
      if (monthIndex === -1) continue
      const d = new Date(Date.UTC(Number(m[3]), monthIndex, Number(m[2])))
      return Number.isNaN(d.getTime()) ? null : d
    }
    const d = new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3])))
    return Number.isNaN(d.getTime()) ? null : d
  }
  return null
}

export function parseMilestones(lines: Line[]): ParsedMilestone[] {
  const out: ParsedMilestone[] = []
  const seen = new Set<string>()

  for (const line of lines) {
    for (const [re, type] of MILESTONE_PATTERNS) {
      if (!re.test(line.text)) continue
      const date = extractDate(line.text)
      const key = `${type}:${date ? date.toISOString().slice(0, 10) : line.text.slice(0, 40)}`
      if (seen.has(key)) continue
      seen.add(key)
      out.push({
        milestoneType: type,
        title: line.text.slice(0, 160),
        dateTime: date,
        evidenceText: line.text.slice(0, 1000),
        sourceSection: line.section,
        sourcePageNumber: line.page,
        // A milestone with no parseable date needs a human before it can drive
        // a schedule — that is stated, not silently defaulted.
        reviewRequired: date === null,
        reviewReason: date === null ? 'No unambiguous date was found in the source text for this milestone.' : null,
      })
      break
    }
  }
  return out
}

const STANDING_DOC_PATTERNS: Array<[RegExp, string, string]> = [
  [/\bcapability statement\b/i, 'CAPABILITY_STATEMENT', 'Capability statement'],
  [/\b(sam\.gov registration|system for award management|active registration in sam)\b/i, 'REGISTRATION', 'SAM.gov registration evidence'],
  [/\b(certificate of insurance|proof of insurance|liability insurance)\b/i, 'INSURANCE', 'Certificate of insurance'],
  [/\b(bid bond|performance bond|payment bond)\b/i, 'BOND', 'Bond'],
  [/\b(financial statement|audited financials|balance sheet)\b/i, 'FINANCIAL', 'Financial statements'],
  [/\bresum[eé]s?\b/i, 'RESUME', 'Key personnel resumes'],
  [/\b(past performance (?:questionnaire|reference|information)|cpars)\b/i, 'PAST_PERFORMANCE', 'Past performance record'],
  [/\b(representations? and certifications?|reps and certs)\b/i, 'REPRESENTATION', 'Representations and certifications'],
  [/\b(sf-?\d{2,4}|standard form \d+)\b/i, 'FORM', 'Standard form'],
  [/\b(small business subcontracting plan)\b/i, 'FORM', 'Small business subcontracting plan'],
]

export function parseStandingDocNeeds(lines: Line[]): ParsedStandingDocNeed[] {
  const out: ParsedStandingDocNeed[] = []
  const seen = new Set<string>()
  for (const line of lines) {
    for (const [re, type, name] of STANDING_DOC_PATTERNS) {
      const m = re.exec(line.text)
      if (!m) continue
      const label = type === 'FORM' ? m[0].toUpperCase() : name
      if (seen.has(label)) continue
      seen.add(label)
      out.push({
        documentType: type,
        documentName: label,
        evidenceText: line.text.slice(0, 1000),
        sourceSection: line.section,
        sourcePageNumber: line.page,
      })
    }
  }
  return out
}

/** Minimum sentence length to be considered a requirement, not a fragment. */
export const MIN_REQUIREMENT_LENGTH = 30

/**
 * Full deterministic parse. Requirements are extracted per sentence so
 * separate obligations in one paragraph stay separate — a §6.3A rule.
 */
export function parseSolicitation(text: string, options: { documentName?: string } = {}): ParseResult {
  const warnings: string[] = []
  const unresolved: Array<{ description: string; reason: string }> = []

  if (!text || text.trim().length === 0) {
    return {
      sourceHash: hashContent(''), extractorVersion: EXTRACTOR_VERSION,
      requirements: [], clauses: [], milestones: [], standingDocumentNeeds: [],
      warnings: ['The document produced no extractable text.'],
      unresolved: [{ description: options.documentName ?? 'document', reason: 'UNREADABLE' }],
    }
  }

  const lines = annotateLines(text)
  if (lines.every((l) => l.section === null)) {
    warnings.push('No section headings (L, M, C …) were detected, so requirements carry no section reference and Section L/M mapping cannot be derived deterministically.')
  }

  const requirements: ParsedRequirement[] = []
  const seen = new Set<string>()

  for (const line of lines) {
    for (const sentence of splitSentences(line.text)) {
      if (sentence.length < MIN_REQUIREMENT_LENGTH) continue
      const isMandatory = MANDATORY_PATTERNS.test(sentence)
      const isConditional = CONDITIONAL_PATTERNS.test(sentence)
      // Only obligation-bearing sentences become requirements; narrative prose
      // is left alone rather than inflated into obligations.
      if (!isMandatory && !isConditional) continue

      const { type, lmRole } = classifyRequirement(sentence, line.section)
      const fingerprint = requirementFingerprint(line.section, sentence)
      if (seen.has(fingerprint)) continue
      seen.add(fingerprint)

      requirements.push({
        requirementText: sentence.slice(0, 4000),
        evidenceText: line.text.slice(0, 1000),
        requirementType: type,
        lmRole,
        sourceSection: line.section,
        sourcePageNumber: line.page,
        // Mandatory only when the source uses mandatory language.
        isMandatory,
        fingerprint,
        reviewRequired: type === 'OTHER' || line.section === null,
        reviewReason: type === 'OTHER'
          ? 'The requirement type could not be determined from the source wording.'
          : line.section === null ? 'No section reference was available for this requirement.' : null,
      })
    }
  }

  if (requirements.length === 0) {
    unresolved.push({ description: 'No obligation-bearing sentences were found in the supplied text.', reason: 'AMBIGUOUS' })
  }

  return {
    sourceHash: hashContent(text),
    extractorVersion: EXTRACTOR_VERSION,
    requirements,
    clauses: parseClauses(lines),
    milestones: parseMilestones(lines),
    standingDocumentNeeds: parseStandingDocNeeds(lines),
    warnings,
    unresolved,
  }
}
