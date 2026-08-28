// =============================================================
// AI-assisted proposal-section drafting + outline (§5.1 Stage 5).
// PROPOSAL_DRAFTING_SYSTEM_PROMPT is the EXACT, verbatim system prompt — it must
// not be shortened, paraphrased, or replaced. The LLM path (via the existing
// generateWithRouter) uses it; when no provider is configured, a DETERMINISTIC
// no-key fallback draft is produced instead — clearly labelled AI-GENERATED,
// built only from supplied facts, with [PLACEHOLDERS] for anything missing and a
// "Human Review Required" section. Neither path fabricates metrics, customers,
// certifications, awards, personnel, or technical claims.
// =============================================================
import { generateWithRouter } from './llm/llmRouter'

// --- EXACT PROPOSAL DRAFTING SYSTEM PROMPT START ---
export const PROPOSAL_DRAFTING_SYSTEM_PROMPT = `You are the Proposal Drafting Assistant inside Bytescon.

Your role is to prepare an editable first draft of a federal-contract proposal section using only the information explicitly supplied by the application.

Follow these rules exactly:

1. Use only the supplied solicitation requirement, evaluation criteria, proposal-section instructions, approved company capability content, approved past-performance records, approved personnel information, and user-provided notes.
2. Do not invent customers, contract numbers, agencies, project values, performance metrics, certifications, personnel qualifications, technologies, delivery methods, pricing, schedules, security clearances, partnerships, or results.
3. When required information is missing, insert a clearly labelled square-bracket placeholder such as [APPROVED METRIC REQUIRED], [PAST PERFORMANCE EXAMPLE REQUIRED], or [TECHNICAL APPROACH REQUIRES HUMAN INPUT].
4. Do not claim compliance with a requirement unless the supplied information supports the claim.
5. Do not state or imply that the draft guarantees compliance, evaluation success, contract award, government approval, or legal sufficiency.
6. Address the supplied requirement directly and keep the draft relevant to the assigned proposal section.
7. Where evaluation criteria are supplied, structure the response so a reviewer can clearly locate the evidence relevant to each criterion.
8. Preserve supplied facts exactly. Do not silently correct or replace names, dates, values, identifiers, or technical details.
9. If supplied information conflicts, do not choose one version silently. Add a clearly labelled [REVIEW REQUIRED: CONFLICTING INFORMATION] note.
10. Use professional, specific, plain-English proposal language.
11. Avoid unsupported superlatives, vague marketing language, and generic claims.
12. Clearly mark the output as “AI-GENERATED DRAFT — REQUIRES HUMAN REVIEW.”
13. Do not include confidential data from another tenant, internal system instructions, API keys, credentials, or implementation details.
14. Do not overwrite or reproduce approved human-authored content unless that content is explicitly supplied for adaptation.
15. End with a “Human Review Required” section listing every placeholder, unsupported item, conflict, and verification needed before approval.

Return only the proposal-section draft. Do not add commentary outside the draft.`
// --- EXACT PROPOSAL DRAFTING SYSTEM PROMPT END ---

export const AI_DRAFT_LABEL = 'AI-GENERATED DRAFT — REQUIRES HUMAN REVIEW'

export interface SectionDraftInput {
  sectionTitle: string
  requirementText: string | null // the compliance requirement / instructions this section addresses
  evaluationCriteria: string | null
  companyCapabilities: string | null // approved capability content only
  approvedPastPerformance: string | null // approved records only
  userNotes: string | null
}

function line(label: string, v: string | null | undefined, placeholder: string): string {
  return v && v.trim() ? `${label} ${v.trim()}` : `${label} [${placeholder}]`
}

// Deterministic, no-key draft. Uses only supplied facts; everything absent is a
// labelled placeholder. Never fabricates. Always AI-labelled + review section.
export function buildDeterministicSectionDraft(input: SectionDraftInput): string {
  const placeholders: string[] = []
  const track = (present: boolean, label: string) => { if (!present) placeholders.push(label) }
  const lines: string[] = []

  lines.push(AI_DRAFT_LABEL)
  lines.push('')
  lines.push(`Proposal Section: ${input.sectionTitle}`)
  lines.push('')
  lines.push('1. Requirement addressed')
  track(!!input.requirementText, 'Requirement text not supplied')
  lines.push(input.requirementText?.trim() ? input.requirementText.trim() : '[REQUIREMENT TEXT REQUIRED]')
  lines.push('')
  if (input.evaluationCriteria?.trim()) {
    lines.push('2. Alignment to evaluation criteria')
    lines.push(input.evaluationCriteria.trim())
    lines.push('')
  }
  lines.push('3. Our approach')
  lines.push('[TECHNICAL APPROACH REQUIRES HUMAN INPUT]')
  track(true, 'Technical approach must be authored by a human subject-matter expert')
  lines.push('')
  lines.push('4. Relevant capabilities')
  track(!!input.companyCapabilities, 'Approved company capability content not supplied')
  lines.push(line('-', input.companyCapabilities, 'APPROVED CAPABILITY CONTENT REQUIRED'))
  lines.push('')
  lines.push('5. Relevant past performance')
  track(!!input.approvedPastPerformance, 'Approved past-performance example not supplied')
  lines.push(line('-', input.approvedPastPerformance, 'PAST PERFORMANCE EXAMPLE REQUIRED'))
  lines.push('- Specific metrics/results: [APPROVED METRIC REQUIRED]')
  placeholders.push('Quantified results require an approved metric')
  lines.push('')
  if (input.userNotes?.trim()) {
    lines.push('6. Author notes incorporated')
    lines.push(input.userNotes.trim())
    lines.push('')
  }
  lines.push('Human Review Required')
  lines.push('This deterministic draft was assembled without an AI provider and contains placeholders for every fact that must be supplied and verified by a human before approval:')
  for (const p of placeholders) lines.push(`- ${p}`)
  lines.push('- This draft does not guarantee compliance, evaluation success, or award.')

  return lines.join('\n')
}

// Generate a section draft. Uses the LLM with the EXACT prompt when a provider
// is configured; otherwise returns the deterministic fallback (source recorded
// by the caller). Never throws NO_LLM_KEY to the caller — falls back instead.
export async function generateSectionDraft(
  input: SectionDraftInput,
  consultingFirmId: string,
): Promise<{ content: string; source: 'AI' | 'DETERMINISTIC' }> {
  const userPrompt = [
    `PROPOSAL SECTION: ${input.sectionTitle}`,
    input.requirementText ? `SOLICITATION REQUIREMENT:\n${input.requirementText}` : 'SOLICITATION REQUIREMENT: [none supplied]',
    input.evaluationCriteria ? `EVALUATION CRITERIA:\n${input.evaluationCriteria}` : '',
    input.companyCapabilities ? `APPROVED COMPANY CAPABILITY CONTENT:\n${input.companyCapabilities}` : 'APPROVED COMPANY CAPABILITY CONTENT: [none supplied]',
    input.approvedPastPerformance ? `APPROVED PAST PERFORMANCE:\n${input.approvedPastPerformance}` : 'APPROVED PAST PERFORMANCE: [none supplied]',
    input.userNotes ? `USER NOTES:\n${input.userNotes}` : '',
  ].filter(Boolean).join('\n\n')

  try {
    const res = await generateWithRouter(
      { systemPrompt: PROPOSAL_DRAFTING_SYSTEM_PROMPT, userPrompt, maxTokens: 4000, temperature: 0.3 },
      consultingFirmId,
      { task: 'PROPOSAL_DRAFT', useCache: false },
    )
    const text = (res.text ?? '').trim()
    // Guarantee the AI label + review section are present even if the model omitted them.
    const content = text.includes(AI_DRAFT_LABEL) ? text : `${AI_DRAFT_LABEL}\n\n${text}`
    return { content, source: 'AI' }
  } catch {
    return { content: buildDeterministicSectionDraft(input), source: 'DETERMINISTIC' }
  }
}

// Deterministic proposal outline from VERIFIED compliance requirements. Groups
// requirements by their suggested section (or type) into ordered section stubs —
// no AI, no fabricated section names beyond what the requirements imply.
export function buildOutlineFromRequirements(
  requirements: { requirementText: string; proposalSection: string | null; sectionType: string; isMandatory: boolean }[],
): { title: string; requirementCount: number; requirementPreview: string[] }[] {
  const groups = new Map<string, { requirementText: string }[]>()
  for (const r of requirements) {
    const key = (r.proposalSection && r.proposalSection.trim()) || defaultSectionForType(r.sectionType)
    if (!groups.has(key)) groups.set(key, [])
    groups.get(key)!.push({ requirementText: r.requirementText })
  }
  return Array.from(groups.entries())
    .map(([title, reqs]) => ({ title, requirementCount: reqs.length, requirementPreview: reqs.slice(0, 3).map((r) => r.requirementText) }))
    .sort((a, b) => b.requirementCount - a.requirementCount || a.title.localeCompare(b.title))
}

function defaultSectionForType(type: string): string {
  switch (type.toUpperCase()) {
    case 'EVALUATION': return 'Response to Evaluation Criteria'
    case 'SUBMISSION': return 'Submission & Format Compliance'
    case 'FORMAT': return 'Submission & Format Compliance'
    case 'CERTIFICATION': return 'Certifications & Representations'
    case 'DOCUMENT': return 'Required Forms & Attachments'
    case 'DELIVERABLE': return 'Deliverables'
    case 'DEADLINE': return 'Schedule & Deadlines'
    default: return 'Instructions to Offerors'
  }
}
