// =============================================================
// Teaming Outreach Service — Phase E
//
// LLM-drafted personalized intro email/letter from a small-business
// consulting client TO the right contact at a federal prime contractor,
// pitching a teaming arrangement at a specific agency.
//
// Input: { consultingFirmId, clientId, primeUei, agencyCode }
// Output: { subject, body, suggestedContactRole, tokensConsumed }
//
// Cost: 1 proposal token per draft.
//
// Cross-references the Phase D teaming-fit score so the LLM can lead
// with the strongest factual reasons rather than generic "we'd love to
// team" filler.
//
// Audit: writes AuditEvent (action='LLM_INFERENCE', entityType=
// 'TeamingOutreach') with promptHash + token counts + estimatedCostUsd.
// Pattern copied from proposalAssist.ts.
// =============================================================

import crypto from 'crypto'
import { prisma } from '../config/database'
import { logger } from '../utils/logger'
import { generateWithRouter } from './llm/llmRouter'
import { logAudit } from './auditService'
import { computeTeamingFit, type TeamingFitResult } from './teamingSuggester'
import { deductProposalTokens } from '../middleware/tierGate'

export interface TeamingOutreachInput {
  consultingFirmId: string
  clientId: string
  primeUei: string
  agencyCode: string
  /** Optional — recorded on the AuditEvent for billing-dispute observability. */
  actorUserId?: string | null
}

export interface TeamingOutreachResult {
  subject: string
  body: string
  /** OSDBU | SBLO | "Capture Manager" — best contact role to address. */
  suggestedContactRole: string
  /** Proposal tokens consumed. */
  tokensConsumed: number
  /** Echoed fit score so the UI can show "based on X confidence". */
  fitScore: number
  fitConfidence: number
}

const OUTREACH_SYSTEM_PROMPT = `You are an expert federal-contracting business-development writer drafting a short, professional introductory email from a small-business consulting client to a prime contractor, proposing a teaming arrangement at a specific federal agency.

CRITICAL REQUIREMENTS:
- Total length: 175–250 words for the body. Concise wins; primes ignore long emails.
- Open with one sentence on WHO is writing (the client firm + cert) and WHY this specific prime (cite ONE concrete reason from the fit data provided — NAICS overlap, agency presence, sub-spend pattern, etc.).
- Middle paragraphs: 2–3 specific value propositions backed by the fit data. Avoid generic phrases like "we'd love to partner" or "we bring deep expertise."
- Close with a low-friction ask: "open to a 15-minute introductory call" — never demand an NDA, contract, or commitment upfront.
- Tone: confident but not pushy. Federal-contracting peer-to-peer, not a sales pitch.
- Sign with the client's firm name and the suggested contact role hint.
- Do NOT fabricate facts. If a fact isn't in the fit data, don't claim it.
- Do NOT include placeholders like [INSERT] or [TBD].

Return ONLY valid JSON — no markdown, no preamble:
{
  "subject": "concise subject line, max 70 chars",
  "body": "full plain-text email body, with line breaks as \\n\\n between paragraphs"
}`

/**
 * Decide which contact role at the prime to address the email to.
 * Rule of thumb in federal subcontracting:
 *  - subSpendRatio > 5%   → SBLO (Small Business Liaison Officer) — they
 *    already have a working teaming program, SBLO is the gatekeeper.
 *  - subSpendRatio ≤ 5% but agency-active → OSDBU (Office of Small &
 *    Disadvantaged Business Utilization) — there's a program but it's
 *    less mature; OSDBU is more reachable.
 *  - else                 → Capture Manager — they're not actively subbing,
 *    so target their capture team to plant the seed for a future capture.
 */
function chooseContactRole(fit: TeamingFitResult): string {
  const teamingActivity = fit.breakdown.primeTeamingActivity?.raw ?? 0
  if (teamingActivity > 0.6) return 'SBLO (Small Business Liaison Officer)'
  if (teamingActivity > 0.2) return 'OSDBU (Office of Small & Disadvantaged Business Utilization)'
  return 'Capture Manager'
}

export async function draftTeamingOutreach(
  input: TeamingOutreachInput,
): Promise<TeamingOutreachResult> {
  const { consultingFirmId, clientId, primeUei, agencyCode } = input

  // Tenant ownership check up front. Belt + suspenders against a caller
  // that forgot to check, since this service spends money.
  const client = await prisma.clientCompany.findFirst({
    where: { id: clientId, consultingFirmId },
    select: {
      id: true,
      name: true,
      naicsCodes: true,
      state: true,
      sdvosb: true,
      wosb: true,
      hubzone: true,
      smallBusiness: true,
      uei: true,
      cage: true,
    },
  })
  if (!client) throw new Error('Client not found for this firm')

  // Resolve prime metadata + agency name from the staging table.
  const primeAgg = await prisma.winnersAwardStage.findFirst({
    where: { recipientUei: primeUei, agencyToptierCode: agencyCode },
    select: { recipientName: true, agencyToptierName: true },
  })
  const primeName = primeAgg?.recipientName ?? `Prime (UEI ${primeUei})`
  const agencyName = primeAgg?.agencyToptierName ?? `Agency ${agencyCode}`

  // Compute fit. We re-compute every time (rather than caching) because
  // the underlying data refreshes weekly and the operator may pull a fresh
  // draft after a refresh expecting the latest signals.
  const fit = await computeTeamingFit({ clientId, primeUei, agencyCode })
  const suggestedContactRole = chooseContactRole(fit)

  // Compact fit summary for the LLM. We hand it the top-3 reasons and the
  // raw component scores — enough to write a specific email without
  // hallucinating numbers.
  const fitSummary = [
    `Teaming fit score: ${fit.score.toFixed(1)} / 100 (${fit.confidence >= 0.7 ? 'high' : fit.confidence >= 0.4 ? 'medium' : 'low'} confidence)`,
    `Top reasons:`,
    ...fit.reasons.map((r, i) => `  ${i + 1}. ${r}`),
    `Component scores (raw 0-1):`,
    ...Object.entries(fit.breakdown).map(([k, c]) => `  ${k}: ${c.raw.toFixed(2)} (confidence ${c.confidence.toFixed(2)})`),
  ].join('\n')

  const certs = [
    client.sdvosb && 'SDVOSB',
    client.wosb && 'WOSB',
    client.hubzone && 'HUBZone',
    client.smallBusiness && 'Small Business',
  ].filter(Boolean).join(', ') || 'Small Business (unverified)'

  const userPrompt = `Draft a teaming-introduction email.

CLIENT (the sender):
  Firm name: ${client.name}
  Certifications: ${certs}
  Primary NAICS: ${(client.naicsCodes || []).slice(0, 5).join(', ') || 'not specified'}
  State: ${client.state || 'not specified'}
  ${client.uei ? `UEI: ${client.uei}` : ''}
  ${client.cage ? `CAGE: ${client.cage}` : ''}

PRIME (the recipient):
  Name: ${primeName}
  UEI: ${primeUei}

TARGET AGENCY: ${agencyName} (toptier code ${agencyCode})

FIT DATA (use these specifics in the email; do not invent others):
${fitSummary}

SUGGESTED CONTACT ROLE: ${suggestedContactRole}
Tip: address the email to that role, e.g. "Dear ${suggestedContactRole} team," — the client will personalize once they identify the actual person.

Write the email now. Return ONLY the JSON object specified in the system prompt.`

  const llmReq = {
    systemPrompt: OUTREACH_SYSTEM_PROMPT,
    userPrompt,
    maxTokens: 1200,
    temperature: 0.5,
    timeoutMs: 60_000,
  }

  const response = await generateWithRouter(llmReq, consultingFirmId, {
    task: 'TEAMING_OUTREACH',
    useCache: false,
  })

  const { subject, body } = parseOutreachResponse(response.text)
  if (!subject || !body) {
    throw new Error('EMPTY_LLM_OUTPUT')
  }

  // Deduct 1 token. Done AFTER the LLM call succeeds so we don't charge
  // for failed generations. The caller already gated on sufficient balance
  // before invoking this service.
  const TOKEN_COST = 1
  await deductProposalTokens(consultingFirmId, TOKEN_COST, {
    userId: input.actorUserId ?? null,
    reason: `Teaming outreach draft for ${client.name} → ${primeName} @ ${agencyName}`,
  })

  // Audit row — LLM_INFERENCE pattern. promptHash so we can reproduce
  // the exact inputs if a billing dispute lands later.
  const promptHash = crypto
    .createHash('sha256')
    .update(OUTREACH_SYSTEM_PROMPT + '\n' + userPrompt)
    .digest('hex')

  void logAudit({
    consultingFirmId,
    actorUserId: input.actorUserId ?? null,
    action: 'LLM_INFERENCE',
    entityType: 'TeamingOutreach',
    entityId: `${clientId}:${primeUei}:${agencyCode}`,
    rationale: `Drafted teaming outreach: ${client.name} → ${primeName} @ ${agencyName}`,
    after: {
      promptHash,
      provider: response.provider,
      model: response.model,
      inputTokens: response.inputTokens,
      outputTokens: response.outputTokens,
      estimatedCostUsd: response.estimatedCostUsd,
      fitScore: fit.score,
      fitConfidence: fit.confidence,
      suggestedContactRole,
      tokensConsumed: TOKEN_COST,
    },
  })

  logger.info('Teaming outreach drafted', {
    consultingFirmId,
    clientId,
    primeUei,
    agencyCode,
    fitScore: fit.score,
    suggestedContactRole,
  })

  return {
    subject,
    body,
    suggestedContactRole,
    tokensConsumed: TOKEN_COST,
    fitScore: fit.score,
    fitConfidence: fit.confidence,
  }
}

/**
 * Parse the LLM's JSON response. Tolerates a code-fenced wrapper since
 * smaller models sometimes ignore the "no markdown" instruction.
 */
function parseOutreachResponse(raw: string): { subject: string; body: string } {
  let text = raw.trim()
  // Strip ``` or ```json fences if present.
  if (text.startsWith('```')) {
    text = text.replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/, '').trim()
  }
  try {
    const parsed = JSON.parse(text) as { subject?: unknown; body?: unknown }
    const subject = typeof parsed.subject === 'string' ? parsed.subject.trim() : ''
    const body = typeof parsed.body === 'string' ? parsed.body.trim() : ''
    return { subject, body }
  } catch {
    logger.warn('Failed to parse outreach JSON; returning empty', { rawPreview: text.slice(0, 200) })
    return { subject: '', body: '' }
  }
}
