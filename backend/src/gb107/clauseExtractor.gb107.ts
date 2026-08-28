// =============================================================
// GB-107 clause & requirement extractor.
//
// Regex/keyword extraction over the enriched solicitation text.
// FAR part 52 clauses are 52.2xx-N; DFARS clauses are 252.2xx-7xxx.
// Mandatory-vs-informational follows the GB-107 heuristic: context
// containing shall/must/required is mandatory; may/if-applicable
// downgrades to informational. Clause titles are resolved from the
// existing FarClause/DfarsClause catalog by the matrix writer.
// =============================================================
import type { ExtractedRequirement, RequirementType } from './types.gb107'

const FAR_CLAUSE_RE = /\b(?:FAR\s+)?(52\.2\d{2}-\d{1,3})\b/gi
const DFARS_CLAUSE_RE = /\b(?:DFARS\s+)?(252\.2\d{2}-7\d{3})\b/gi

const CONTEXT_RADIUS = 250
const MAX_EXCERPT = 500
const MAX_REQUIREMENTS = 200

const EVAL_KEYWORDS = [
  'evaluation criteria',
  'evaluation factors',
  'basis for award',
  'best value',
  'lowest price technically acceptable',
  'lpta',
  'trade-off',
  'tradeoff',
]

const SUBMISSION_KEYWORDS = [
  'page limit',
  'page limitation',
  'shall not exceed',
  'submit by',
  'quote due',
  'quotes are due',
  'offers due',
  'due no later than',
  'response deadline',
  'email to',
  'submit to',
]

const DELIVERY_KEYWORDS = [
  'period of performance',
  'place of performance',
  'delivery schedule',
  'delivery date',
  'fob destination',
  'fob origin',
  'f.o.b.',
]

const MANDATORY_RE = /\b(shall|must|required|will comply|is required)\b/i
const INFORMATIONAL_RE = /\b(may\b|if applicable|as applicable|optional|encouraged)\b/i

function excerptAround(text: string, index: number, matchLength: number): string {
  const start = Math.max(0, index - CONTEXT_RADIUS)
  const end = Math.min(text.length, index + matchLength + CONTEXT_RADIUS)
  return text.slice(start, end).replace(/\s+/g, ' ').trim().slice(0, MAX_EXCERPT)
}

function classifyMandatory(context: string): boolean {
  if (MANDATORY_RE.test(context)) return true
  if (INFORMATIONAL_RE.test(context)) return false
  // Clauses cited without modal language default to mandatory (GB-107 spec).
  return true
}

function extractClauses(
  text: string,
  re: RegExp,
  requirementType: RequirementType,
  labelPrefix: string,
): ExtractedRequirement[] {
  const seen = new Set<string>()
  const results: ExtractedRequirement[] = []
  re.lastIndex = 0
  let match: RegExpExecArray | null
  while ((match = re.exec(text)) !== null) {
    const code = match[1]
    if (seen.has(code)) continue
    seen.add(code)
    const context = excerptAround(text, match.index, match[0].length)
    results.push({
      requirementType,
      reference: code,
      description: `${labelPrefix} ${code}`,
      isMandatory: classifyMandatory(context),
      extractedText: context,
    })
  }
  return results
}

function extractKeywordRequirements(
  text: string,
  keywords: string[],
  requirementType: RequirementType,
  labelPrefix: string,
): ExtractedRequirement[] {
  const lower = text.toLowerCase()
  const results: ExtractedRequirement[] = []
  for (const keyword of keywords) {
    const index = lower.indexOf(keyword)
    if (index === -1) continue
    const context = excerptAround(text, index, keyword.length)
    results.push({
      requirementType,
      reference: null,
      description: `${labelPrefix}: "${keyword}"`,
      // Submission mechanics are inherently mandatory; eval/delivery
      // items follow the modal-language heuristic.
      isMandatory: requirementType === 'SUBMISSION_REQ' ? true : classifyMandatory(context),
      extractedText: context,
    })
  }
  return results
}

export interface ExtractionSummary {
  far: string[]
  dfars: string[]
  evalFactors: number
  submissionReqs: number
  deliveryReqs: number
}

export function extractRequirements(text: string): {
  requirements: ExtractedRequirement[]
  summary: ExtractionSummary
} {
  const far = extractClauses(text, FAR_CLAUSE_RE, 'FAR_CLAUSE', 'FAR')
  const dfars = extractClauses(text, DFARS_CLAUSE_RE, 'DFARS_CLAUSE', 'DFARS')
  const evalFactors = extractKeywordRequirements(text, EVAL_KEYWORDS, 'EVAL_FACTOR', 'Evaluation approach')
  const submission = extractKeywordRequirements(text, SUBMISSION_KEYWORDS, 'SUBMISSION_REQ', 'Submission requirement')
  const delivery = extractKeywordRequirements(text, DELIVERY_KEYWORDS, 'DELIVERY_REQ', 'Delivery / performance')

  const requirements = [...far, ...dfars, ...evalFactors, ...submission, ...delivery].slice(
    0,
    MAX_REQUIREMENTS,
  )

  return {
    requirements,
    summary: {
      far: far.map((r) => r.reference as string),
      dfars: dfars.map((r) => r.reference as string),
      evalFactors: evalFactors.length,
      submissionReqs: submission.length,
      deliveryReqs: delivery.length,
    },
  }
}
