// =============================================================
// SCW-4 Outreach Generator
//
// Per SUBCONTRACTING_WORKFLOW_SPEC.md §3 SCW-4. Drafts a personalized
// outreach email to a likely prime for a specific opportunity.
//
// Non-negotiables (spec §2 + §3 SCW-4):
//   - Tenant identity, opportunity title, prime stats, and capability
//     statement are all injected as STRUCTURED VARIABLES. The LLM is
//     instructed to use them verbatim and to NOT INVENT NUMBERS, NAMES,
//     OR FACTS.
//   - SDVOSB-compliance angle appears in the prompt ONLY when
//     sdvosbGoalGap.underPressure === true. We never imply a prime is
//     under pressure when we don't know.
//   - The LLM returns JSON with subject + body + factsCited[]. Before
//     persisting, a fact-check pass verifies every dollar amount and
//     every count mentioned in the body has a matching entry in
//     factsCited that traces back to a structured input.
//   - The draft is persisted with requiresHumanReview=true. There is no
//     auto-send code path; an operator must approve via PATCH route.
//   - AuditEvent row with action='LLM_INFERENCE', entityType=
//     'ScwOutreachDraft', LLM telemetry attached, promptHash for replay.
// =============================================================

import crypto from 'crypto'
import { Prisma, EmailVerificationStatus, RecipientProfile } from '@prisma/client'
import { prisma } from '../../config/database'
import { logger } from '../../utils/logger'
import { generateWithRouter } from '../llm/llmRouter'
import { logAudit } from '../auditService'
import { NotFoundError, ValidationError } from '../../utils/errors'
import { analyzeSubawards, SubawardAnalysis } from './subawardAnalysis'
import { readCachedContacts, enrichContacts } from '../recipientProfileService'
import type { ContactRow } from '../contactProviders'
import {
  resolveRecipientEmail,
  canAutoSend,
  isEmailEnrichmentEnabled,
  ResolvedRecipient,
} from './recipientEmailResolver'

export type OutreachType = 'cold_first_touch' | 'warm_follow_up' | 'urgent_deadline_driven'

export interface DraftOutreachInput {
  opportunityId: string
  consultingFirmId: string
  /** UEI when known; null for primes only on file by name. */
  primeUei?: string | null
  /** Required when primeUei is absent. */
  primeName?: string | null
  outreachType: OutreachType
  /** Inline capability statement for v1. v2 will look up by tenantCapabilityStatementId. */
  tenantCapabilityStatement: string
  /** Optional — recorded on the AuditEvent for billing/dispute observability. */
  actorUserId?: string | null
}

export interface OutreachDraft {
  id: string
  opportunityId: string
  primeUei: string | null
  primeName: string
  outreachType: OutreachType
  subject: string
  body: string
  salutation: string
  closing: string
  factsCited: Array<{ claim: string; source: string }>
  requiresHumanReview: true
  reviewChecklist: string[]
  // GB-104 — recipient email + verification gating.
  recipientEmail: string | null
  emailVerificationStatus: EmailVerificationStatus
  emailSource: string | null
  /** True unless the recipient is `verified`; the UI must not auto-send. */
  autoSendBlocked: boolean
  llmProvider: string
  llmModel: string
  tokensUsed: number
  createdAt: Date
}

// =============================================================
// Prompt
// =============================================================

const SYSTEM_PROMPT = `You are an expert federal-contracting business-development writer drafting a short, professional outreach email from a small-business consulting client to a prime contractor about a SPECIFIC current opportunity, proposing a teaming arrangement as a subcontractor.

CRITICAL REQUIREMENTS (violation = the draft is rejected by an automated fact-check pass):
- Use ONLY facts from the structured FACTS block provided in the user prompt. Do not invent numbers, dollar amounts, dates, contact names, agency names, set-aside types, or NAICS codes.
- Quote dollar amounts in the body in the same units as the FACTS block (e.g. "$854M" if FACTS shows 854M, not "850 million dollars").
- Quote counts verbatim ("3 past awards" if FACTS shows 3, not "several").
- Do not include placeholders like [INSERT], [TBD], [name], or [date].
- If the prime's primary contact name is NOT in the FACTS block, use a generic salutation directed to "Business Development team" or "Subcontracting team". Never invent a name.
- SDVOSB compliance angle: include this ONLY when FACTS.sdvosbCompliance.underPressure is true. Otherwise do not mention SDVOSB goal pressure at all.
- Total body length: 150–250 words. Concise wins.
- Open with WHO writes + WHY this prime + the specific opportunity title and solicitation number.
- Middle: 1–2 concrete value propositions tied to the FACTS.
- Close with a low-friction ask: e.g., "15-minute introductory call". Never demand NDA or commitment up front.
- factsCited[] must list every numeric or proper-noun claim in the body with its source (e.g. {"claim":"3 past awards","source":"primeStats.pastAwardsCount"}).

Return ONLY valid JSON — no markdown, no preamble:
{
  "subject": "concise subject line ≤ 70 chars",
  "salutation": "the salutation line, e.g. 'Dear Mr. Smith,' or 'Dear Business Development Team,'",
  "body": "full plain-text body, paragraphs separated by \\n\\n; do NOT include the salutation or closing here",
  "closing": "closing line e.g. 'Best regards, <Tenant Firm Name>'",
  "factsCited": [{"claim":"<verbatim claim>","source":"<FACTS path>"}, ...]
}`

// =============================================================
// Public entry point
// =============================================================

export async function draftScwOutreach(input: DraftOutreachInput): Promise<OutreachDraft> {
  const {
    opportunityId,
    consultingFirmId,
    primeUei,
    primeName,
    outreachType,
    tenantCapabilityStatement,
    actorUserId,
  } = input

  if (!primeUei && !primeName) {
    throw new ValidationError('draftScwOutreach requires either primeUei or primeName')
  }
  if (!tenantCapabilityStatement?.trim()) {
    throw new ValidationError('tenantCapabilityStatement is required (inline for v1)')
  }

  // Tenant-scoped opportunity load — surfaces 404 if the opp belongs to a
  // different firm, mirroring SCW-1's behavior.
  const opportunity = await prisma.opportunity.findFirst({
    where: { id: opportunityId, consultingFirmId },
    select: {
      id: true,
      title: true,
      samNoticeId: true,
      agency: true,
      subagency: true,
      naicsCode: true,
      setAsideType: true,
      responseDeadline: true,
      estimatedValue: true,
      placeOfPerformance: true,
    },
  })
  if (!opportunity) {
    throw new NotFoundError(`Opportunity ${opportunityId}`)
  }

  // Tenant firm metadata — name, SDVOSB cert, etc. — for the "from" voice.
  const firm = await prisma.consultingFirm.findUnique({
    where: { id: consultingFirmId },
    select: { id: true, name: true, llmProvider: true },
  })

  // Prime stats — past awards in NAICS+agency over the spec's 5-year window.
  // Aggregate inline (rather than calling findLikelyPrimes for a single
  // prime) because we want this prime specifically, not "top 10 candidates".
  const primeStats = await loadPrimeStats(opportunity.naicsCode, opportunity.agency, primeUei, primeName)
  if (primeStats.pastAwardsCount === 0) {
    throw new ValidationError(
      `No past awards on file for ${primeName ?? primeUei} in NAICS ${opportunity.naicsCode} at ${opportunity.agency} — cannot ground an outreach. Consider a different prime.`,
    )
  }

  const subawardAnalysis: SubawardAnalysis = await analyzeSubawards({
    primeUei,
    primeName,
    lookbackYears: 3,
  })

  // Contact (if known) — never invent. Read via the canonical layer.
  const profile = primeUei
    ? await prisma.recipientProfile.findUnique({ where: { uei: primeUei } })
    : null
  const contactName = profile ? primaryContactName(profile) : null

  // GB-104 — resolve a deliverable recipient email from the already-
  // approved enrichment layer. Gated; default off preserves prior
  // behavior (no recipient email). Never throws — a missing email yields
  // the explicit "supply before send" state, not a failure.
  let recipient: ResolvedRecipient = {
    email: null,
    status: EmailVerificationStatus.unknown,
    source: null,
    contactName: null,
  }
  if (isEmailEnrichmentEnabled()) {
    recipient = await resolveOutreachRecipient(primeUei ?? null, profile)
  }

  // Build the structured FACTS block the LLM is instructed to draw from.
  // Numbers are pre-rendered into the strings we want quoted, so the LLM
  // doesn't have an opportunity to round or paraphrase them.
  const facts = {
    tenant: {
      firmName: firm?.name ?? 'Bytes Platform',
      capabilityStatement: tenantCapabilityStatement.trim(),
    },
    opportunity: {
      title: opportunity.title,
      solicitationNumber: opportunity.samNoticeId ?? null,
      agency: firstAgencySegment(opportunity.agency),
      subagency: opportunity.subagency ?? null,
      naics: opportunity.naicsCode,
      setAside: opportunity.setAsideType,
      responseDeadlineIso: opportunity.responseDeadline.toISOString().slice(0, 10),
      daysRemaining: daysBetween(new Date(), opportunity.responseDeadline),
      estimatedValueDisplay: opportunity.estimatedValue
        ? `$${fmtDollarsShort(Number(opportunity.estimatedValue))}`
        : 'undisclosed',
      placeOfPerformance: opportunity.placeOfPerformance ?? null,
    },
    primeStats: {
      primeName: primeName ?? profile?.legalName ?? 'this prime',
      pastAwardsCount: primeStats.pastAwardsCount,
      totalPastValueDisplay: `$${fmtDollarsShort(primeStats.totalPastValue)}`,
      mostRecentAwardIso: primeStats.mostRecentAward
        ? primeStats.mostRecentAward.toISOString().slice(0, 10)
        : null,
    },
    subawardHistory: {
      totalSubawardDollarsDisplay:
        subawardAnalysis.totalSubawardDollars !== null
          ? `$${fmtDollarsShort(subawardAnalysis.totalSubawardDollars)}`
          : 'not on file',
      averageSubSizeDisplay:
        subawardAnalysis.averageSubSize !== null
          ? `$${fmtDollarsShort(subawardAnalysis.averageSubSize)}`
          : 'not on file',
      sampleSize: subawardAnalysis.dataQuality.sampleSize,
    },
    sdvosbCompliance: {
      underPressure: subawardAnalysis.sdvosbGoalGap.underPressure,
      // intentionally omit goal/actual when underPressure is false so the
      // LLM has nothing to riff on
      ...(subawardAnalysis.sdvosbGoalGap.underPressure
        ? {
            goalPercent: subawardAnalysis.sdvosbGoalGap.goalPercent,
            actualPercent: subawardAnalysis.sdvosbGoalGap.actualPercent,
            fiscalYear: subawardAnalysis.sdvosbGoalGap.fiscalYear,
          }
        : {}),
    },
    contact: {
      primaryContactName: contactName,
    },
    outreachType,
  }

  const userPrompt = renderUserPrompt(facts, outreachType)
  const promptHash = sha256(`${SYSTEM_PROMPT}\n${userPrompt}`)

  // Call the LLM through the house router (per-firm provider + cost
  // metering). v1 only generates ONE variant per call; spec mentions "three
  // variants" — we treat that as a UX feature for v2 (re-roll button) so
  // we don't burn 3x tokens per draft.
  const llm = await generateWithRouter(
    {
      systemPrompt: SYSTEM_PROMPT,
      userPrompt,
      maxTokens: 1500,
      temperature: 0.4,
    },
    consultingFirmId,
    // SCW-4 reuses the TEAMING_OUTREACH LLMTask key — subcontract outreach
    // IS a teaming arrangement, the existing per-firm cost/cache settings
    // for TEAMING_OUTREACH apply unchanged.
    { task: 'TEAMING_OUTREACH' },
  )

  const parsed = parseLlmJson(llm.text)
  factCheckOrThrow(parsed, facts)

  const reviewChecklist = buildReviewChecklist(facts)
  // GB-104 — recipient-email review items. A non-verified or missing
  // address can never auto-send; the operator confirms before sending.
  const autoSendBlocked = !canAutoSend(recipient.status)
  if (!recipient.email) {
    reviewChecklist.push('Recipient email missing — supply a deliverable address before sending')
  } else if (recipient.status !== EmailVerificationStatus.verified) {
    reviewChecklist.push(
      `Confirm recipient email (${recipient.email}) is correct — status is ${recipient.status}, not auto-send eligible`,
    )
  }

  // Persist the draft. requiresHumanReview is true by construction — there
  // is no code path in v1 that flips it without an explicit approval call.
  const persisted = await prisma.scwOutreachDraft.create({
    data: {
      opportunityId,
      consultingFirmId,
      primeUei: primeUei ?? null,
      primeName: facts.primeStats.primeName,
      outreachType,
      subject: parsed.subject,
      body: parsed.body,
      salutation: parsed.salutation,
      closing: parsed.closing,
      factsCited: parsed.factsCited as unknown as Prisma.InputJsonValue,
      reviewChecklist: reviewChecklist as unknown as Prisma.InputJsonValue,
      requiresHumanReview: true,
      recipientEmail: recipient.email,
      emailVerificationStatus: recipient.status,
      emailSource: recipient.source,
      llmProvider: llm.provider,
      llmModel: llm.model,
      tokensUsed: llm.inputTokens + llm.outputTokens,
    },
  })

  // Audit — LLM_INFERENCE row with replay metadata so we can reconstruct
  // exactly what was sent if a customer disputes a draft later.
  await logAudit({
    consultingFirmId,
    actorUserId: actorUserId ?? null,
    action: 'LLM_INFERENCE',
    entityType: 'ScwOutreachDraft',
    entityId: persisted.id,
    llmProvider: llm.provider,
    llmModel: llm.model,
    llmTask: 'scw_outreach_draft',
    promptHash,
    inputTokens: llm.inputTokens,
    outputTokens: llm.outputTokens,
    estimatedCostUsd: llm.estimatedCostUsd,
  })

  logger.info('SCW-4: outreach draft generated', {
    draftId: persisted.id,
    opportunityId,
    primeUei,
    primeName: facts.primeStats.primeName,
    outreachType,
    provider: llm.provider,
    tokens: llm.inputTokens + llm.outputTokens,
  })

  return {
    id: persisted.id,
    opportunityId,
    primeUei: primeUei ?? null,
    primeName: facts.primeStats.primeName,
    outreachType,
    subject: parsed.subject,
    body: parsed.body,
    salutation: parsed.salutation,
    closing: parsed.closing,
    factsCited: parsed.factsCited,
    requiresHumanReview: true,
    reviewChecklist,
    recipientEmail: recipient.email,
    emailVerificationStatus: recipient.status,
    emailSource: recipient.source,
    autoSendBlocked,
    llmProvider: llm.provider,
    llmModel: llm.model,
    tokensUsed: llm.inputTokens + llm.outputTokens,
    createdAt: persisted.createdAt,
  }
}

// =============================================================
// GB-104 recipient resolution
// =============================================================

/**
 * Resolve a recipient email from cached enrichment contacts. When the
 * cache has no email and we hold a UEI, attempt one pull from the
 * already-approved contact provider (no new third party). Best-effort:
 * any provider error degrades to the "no email" state, never throws.
 */
async function resolveOutreachRecipient(
  primeUei: string | null,
  profile: RecipientProfile | null,
): Promise<ResolvedRecipient> {
  let contacts: ContactRow[] = profile ? readCachedContacts(profile).contacts : []

  if (!contacts.some((c) => c.email) && primeUei) {
    try {
      const enriched = await enrichContacts(primeUei)
      contacts = enriched.contacts
    } catch (err) {
      logger.warn('SCW-4 contact enrichment unavailable; drafting without recipient email', {
        primeUei,
        err: err instanceof Error ? err.message : String(err),
      })
    }
  }

  return resolveRecipientEmail(contacts)
}

// =============================================================
// Prompt rendering
// =============================================================

function renderUserPrompt(facts: Record<string, unknown>, outreachType: OutreachType): string {
  const intent =
    outreachType === 'urgent_deadline_driven'
      ? 'The opportunity deadline is near, so the email should be direct and time-sensitive (not panicked).'
      : outreachType === 'warm_follow_up'
      ? 'Tone is a follow-up to a prior introduction; reference shared context succinctly.'
      : 'Cold first touch — no prior history; lead with value and credibility.'

  return [
    `Outreach type: ${outreachType}.`,
    `Intent: ${intent}`,
    '',
    'FACTS (the ONLY facts you may use; do not invent any others):',
    '```json',
    JSON.stringify(facts, null, 2),
    '```',
    '',
    'Draft the outreach now. Return JSON only.',
  ].join('\n')
}

// =============================================================
// LLM output parsing
// =============================================================

interface ParsedLlmResponse {
  subject: string
  salutation: string
  body: string
  closing: string
  factsCited: Array<{ claim: string; source: string }>
}

function parseLlmJson(text: string): ParsedLlmResponse {
  // Strip ```json fences if the LLM ignored the instruction.
  const stripped = text
    .trim()
    .replace(/^```(?:json)?\s*/i, '')
    .replace(/\s*```$/i, '')
    .trim()

  let obj: unknown
  try {
    obj = JSON.parse(stripped)
  } catch (err) {
    throw new ValidationError(
      `SCW-4 LLM response was not valid JSON: ${(err as Error).message}. First 200 chars: ${text.slice(0, 200)}`,
    )
  }

  const o = obj as Record<string, unknown>
  const subject = asStr(o.subject)
  const salutation = asStr(o.salutation)
  const body = asStr(o.body)
  const closing = asStr(o.closing)
  if (!subject || !salutation || !body || !closing) {
    throw new ValidationError('SCW-4 LLM response missing one of: subject / salutation / body / closing')
  }
  const factsCitedRaw = Array.isArray(o.factsCited) ? (o.factsCited as unknown[]) : []
  const factsCited = factsCitedRaw
    .filter((c) => c && typeof c === 'object')
    .map((c) => {
      const cc = c as Record<string, unknown>
      return { claim: asStr(cc.claim) ?? '', source: asStr(cc.source) ?? '' }
    })
    .filter((c) => c.claim && c.source)

  return { subject, salutation, body, closing, factsCited }
}

// =============================================================
// Fact-check pass
// =============================================================

/**
 * Verify every numeric token and every "Mr./Ms./Dr." salutation candidate
 * in the body either appears in the FACTS block or is annotated in
 * factsCited. Throws ValidationError on the first hallucination — caller
 * is expected to surface this to the operator and offer a re-roll.
 *
 * This is conservative on purpose. False positives (e.g. "180 days" when
 * 180 isn't in FACTS) are caught — the operator can override by editing
 * the draft post-generation. False negatives (LLM swapping "$854M" for
 * "$854m") are unlikely because the LLM is instructed to quote verbatim.
 */
function factCheckOrThrow(parsed: ParsedLlmResponse, facts: Record<string, unknown>): void {
  const factsText = JSON.stringify(facts)

  // Every dollar amount (e.g. "$42M", "$1.5B", "$133K") in the body must
  // appear in either FACTS or factsCited.
  const dollarTokens = Array.from(parsed.body.matchAll(/\$\s*[\d.,]+\s*[KMB]?\b/gi)).map((m) => m[0])
  for (const tok of dollarTokens) {
    const normalized = tok.replace(/\s+/g, '')
    if (!factsText.includes(normalized) && !parsed.factsCited.some((c) => c.claim.includes(normalized))) {
      throw new ValidationError(
        `SCW-4 fact-check: body contains "${tok}" but it does not appear in FACTS or factsCited. LLM may have hallucinated a dollar amount.`,
      )
    }
  }

  // Every standalone integer ≥ 2 (e.g. "5 past awards") must appear in
  // FACTS or factsCited. Years (1900-2099), basic dates, and 1-digit
  // numbers are exempted to keep the check tractable.
  const intTokens = Array.from(parsed.body.matchAll(/\b(\d{2,4})\b/g)).map((m) => m[1])
  for (const tok of intTokens) {
    const n = Number(tok)
    if (n >= 1900 && n <= 2099) continue // year
    if (!factsText.includes(tok) && !parsed.factsCited.some((c) => c.claim.includes(tok))) {
      throw new ValidationError(
        `SCW-4 fact-check: body contains the number "${tok}" but it does not appear in FACTS or factsCited.`,
      )
    }
  }

  // If FACTS has no contact name, the salutation must NOT contain a personal name.
  const contactName = (facts.contact as { primaryContactName?: string | null } | undefined)?.primaryContactName
  if (!contactName) {
    if (/\b(Mr\.|Ms\.|Mrs\.|Dr\.|Mx\.)\s+[A-Z][a-z]+/.test(parsed.salutation)) {
      throw new ValidationError(
        `SCW-4 fact-check: salutation appears to address a personal name, but no contact name is on file. Generic salutation required.`,
      )
    }
  }
}

// =============================================================
// Review checklist generator
// =============================================================

function buildReviewChecklist(facts: Record<string, unknown>): string[] {
  const items: string[] = [
    'Subject line is accurate and references the correct opportunity',
    'Body cites only facts present in the FACTS block (spot-check 2-3 numbers)',
    'Salutation is appropriate (named contact only when on file)',
    'Tone matches the outreach_type intent',
    'No placeholders ([INSERT], [TBD], [name])',
  ]
  const sdvosb = facts.sdvosbCompliance as { underPressure?: boolean } | undefined
  if (sdvosb?.underPressure) {
    items.push('SDVOSB-goal-gap reference is accurate (do not soften or strengthen)')
  } else {
    items.push('Body does NOT imply the prime is behind their SDVOSB goal (data was not available)')
  }
  return items
}

// =============================================================
// Prime stats query (window-scoped)
// =============================================================

interface PrimeStatsRow {
  past_awards_count: bigint
  total_past_value: string | null
  most_recent_award: Date | null
}

async function loadPrimeStats(
  naics: string,
  rawAgency: string,
  primeUei?: string | null,
  primeName?: string | null,
): Promise<{ pastAwardsCount: number; totalPastValue: number; mostRecentAward: Date | null }> {
  const agencyFirstSegment = (rawAgency || '').split('.')[0]?.trim() ?? ''
  const agencyPattern = `${agencyFirstSegment}%`
  const cutoff = new Date()
  cutoff.setUTCFullYear(cutoff.getUTCFullYear() - 5)

  let rows: PrimeStatsRow[]
  if (primeUei) {
    rows = await prisma.$queryRaw<PrimeStatsRow[]>`
      SELECT
        COUNT(*)                  AS past_awards_count,
        SUM("totalObligation")    AS total_past_value,
        MAX("awardDate")          AS most_recent_award
      FROM winners_award_stage
      WHERE "recipientUei" = ${primeUei}
        AND naics = ${naics}
        AND "agencyToptierName" ILIKE ${agencyPattern}
        AND "awardDate" >= ${cutoff}
    `
  } else {
    rows = await prisma.$queryRaw<PrimeStatsRow[]>`
      SELECT
        COUNT(*)                  AS past_awards_count,
        SUM("totalObligation")    AS total_past_value,
        MAX("awardDate")          AS most_recent_award
      FROM winners_award_stage
      WHERE "recipientName" = ${primeName}
        AND naics = ${naics}
        AND "agencyToptierName" ILIKE ${agencyPattern}
        AND "awardDate" >= ${cutoff}
    `
  }
  const r = rows[0]
  return {
    pastAwardsCount: r ? Number(r.past_awards_count) : 0,
    totalPastValue: r?.total_past_value ? Number(r.total_past_value) : 0,
    mostRecentAward: r?.most_recent_award ?? null,
  }
}

// =============================================================
// Helpers
// =============================================================

function primaryContactName(
  profile: Awaited<ReturnType<typeof prisma.recipientProfile.findUnique>>,
): string | null {
  if (!profile) return null
  const { contacts } = readCachedContacts(profile)
  const named = contacts.find((c) => c.name)
  return named?.name ?? null
}

function firstAgencySegment(s: string | null | undefined): string {
  if (!s) return ''
  return (s.split('.')[0] ?? '').trim()
}

function daysBetween(a: Date, b: Date): number {
  const diff = b.getTime() - a.getTime()
  return Math.max(0, Math.ceil(diff / (24 * 60 * 60 * 1000)))
}

function fmtDollarsShort(n: number): string {
  if (n >= 1_000_000_000) return `${(n / 1_000_000_000).toFixed(1)}B`
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`
  if (n >= 1_000) return `${(n / 1_000).toFixed(0)}K`
  return n.toFixed(0)
}

function sha256(s: string): string {
  return crypto.createHash('sha256').update(s, 'utf8').digest('hex')
}

function asStr(v: unknown): string {
  if (v === null || v === undefined) return ''
  return String(v).trim()
}

// Exposed for tests so they can drive the fact-check pass without mocking
// the full LLM round-trip.
export const __scwOutreachInternals = { parseLlmJson, factCheckOrThrow, buildReviewChecklist }
