import { generateWithRouter } from './llm/llmRouter'
import { farGroundedComplete } from './far/farGroundedComplete'
import { logger } from '../utils/logger'

export interface ProposalAnswer {
  questionId: string
  category: string
  question: string
  answer: string      // user-provided text, or empty string meaning "AI_FILL"
  aiDecide: boolean   // true = let AI fill in
}

/**
 * The LLM's self-assessed grounding for a section (FIX-6 follow-up).
 * HIGH = grounded in the supplied solicitation requirements + offeror facts;
 * MEDIUM = sound professional inference beyond the supplied material;
 * LOW = thin inputs / generic content / placeholders — the human reviewer
 * should rework this section first. Absent on drafts generated before this
 * shipped (and on truncation-recovered sections) — treated as "unrated".
 * Deliberately NOT part of the attestation content hash (hashProposalDraft
 * hashes only title + content), so adding it never invalidates an existing
 * attestation.
 */
export type SectionConfidence = 'HIGH' | 'MEDIUM' | 'LOW'

export interface ProposalDraftSection {
  title: string
  content: string
  confidence?: SectionConfidence
}

export interface ProposalDraft {
  opportunityTitle: string
  agency: string
  preparedDate: string
  sections: ProposalDraftSection[]
  /**
   * True when the LLM output JSON was malformed and the truncation-recovery
   * path returned only the sections it could salvage. Callers must surface
   * this to the user — a partial draft is shippable but should not be sent
   * to a federal agency without manual review.
   */
  partial?: boolean
}

/**
 * The offeror a proposal is written on behalf of — the real, selected company
 * (a client company, or the consulting firm itself). Without this, the model was
 * told to "fill in realistic content" with no company supplied, so it invented
 * one (random name, fabricated past performance). Identity here is authoritative
 * and must never be fabricated or replaced.
 */
export interface OfferorProfile {
  legalName: string
  uei?: string | null
  cage?: string | null
  naicsCodes?: string[]
  pscCodes?: string[]
  setAsides?: string[]
  contractVehicles?: string[]
  location?: string | null
  website?: string | null
  source: 'CLIENT_COMPANY' | 'CONSULTING_FIRM'
}

const DRAFT_SYSTEM_PROMPT = `You are an expert federal proposal writer with 20+ years of experience winning government contracts. Write a complete, professional, submission-ready proposal response for the opportunity described.

You write STRICTLY on behalf of the offeror named in the "OFFEROR PROFILE" block of the user message. That profile is the single source of truth for the company's identity.

ABSOLUTE IDENTITY RULES (never violate):
- Use the offeror's exact legal name, UEI, CAGE, certifications, and NAICS verbatim. NEVER invent, change, abbreviate, or substitute the company name or any identity field, and never name a different company anywhere in the proposal.
- NEVER fabricate past-performance contracts, customers, contract numbers, dollar values, periods of performance, or named key personnel. Past Performance and named personnel may use ONLY facts supplied in the OFFEROR PAST PERFORMANCE block, the OFFEROR PROFILE, or the INTERVIEW ANSWERS.
- If a required identity, past-performance, or personnel fact is not supplied, write the literal marker [TO BE PROVIDED BY OFFEROR] for that specific item. Do NOT invent it. This marker is the ONLY placeholder permitted, and only for missing offeror facts.

AGENCY-FIRST STRUCTURE (the agency's needs are the focal point):
- Lead every section from the AGENCY's perspective: its mission, the stated objectives and outcomes of THIS requirement, and the evaluation criteria.
- Then demonstrate, point by point and traceable to specific solicitation requirements, how THIS offeror's real qualifications meet those needs. The throughline of every section is: "here is what the agency needs → here is how we specifically satisfy it."

WRITING RULES:
- Write ACTUAL proposal prose — not bullet points, not an outline.
- Formal government proposal style, first person plural ("Our team", "We propose").
- Each section comprehensive: 5–10 substantive paragraphs.
- The Technical Approach must describe a clear methodology, phases/tasks, tools/technologies, and deliverables, each tied to a solicitation requirement.
- The Management Approach must include organizational structure, key personnel roles (real or [TO BE PROVIDED BY OFFEROR]), communication plan, and risk mitigation.
- The Technical and Management narrative may be authored in full (that is your professional work product); only IDENTITY, PAST PERFORMANCE, and named PERSONNEL are restricted to supplied facts.

CONFIDENCE SELF-ASSESSMENT (required on every section):
- Every section object MUST include a "confidence" field with exactly one of: "HIGH", "MEDIUM", "LOW".
- "HIGH" = the section is directly grounded in the supplied solicitation requirements, interview answers, and offeror facts.
- "MEDIUM" = the section required substantial professional inference beyond the supplied material.
- "LOW" = the inputs were thin for this section, the content is more generic than specific, or [TO BE PROVIDED BY OFFEROR] placeholders were needed — the human reviewer should rework this section first.
- Be honest — a LOW flag helps the reviewer; an unearned HIGH does not.

Return ONLY valid JSON — no markdown, no preamble:
{
  "sections": [
    {
      "title": "Cover Letter",
      "content": "Full written cover letter...",
      "confidence": "HIGH"
    },
    {
      "title": "Executive Summary",
      "content": "Comprehensive executive summary — 2-3 pages worth of content covering understanding of requirements, proposed approach overview, key differentiators, and relevant experience..."
    },
    {
      "title": "Technical Approach",
      "content": "Detailed technical approach — 4-6 pages worth of content covering methodology, work breakdown, tools, technologies, deliverables, innovation, and compliance with SOW..."
    },
    {
      "title": "Management Approach",
      "content": "Detailed management approach — organizational chart description, key personnel, staffing plan, communication plan, risk management, quality assurance, transition plan..."
    },
    {
      "title": "Past Performance",
      "content": "3+ detailed past performance narratives with contract name, agency, period, value, scope, outcomes, and relevance to this opportunity..."
    },
    {
      "title": "Staffing Plan",
      "content": "Key personnel qualifications, organizational structure, labor categories, recruitment and retention approach..."
    },
    {
      "title": "Price/Cost Approach",
      "content": "Pricing methodology, cost reasonableness narrative, value proposition, cost control measures..."
    }
  ]
}`

function buildAnswersBlock(answers: ProposalAnswer[]): string {
  if (!answers.length) return ''
  const lines = answers.map(a => {
    const label = a.category.replace(/_/g, ' ')
    if (a.aiDecide || !a.answer.trim()) {
      return `[AI_FILL] ${label}: Use your best judgment based on the opportunity context`
    }
    return `${label}: ${a.answer.trim()}`
  })
  return `\n=== PROPOSAL INTERVIEW ANSWERS (incorporate directly into the proposal) ===\n${lines.join('\n')}\n===\n`
}

/**
 * A real, structured past-performance record supplied to the draft so the
 * Past Performance volume cites the offeror's actual prior contracts instead of
 * the [TO BE PROVIDED BY OFFEROR] placeholder. Sourced from PastPerformanceRecord.
 */
export interface ProposalPastPerformance {
  contractNumber: string
  customerName: string
  customerAgency?: string | null
  contractType?: string | null
  totalValue?: string | null
  periodOfPerformanceStart?: Date | string | null
  periodOfPerformanceEnd?: Date | string | null
  cparsRating?: string | null
  scopeSummary?: string
}

function fmtPpDate(d?: Date | string | null): string | null {
  if (!d) return null
  const dt = typeof d === 'string' ? new Date(d) : d
  if (Number.isNaN(dt.getTime())) return null
  return dt.toLocaleDateString('en-US', { year: 'numeric', month: 'short' })
}

export function buildPastPerformanceBlock(records: ProposalPastPerformance[]): string {
  if (!records.length) return ''
  const entries = records.map((r, i) => {
    const parts: string[] = [`Contract: ${r.contractNumber}`, `Customer: ${r.customerName}`]
    if (r.customerAgency) parts.push(`Agency: ${r.customerAgency}`)
    if (r.contractType) parts.push(`Type: ${r.contractType}`)
    if (r.totalValue) parts.push(`Value: $${Number(r.totalValue).toLocaleString()}`)
    const start = fmtPpDate(r.periodOfPerformanceStart)
    const end = fmtPpDate(r.periodOfPerformanceEnd)
    if (start || end) parts.push(`Period: ${start ?? '?'}–${end ?? 'present'}`)
    if (r.cparsRating) parts.push(`CPARS: ${r.cparsRating.replace(/_/g, ' ')}`)
    let entry = `${i + 1}. ${parts.join(' | ')}`
    if (r.scopeSummary && r.scopeSummary.trim()) {
      entry += `\n   Scope: ${r.scopeSummary.trim().slice(0, 600)}`
    }
    return entry
  })
  return `\n=== OFFEROR PAST PERFORMANCE (the offeror's REAL prior contracts, most relevant first — cite these by name in the Past Performance volume; do NOT invent any others) ===\n${entries.join('\n')}\n===\n`
}

function buildOfferorBlock(o: OfferorProfile): string {
  const lines: string[] = [`Legal name: ${o.legalName}`]
  if (o.uei) lines.push(`UEI: ${o.uei}`)
  if (o.cage) lines.push(`CAGE code: ${o.cage}`)
  if (o.setAsides?.length) lines.push(`Socio-economic / set-aside status: ${o.setAsides.join(', ')}`)
  if (o.naicsCodes?.length) lines.push(`NAICS codes: ${o.naicsCodes.join(', ')}`)
  if (o.pscCodes?.length) lines.push(`PSC codes: ${o.pscCodes.join(', ')}`)
  if (o.contractVehicles?.length) lines.push(`Contract vehicles held: ${o.contractVehicles.join(', ')}`)
  if (o.location) lines.push(`Location: ${o.location}`)
  if (o.website) lines.push(`Website: ${o.website}`)
  return lines.join('\n')
}

export async function generateProposalDraft(
  opportunityTitle: string,
  agency: string,
  requirements: Array<{ section: string; requirementText: string; isMandatory: boolean }>,
  enrichment: {
    naicsCode?: string
    setAsideType?: string | null
    estimatedValue?: number | null
    historicalWinner?: string | null
    description?: string | null
  },
  consultingFirmId: string,
  offeror: OfferorProfile,
  answers: ProposalAnswer[] = [],
  userGuidance?: string,
  bidFormContext?: string,
  opportunityId: string | null = null,
  // Optional Winners Intel context block injected into the system prompt
  // when the feature is enabled and the firm has opted in. Null/undefined
  // = no injection, default behavior.
  winnersIntelContext?: string | null,
  // Optional real past-performance records (structured PastPerformanceRecord
  // rows). When present, the Past Performance volume cites these actual
  // contracts; when empty the section falls back to [TO BE PROVIDED BY OFFEROR].
  pastPerformanceRecords: ProposalPastPerformance[] = [],
): Promise<ProposalDraft> {
  const mandatoryReqs = requirements
    .filter(r => r.isMandatory)
    .slice(0, 20)
    .map(r => `[${r.section}] ${r.requirementText.slice(0, 300)}`)
    .join('\n')

  const allReqs = requirements
    .slice(0, 30)
    .map(r => `[${r.section}] ${r.requirementText.slice(0, 200)}`)
    .join('\n')

  const answersBlock = buildAnswersBlock(answers)
  const offerorBlock = buildOfferorBlock(offeror)
  const pastPerformanceBlock = buildPastPerformanceBlock(pastPerformanceRecords)

  const userPrompt = `Write a complete, agency-focused proposal for this federal opportunity, ON BEHALF OF the offeror below. Write as ${offeror.legalName} — never name any other company.

=== OFFEROR PROFILE (the ONLY valid company identity for this proposal) ===
${offerorBlock}
===

=== AGENCY NEEDS (the focal point — lead every section from these) ===
Opportunity: ${opportunityTitle}
Agency: ${agency}
NAICS Code: ${enrichment.naicsCode ?? 'Not specified'}
Set-Aside: ${enrichment.setAsideType ?? 'Open competition'}
Estimated Contract Value: ${enrichment.estimatedValue ? '$' + Number(enrichment.estimatedValue).toLocaleString() : 'Not published'}
Incumbent/Historical Winner: ${enrichment.historicalWinner ?? 'Unknown'}
===
${answersBlock}${pastPerformanceBlock}${userGuidance ? `\n=== ADDITIONAL PROPOSAL MANAGER GUIDANCE ===\n${userGuidance}\n===\n` : ''}${bidFormContext ? `\n=== UPLOADED BID FORM DATA (incorporate fields/requirements into pricing and technical sections) ===\n${bidFormContext}\n===\n` : ''}
${enrichment.description ? `Opportunity Description:\n${enrichment.description.slice(0, 2000)}\n` : ''}

Mandatory Requirements to Address:
${mandatoryReqs || 'No requirements extracted — write based on the opportunity description.'}

All Requirements:
${allReqs || 'See mandatory requirements above.'}

Write a COMPLETE, COMPREHENSIVE, SUBMISSION-READY proposal draft. This must read like a real federal proposal that could win a contract.
- Executive Summary: 2-3 pages of content. Cover understanding of the agency mission, summary of approach, team qualifications, and why the offeror is uniquely qualified.
- Technical Approach: 4-6 pages. Detailed methodology, phased approach with tasks/milestones, specific tools and technologies, deliverables per phase, innovation, and direct traceability to SOW requirements.
- Management Approach: 2-3 pages. Org chart narrative, key personnel with roles, communication cadence, risk register and mitigation strategies, quality control plan, transition approach.
- Past Performance: 2-3 pages. Use ONLY the offeror's real contracts from the OFFEROR PAST PERFORMANCE block, the OFFEROR PROFILE, or INTERVIEW ANSWERS — contract name, agency, period, dollar value, scope, quantified outcomes, and relevance to this requirement. When the OFFEROR PAST PERFORMANCE block is present, write a narrative for each listed contract (most relevant first) and tie it to this requirement. Do NOT invent contracts. If none are supplied, write the section's framing and mark each specific as [TO BE PROVIDED BY OFFEROR].
- Staffing Plan: 1-2 pages. Labor categories, full-time equivalents, key personnel bios, recruitment strategy.
- Price/Cost Approach: 1-2 pages. Pricing philosophy, cost realism narrative, value proposition, cost control and monitoring.

Each section MUST be fully written prose, with no bullet-point outlines. Write as ${offeror.legalName} throughout. The only permitted placeholder is [TO BE PROVIDED BY OFFEROR], and only for a missing offeror identity, past-performance, or personnel fact — never invent a company, contract, or person.`

  // Compose system prompt: the static draft instructions plus the optional
  // Winners Intel context block. The block lands AFTER the writing
  // instructions so the LLM treats the patterns as reference material, not
  // formatting directives. Tested: prepending instead made the LLM open the
  // proposal with statistical commentary instead of the cover letter.
  const systemPrompt = winnersIntelContext
    ? `${DRAFT_SYSTEM_PROMPT}\n\n${winnersIntelContext}`
    : DRAFT_SYSTEM_PROMPT

  let response
  // Note: maxTokens 32000 + timeoutMs 600000 are the prod fixes from
  // 6e02f4e9 ("timeout was killing Claude mid-generation") — large
  // drafts take 3-5 minutes on Claude. Both the FAR-grounded and
  // direct-router paths inherit them.
  const llmReq = {
    systemPrompt,
    userPrompt,
    maxTokens: 32000,
    temperature: 0.3,
    timeoutMs: 600_000,
  }
  try {
    response = opportunityId
      ? await farGroundedComplete(llmReq, {
          scope: 'PROPOSAL_DRAFT',
          opportunityId,
          consultingFirmId,
          task: 'PROPOSAL_DRAFT',
          useCache: false,
        })
      : await generateWithRouter(llmReq, consultingFirmId, {
          task: 'PROPOSAL_DRAFT',
          useCache: false,
        })
  } catch (err) {
    const msg = (err as Error).message
    // Re-throw key/rate errors so the route can handle them with proper HTTP codes
    if (msg === 'NO_LLM_KEY' || msg === 'RATE_LIMITED') throw err
    // Timeout / abort / network — surface as EMPTY_LLM_OUTPUT so the route
    // returns 502 and refunds the token charge. Previously we returned a
    // 1-section "Notice" stub which silently produced a near-blank PDF.
    logger.error('Proposal draft generation failed', { error: msg })
    throw new Error('EMPTY_LLM_OUTPUT')
  }

  const parsed = parseDraftResponse(response.text)
  const hasUsableContent = parsed.sections.some(s => s.content && s.content.trim().length > 50)
  if (!hasUsableContent) {
    logger.error('Proposal draft LLM returned no usable content', {
      rawLength: response.text?.length ?? 0,
      sectionCount: parsed.sections.length,
    })
    throw new Error('EMPTY_LLM_OUTPUT')
  }

  return {
    opportunityTitle,
    agency,
    preparedDate: new Date().toLocaleDateString('en-US', { year: 'numeric', month: 'long', day: 'numeric' }),
    sections: parsed.sections,
    partial: parsed.truncated || undefined,
  }
}

interface ParsedDraft {
  sections: ProposalDraftSection[]
  /** True when truncation recovery was used (LLM hit max_tokens). */
  truncated: boolean
}

/** Accept only the exact enum values — anything else (or absent) is "unrated". */
function isSectionConfidence(v: unknown): v is SectionConfidence {
  return v === 'HIGH' || v === 'MEDIUM' || v === 'LOW'
}

function parseDraftResponse(raw: string): ParsedDraft {
  const cleaned = raw
    .replace(/```json\s*/gi, '')
    .replace(/```\s*/g, '')
    .trim()
  const start = cleaned.indexOf('{')
  if (start === -1) {
    logger.warn('Proposal draft response had no JSON object', { rawLength: raw.length })
    return { sections: [], truncated: false }
  }

  // Fast path: complete, valid JSON
  const end = cleaned.lastIndexOf('}')
  if (end !== -1) {
    try {
      const obj = JSON.parse(cleaned.slice(start, end + 1))
      if (Array.isArray(obj.sections)) {
        const sections = obj.sections
          .filter((s: any) => s.title && s.content)
          .map((s: any) => ({
            title: String(s.title),
            content: String(s.content),
            ...(isSectionConfidence(s.confidence) ? { confidence: s.confidence } : {}),
          }))
        if (sections.length) return { sections, truncated: false }
      }
    } catch {
      // Fall through to truncation recovery
    }
  }

  // Truncation recovery: scan for completed {"title": "...", "content": "..."} objects.
  // When Claude hits max_tokens mid-section, the trailing object is malformed but
  // earlier sections are intact. Returning those is far better than dumping raw
  // truncated JSON into a single PDF section.
  const recovered = recoverCompleteSections(cleaned.slice(start))
  if (recovered.length) {
    logger.warn('Proposal draft JSON was truncated; recovered complete sections', {
      recoveredCount: recovered.length,
      rawLength: raw.length,
    })
    return { sections: recovered, truncated: true }
  }

  logger.error('Proposal draft response could not be parsed or recovered', { rawLength: raw.length })
  return { sections: [], truncated: false }
}

function recoverCompleteSections(text: string): ProposalDraftSection[] {
  const sections: ProposalDraftSection[] = []
  let i = 0
  while (i < text.length) {
    const titleKey = text.indexOf('"title"', i)
    if (titleKey === -1) break
    const title = readJsonStringValue(text, titleKey + '"title"'.length)
    if (!title) { i = titleKey + 1; continue }
    const contentKey = text.indexOf('"content"', title.endIndex)
    if (contentKey === -1) break
    const content = readJsonStringValue(text, contentKey + '"content"'.length)
    if (!content) { i = title.endIndex; continue }
    if (title.value.trim() && content.value.trim().length > 50) {
      sections.push({ title: title.value, content: content.value })
    }
    i = content.endIndex
  }
  return sections
}

function readJsonStringValue(text: string, from: number): { value: string; endIndex: number } | null {
  let j = from
  while (j < text.length && text[j] !== '"') {
    if (text[j] !== ' ' && text[j] !== ':' && text[j] !== '\t' && text[j] !== '\n' && text[j] !== '\r') return null
    j++
  }
  if (j >= text.length) return null
  const startQuote = j
  j++
  let out = ''
  while (j < text.length) {
    const ch = text[j]
    if (ch === '\\') {
      const next = text[j + 1]
      if (next === undefined) return null
      if (next === 'n') out += '\n'
      else if (next === 't') out += '\t'
      else if (next === 'r') out += '\r'
      else if (next === '"') out += '"'
      else if (next === '\\') out += '\\'
      else if (next === '/') out += '/'
      else if (next === 'u' && j + 5 < text.length) {
        const hex = text.slice(j + 2, j + 6)
        const code = parseInt(hex, 16)
        if (!Number.isNaN(code)) out += String.fromCharCode(code)
        j += 4
      } else {
        out += next
      }
      j += 2
      continue
    }
    if (ch === '"') return { value: out, endIndex: j + 1 }
    out += ch
    j++
  }
  return null
}
