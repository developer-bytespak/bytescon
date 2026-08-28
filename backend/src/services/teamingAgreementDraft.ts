// =============================================================
// Teaming / NDA agreement DRAFT generation (§5.1 Stage 4). The primary path is
// a DETERMINISTIC text builder that needs no API key — it assembles an editable
// first draft from stored party/opportunity/role/workshare data, inserting
// clearly-labelled [PLACEHOLDER] tokens for anything not supplied, and never
// fabricating legal or commercial terms. Every draft opens with the mandatory
// review disclaimer and is never presented as executed.
//
// TEAMING_AGREEMENT_SYSTEM_PROMPT is the EXACT, verbatim system prompt to use if
// the optional LLM path (services/llm/llmRouter.generateWithRouter) is wired —
// it must not be shortened, paraphrased, or replaced.
// =============================================================

// --- EXACT SYSTEM PROMPT START ---
export const TEAMING_AGREEMENT_SYSTEM_PROMPT = `You are the Teaming Agreement Drafting Assistant inside Bytescon.

Your role is to prepare a structured, editable first draft of a teaming agreement or non-disclosure agreement using only the information explicitly supplied by the application.

You must follow these rules:

1. Treat the output as a draft for professional and legal review, not as legal advice and not as an executed agreement.
2. Do not invent company names, addresses, registration details, opportunity information, contract values, workshare percentages, responsibilities, dates, governing law, dispute terms, payment terms, exclusivity terms, intellectual-property terms, or regulatory obligations.
3. When required information is missing, insert a clearly labelled placeholder in square brackets, such as [LEGAL NAME REQUIRED], [WORKSHARE PERCENTAGE REQUIRED], or [GOVERNING LAW TO BE REVIEWED].
4. Use the supplied opportunity, prime/subcontractor roles, capability contributions, workshare information, agreement type, and party details exactly as provided.
5. Clearly separate confirmed application data from placeholders requiring human review.
6. Include a prominent notice at the beginning: “DRAFT FOR REVIEW — NOT LEGAL ADVICE — NOT EXECUTED.”
7. Use professional, neutral, plain-English language.
8. Do not promise contract award, government approval, set-aside eligibility, regulatory compliance, or enforceability.
9. Do not state that either party has signed, accepted, approved, or executed the agreement unless the application explicitly provides that confirmed status.
10. Do not include sensitive credentials, internal system details, API keys, or unrelated tenant information.
11. Keep the draft internally consistent. If supplied values conflict, do not choose one silently; identify the conflict in a “Review Required” section.
12. Include the following sections where relevant:
   - Draft status notice
   - Parties
   - Opportunity identification
   - Purpose
   - Proposed roles and responsibilities
   - Capability contributions
   - Proposed workshare
   - Information-sharing obligations
   - Confidentiality terms for NDA drafts
   - Proposal cooperation
   - Costs and expenses
   - Exclusivity only when explicitly supplied
   - Intellectual property only when explicitly supplied
   - Term and termination
   - Compliance responsibilities
   - Notices
   - Governing law placeholder unless supplied
   - Signature blocks marked as unsigned
   - Review Required items
13. End with: “This document requires review and approval by authorized representatives and qualified legal counsel before use or execution.”

Return only the agreement draft. Do not add commentary outside the document.`
// --- EXACT SYSTEM PROMPT END ---

export const DRAFT_DISCLAIMER = 'DRAFT FOR REVIEW — NOT LEGAL ADVICE — NOT EXECUTED.'
export const DRAFT_CLOSING = 'This document requires review and approval by authorized representatives and qualified legal counsel before use or execution.'

export type AgreementDraftType = 'TEAMING_AGREEMENT' | 'NDA'

export interface AgreementDraftInput {
  draftType: AgreementDraftType
  firmName: string
  partnerName: string
  partnerRole: string // PRIME | SUB | JV_MEMBER | MENTOR_PROTEGE
  arrangementType: string
  opportunityTitle: string
  agency: string | null
  solicitationNumber: string | null
  scopePercent: number | null
  workshareDescription: string | null
  capabilityContribution: string | null
}

function placeholder(label: string): string {
  return `[${label}]`
}
function val(v: string | null | undefined, label: string): string {
  return v && String(v).trim() ? String(v).trim() : placeholder(label)
}

// Build a deterministic, editable draft. Confirmed application data is used as
// supplied; everything else is a labelled placeholder for human/legal review.
export function buildAgreementDraft(input: AgreementDraftInput): string {
  const isNda = input.draftType === 'NDA'
  const kind = isNda ? 'Non-Disclosure Agreement' : 'Teaming Agreement'
  const lines: string[] = []

  lines.push(DRAFT_DISCLAIMER)
  lines.push('')
  lines.push(`${kind.toUpperCase()} — DRAFT`)
  lines.push('')
  lines.push('1. Draft status notice')
  lines.push('This is an automatically-assembled first draft populated only from data recorded in Bytescon. It is not legal advice and has not been executed. Bracketed items require human and legal review.')
  lines.push('')
  lines.push('2. Parties')
  lines.push(`- Prime / sponsoring party: ${val(input.firmName, 'LEGAL NAME REQUIRED')}, ${placeholder('ADDRESS REQUIRED')}, ${placeholder('REGISTRATION / UEI REQUIRED')}`)
  lines.push(`- Teaming party: ${val(input.partnerName, 'LEGAL NAME REQUIRED')}, ${placeholder('ADDRESS REQUIRED')}, ${placeholder('REGISTRATION / UEI REQUIRED')}`)
  lines.push('')
  lines.push('3. Opportunity identification')
  lines.push(`- Opportunity: ${val(input.opportunityTitle, 'OPPORTUNITY TITLE REQUIRED')}`)
  lines.push(`- Agency: ${val(input.agency, 'AGENCY TO BE CONFIRMED')}`)
  lines.push(`- Solicitation number: ${val(input.solicitationNumber, 'SOLICITATION NUMBER TO BE CONFIRMED')}`)
  lines.push('')
  lines.push('4. Purpose')
  lines.push(isNda
    ? 'To permit the parties to exchange confidential information solely to evaluate and prepare a potential teaming relationship for the opportunity identified above.'
    : 'To set out the parties’ intent to cooperate, as prime and teaming party, in preparing and, if awarded, performing the opportunity identified above.')
  lines.push('')
  if (!isNda) {
    lines.push('5. Proposed roles and responsibilities')
    lines.push(`- ${val(input.partnerName, 'PARTNER NAME REQUIRED')} proposed role: ${val(input.partnerRole, 'ROLE REQUIRED')} (arrangement type: ${val(input.arrangementType, 'ARRANGEMENT TYPE REQUIRED')}).`)
    lines.push(`- Detailed responsibilities: ${placeholder('RESPONSIBILITIES TO BE DEFINED')}`)
    lines.push('')
    lines.push('6. Capability contributions')
    lines.push(`- ${val(input.capabilityContribution, 'CAPABILITY CONTRIBUTION TO BE DEFINED')}`)
    lines.push('')
    lines.push('7. Proposed workshare')
    lines.push(`- Workshare percentage: ${input.scopePercent != null ? `${input.scopePercent}%` : placeholder('WORKSHARE PERCENTAGE REQUIRED')}`)
    lines.push(`- Workshare description: ${val(input.workshareDescription, 'WORKSHARE DESCRIPTION TO BE DEFINED')}`)
    lines.push('')
  }
  lines.push(`${isNda ? '5' : '8'}. Information-sharing obligations`)
  lines.push('Each party will share only information reasonably necessary for the stated purpose and will protect information received as set out below.')
  lines.push('')
  if (isNda) {
    lines.push('6. Confidentiality terms')
    lines.push('- Confidential Information means non-public information disclosed by a party and marked or reasonably understood to be confidential.')
    lines.push(`- Confidentiality period: ${placeholder('CONFIDENTIALITY PERIOD TO BE REVIEWED')}`)
    lines.push('- Standard exclusions (already public, independently developed, lawfully received) apply.')
    lines.push('')
  }
  lines.push(`${isNda ? '7' : '9'}. Proposal cooperation`)
  lines.push('The parties will cooperate in good faith on proposal preparation; this draft creates no obligation to submit or award any proposal.')
  lines.push('')
  lines.push(`${isNda ? '8' : '10'}. Costs and expenses`)
  lines.push('Unless otherwise agreed in writing, each party bears its own costs. Cost-sharing terms: ' + placeholder('COST TERMS TO BE REVIEWED'))
  lines.push('')
  lines.push(`${isNda ? '9' : '11'}. Exclusivity`)
  lines.push(placeholder('EXCLUSIVITY TERMS ONLY IF SUPPLIED — NONE SUPPLIED'))
  lines.push('')
  lines.push(`${isNda ? '10' : '12'}. Intellectual property`)
  lines.push(placeholder('IP TERMS ONLY IF SUPPLIED — NONE SUPPLIED'))
  lines.push('')
  lines.push(`${isNda ? '11' : '13'}. Term and termination`)
  lines.push(`- Effective date: ${placeholder('EFFECTIVE DATE TO BE REVIEWED')}. Term: ${placeholder('TERM TO BE REVIEWED')}.`)
  lines.push('')
  lines.push(`${isNda ? '12' : '14'}. Compliance responsibilities`)
  lines.push('Each party is responsible for its own compliance with applicable law and regulation. This draft makes no representation about set-aside eligibility, regulatory compliance, or enforceability.')
  lines.push('')
  lines.push(`${isNda ? '13' : '15'}. Notices`)
  lines.push(`Notices to: ${placeholder('NOTICE CONTACTS TO BE REVIEWED')}`)
  lines.push('')
  lines.push(`${isNda ? '14' : '16'}. Governing law`)
  lines.push(placeholder('GOVERNING LAW TO BE REVIEWED'))
  lines.push('')
  lines.push(`${isNda ? '15' : '17'}. Signatures (UNSIGNED — for review only)`)
  lines.push(`- ${val(input.firmName, 'LEGAL NAME REQUIRED')}: ______________________  Name/Title: ${placeholder('SIGNATORY REQUIRED')}  Date: ____________  [UNSIGNED]`)
  lines.push(`- ${val(input.partnerName, 'LEGAL NAME REQUIRED')}: ______________________  Name/Title: ${placeholder('SIGNATORY REQUIRED')}  Date: ____________  [UNSIGNED]`)
  lines.push('')
  lines.push('Review Required')
  lines.push('- All bracketed placeholders above must be completed and reviewed by qualified legal counsel.')
  lines.push('')
  lines.push(DRAFT_CLOSING)

  return lines.join('\n')
}
