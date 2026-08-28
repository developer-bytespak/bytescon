// =============================================================
// GB-103 Client Match Notification Service
//
// The testable core of the match-diff job. For each firm:
//   1. Load opportunities ingested/updated since the firm's stored
//      high-water mark (not a full table scan).
//   2. Score each against active client profiles with the corrected
//      GB-101/102 scorer (scoreOpportunityForClient).
//   3. Select (client, opportunity) pairs at/above the client's
//      threshold that are absent from the SentNotification ledger.
//   4. Send one email per match (IMMEDIATE) or one aggregated digest
//      (DIGEST), then write a SentNotification row + audit entry.
//   5. Advance the high-water mark.
//
// Idempotency: the SentNotification (clientCompanyId, opportunityId)
// unique constraint plus the absent-from-ledger filter guarantee
// re-running produces zero duplicate sends. The ledger row is written
// only after a successful (or dev-fallback) send, so a hard delivery
// failure is retried on the next run rather than silently lost.
//
// Feature flag: CLIENT_NOTIFICATIONS_ENABLED (default off in prod).
// =============================================================

import { NotificationFrequency } from '@prisma/client'
import { config } from '../config/config'
import { prisma } from '../config/database'
import { logger } from '../utils/logger'
import { roundTo } from '../utils/number'
import { sendEmail } from './mailer'
import { logAudit } from './auditService'
import { scoreOpportunityForClient } from '../engines/probabilityEngine'
import {
  renderClientMatchEmail,
  MatchEmailItem,
} from './clientMatchNotificationEmail'

const DEFAULT_THRESHOLD = config.notifications.defaultThreshold

// How many candidate opportunities to consider per firm per run. The
// high-water mark keeps this small in steady state; the cap bounds the
// first run (no mark yet) on a firm with a large backlog.
const MAX_CANDIDATE_OPPS = 2000

export function isClientNotificationsEnabled(): boolean {
  const raw = (process.env.CLIENT_NOTIFICATIONS_ENABLED || '').toLowerCase().trim()
  return raw === '1' || raw === 'true' || raw === 'yes'
}

export interface RunResult {
  enabled: boolean
  firmsProcessed: number
  notificationsSent: number
  ledgerRowsWritten: number
}

export interface RunOptions {
  /** Process a single firm. Omit to sweep all active firms. */
  consultingFirmId?: string
  /** Injectable clock for deterministic tests. */
  now?: Date
}

export async function runClientMatchNotifications(opts: RunOptions = {}): Promise<RunResult> {
  const result: RunResult = { enabled: true, firmsProcessed: 0, notificationsSent: 0, ledgerRowsWritten: 0 }

  if (!isClientNotificationsEnabled()) {
    logger.info('Client match notifications skipped — CLIENT_NOTIFICATIONS_ENABLED is off')
    return { ...result, enabled: false }
  }

  const now = opts.now ?? new Date()

  const firms = opts.consultingFirmId
    ? await prisma.consultingFirm.findMany({ where: { id: opts.consultingFirmId } })
    : await prisma.consultingFirm.findMany({ where: { isActive: true } })

  for (const firm of firms) {
    try {
      const firmResult = await processFirm(firm.id, now)
      result.firmsProcessed += 1
      result.notificationsSent += firmResult.notificationsSent
      result.ledgerRowsWritten += firmResult.ledgerRowsWritten
    } catch (err) {
      logger.error('Client match notifications failed for firm (continuing)', {
        firmId: firm.id,
        error: (err as Error).message,
      })
    }
  }

  logger.info('Client match notification run complete', {
    firmsProcessed: result.firmsProcessed,
    notificationsSent: result.notificationsSent,
    ledgerRowsWritten: result.ledgerRowsWritten,
  })
  return result
}

interface FirmRunResult {
  notificationsSent: number
  ledgerRowsWritten: number
}

interface ClientCtx {
  id: string
  name: string
  naicsCodes: string[]
  sdvosb: boolean
  wosb: boolean
  hubzone: boolean
  smallBusiness: boolean
  threshold: number
  frequency: NotificationFrequency
  recipientEmail: string | null
}

async function processFirm(consultingFirmId: string, now: Date): Promise<FirmRunResult> {
  const out: FirmRunResult = { notificationsSent: 0, ledgerRowsWritten: 0 }

  const firm = await prisma.consultingFirm.findUnique({
    where: { id: consultingFirmId },
    select: {
      id: true,
      name: true,
      contactEmail: true,
      lastMatchNotifiedAt: true,
      brandingDisplayName: true,
      brandingTagline: true,
      brandingPrimaryColor: true,
      isVeteranOwned: true,
    },
  })
  if (!firm) return out

  const highWater = firm.lastMatchNotifiedAt

  // ── Eligible clients (enabled preference, or default-enabled) ──
  const clients = await prisma.clientCompany.findMany({
    where: { consultingFirmId, isActive: true },
    select: {
      id: true,
      name: true,
      naicsCodes: true,
      sdvosb: true,
      wosb: true,
      hubzone: true,
      smallBusiness: true,
      notificationPreference: true,
      clientPortalUsers: {
        where: { isActive: true },
        select: { email: true },
        orderBy: { createdAt: 'asc' },
        take: 1,
      },
    },
  })

  const eligible: ClientCtx[] = []
  for (const c of clients) {
    const pref = c.notificationPreference
    if (pref && !pref.enabled) continue // explicit opt-out
    eligible.push({
      id: c.id,
      name: c.name,
      naicsCodes: c.naicsCodes,
      sdvosb: c.sdvosb,
      wosb: c.wosb,
      hubzone: c.hubzone,
      smallBusiness: c.smallBusiness,
      threshold: pref?.minMatchThreshold ?? DEFAULT_THRESHOLD,
      frequency: pref?.frequency ?? NotificationFrequency.IMMEDIATE,
      recipientEmail: c.clientPortalUsers[0]?.email ?? firm.contactEmail ?? null,
    })
  }

  if (eligible.length === 0) {
    await advanceHighWater(consultingFirmId, now)
    return out
  }

  // ── Candidate opportunities since the high-water mark ──
  const opportunities = await prisma.opportunity.findMany({
    where: {
      consultingFirmId,
      status: 'ACTIVE',
      responseDeadline: { gt: now },
      // Award notices are ingested too (the SAM pull has no ptype filter) and
      // resolveResponseDeadline backfills their missing deadline from the
      // future archiveDate — so without this exclusion clients get "new match"
      // emails for contracts that are already awarded. Match alerts are only
      // actionable pre-award; awarded work reaches bidders via the pursuit
      // tracker instead. NULL noticeType must stay eligible — a bare
      // NOT-contains silently drops NULL rows under SQL three-valued logic.
      OR: [
        { noticeType: null },
        { NOT: { noticeType: { contains: 'award', mode: 'insensitive' } } },
      ],
      ...(highWater ? { updatedAt: { gte: highWater } } : {}),
    },
    select: {
      id: true,
      title: true,
      agency: true,
      naicsCode: true,
      estimatedValue: true,
      responseDeadline: true,
      sourceUrl: true,
      incumbentProbability: true,
      competitionCount: true,
      offersReceived: true,
      agencySdvosbRate: true,
      historicalAwardCount: true,
      documentIntelScore: true,
    },
    orderBy: { updatedAt: 'desc' },
    take: MAX_CANDIDATE_OPPS,
  })

  if (opportunities.length === 0) {
    await advanceHighWater(consultingFirmId, now)
    return out
  }

  // ── Already-notified pairs (ledger) for these clients ──
  const clientIds = eligible.map((c) => c.id)
  const existing = await prisma.sentNotification.findMany({
    where: { clientCompanyId: { in: clientIds }, opportunityId: { in: opportunities.map((o) => o.id) } },
    select: { clientCompanyId: true, opportunityId: true },
  })
  const alreadySent = new Set(existing.map((e) => `${e.clientCompanyId}:${e.opportunityId}`))

  // ── Score every (opportunity, client) pair, collect matches per client ──
  const matchesByClient = new Map<string, MatchEmailItem[]>()

  for (const opp of opportunities) {
    const oppPrefix = opp.naicsCode.substring(0, 2)
    const estValue = opp.estimatedValue ? Number(opp.estimatedValue) : null

    for (const client of eligible) {
      if (alreadySent.has(`${client.id}:${opp.id}`)) continue

      // Pre-filter: at least a 2-digit NAICS prefix overlap (mirrors matcher).
      const hasNaicsOverlap = client.naicsCodes.some((code) => code.substring(0, 2) === oppPrefix)
      if (!hasNaicsOverlap) continue

      const scored = scoreOpportunityForClient({
        opportunityNaics: opp.naicsCode,
        opportunityEstimatedValue: estValue,
        opportunityAgency: opp.agency,
        clientNaics: client.naicsCodes,
        clientProfile: {
          sdvosb: client.sdvosb,
          wosb: client.wosb,
          hubzone: client.hubzone,
          smallBusiness: client.smallBusiness,
        },
        incumbentProbability: opp.incumbentProbability,
        competitionCount: opp.competitionCount,
        offersReceived: opp.offersReceived,
        agencySdvosbRate: opp.agencySdvosbRate,
        historicalDistribution: opp.historicalAwardCount
          ? Math.min(opp.historicalAwardCount / 1000, 0.8)
          : 0.3,
        documentAlignmentScore: opp.documentIntelScore,
      })

      // P1-1: never notify a client based on a fabricated score — skip failures.
      if (scored.status !== 'OK') continue

      const matchScore = Math.round(roundTo(scored.probability, 4) * 100)
      if (matchScore < client.threshold) continue

      const item: MatchEmailItem = {
        opportunityId: opp.id,
        title: opp.title,
        agency: opp.agency,
        matchScore,
        estimatedValueDisplay: formatValue(estValue),
        daysToDeadline: Math.max(
          0,
          Math.ceil((new Date(opp.responseDeadline).getTime() - now.getTime()) / (1000 * 60 * 60 * 24)),
        ),
        matchReasons: buildMatchReasons(scored.features),
        url: opp.sourceUrl,
      }
      const list = matchesByClient.get(client.id) ?? []
      list.push(item)
      matchesByClient.set(client.id, list)
    }
  }

  // ── Dispatch per client per preference ──
  const branding = {
    firmDisplayName: firm.brandingDisplayName || firm.name,
    firmTagline: firm.brandingTagline,
    isVeteranOwned: firm.isVeteranOwned,
    accentColor: firm.brandingPrimaryColor,
  }

  for (const client of eligible) {
    const matches = matchesByClient.get(client.id)
    if (!matches || matches.length === 0) continue

    if (!client.recipientEmail) {
      logger.warn('Client match notification skipped — no recipient email', {
        consultingFirmId,
        clientCompanyId: client.id,
      })
      continue
    }

    // Highest-scoring first for readability.
    matches.sort((a, b) => b.matchScore - a.matchScore)

    if (client.frequency === NotificationFrequency.DIGEST) {
      const dispatched = await dispatch(consultingFirmId, client, matches, branding)
      out.notificationsSent += dispatched ? 1 : 0
      out.ledgerRowsWritten += dispatched ? matches.length : 0
    } else {
      // IMMEDIATE: one email per match.
      for (const item of matches) {
        const dispatched = await dispatch(consultingFirmId, client, [item], branding)
        out.notificationsSent += dispatched ? 1 : 0
        out.ledgerRowsWritten += dispatched ? 1 : 0
      }
    }
  }

  await advanceHighWater(consultingFirmId, now)
  return out
}

/**
 * Render + send one email (single match or digest) and, on success or
 * dev-fallback, write the SentNotification ledger row(s) + an audit
 * entry. Returns true when the ledger was written.
 */
async function dispatch(
  consultingFirmId: string,
  client: ClientCtx,
  matches: MatchEmailItem[],
  branding: {
    firmDisplayName: string
    firmTagline: string | null
    isVeteranOwned: boolean
    accentColor: string | null
  },
): Promise<boolean> {
  const appUrl = process.env.APP_URL || 'https://bytescon.com'
  const { subject, html, text } = renderClientMatchEmail({
    ...branding,
    clientId: client.id,
    clientName: client.name,
    matches,
    appUrl,
  })

  const delivery = await sendEmail({
    to: client.recipientEmail as string,
    subject,
    htmlBody: html,
    textBody: text,
    // Transactional path — keeps these client notifications off any
    // marketing/cold-outreach reputation pool (GB-103 §C.3).
    category: 'TRANSACTIONAL',
    consultingFirmId,
  })

  // Hard failure (not dev-fallback) → don't write the ledger so the
  // next run retries. The mailer already wrote an EMAIL_DELIVERY_FAILED
  // audit row in this case.
  if (!delivery.delivered && !delivery.devFallback) {
    logger.warn('Client match notification not delivered — will retry next run', {
      consultingFirmId,
      clientCompanyId: client.id,
      error: delivery.error,
    })
    return false
  }

  // Claim the (client, opportunity) pairs in the idempotency ledger.
  // skipDuplicates makes a concurrent/duplicate run a no-op rather than
  // a constraint error.
  const ledger = await prisma.sentNotification.createMany({
    data: matches.map((m) => ({
      consultingFirmId,
      clientCompanyId: client.id,
      opportunityId: m.opportunityId,
      scoreAtSend: m.matchScore,
    })),
    skipDuplicates: true,
  })

  await logAudit({
    consultingFirmId,
    action: 'CREATE',
    entityType: 'SentNotification',
    rationale:
      matches.length === 1
        ? `Client match notification sent to ${client.name} for opportunity ${matches[0].opportunityId} (score ${matches[0].matchScore}) via EMAIL`
        : `Client match digest sent to ${client.name}: ${matches.length} opportunities via EMAIL`,
    after: {
      clientCompanyId: client.id,
      opportunityIds: matches.map((m) => m.opportunityId),
      scores: matches.map((m) => m.matchScore),
      channel: 'EMAIL',
      ledgerRowsWritten: ledger.count,
    },
  })

  logger.info('Client match notification sent', {
    consultingFirmId,
    clientCompanyId: client.id,
    matches: matches.length,
    devFallback: delivery.devFallback ?? false,
  })
  return true
}

async function advanceHighWater(consultingFirmId: string, now: Date): Promise<void> {
  await prisma.consultingFirm.update({
    where: { id: consultingFirmId },
    data: { lastMatchNotifiedAt: now },
  })
}

function buildMatchReasons(f: {
  naicsOverlapScore: number
  agencyAlignmentScore: number
  incumbentWeaknessScore: number
  documentAlignmentScore: number
  awardSizeFitScore: number
  competitionDensityScore: number
}): string[] {
  const reasons: string[] = []
  if (f.naicsOverlapScore >= 0.8) reasons.push('Strong NAICS alignment')
  else if (f.naicsOverlapScore >= 0.5) reasons.push('Partial NAICS match')
  if (f.agencyAlignmentScore >= 0.8) reasons.push('Favorable agency set-aside profile')
  if (f.incumbentWeaknessScore > 0.7) reasons.push('Weak incumbent — opportunity to compete')
  if (f.documentAlignmentScore > 0.7) reasons.push('Strong SOW alignment')
  if (f.awardSizeFitScore > 0.8) reasons.push('Award size fits client capacity')
  if (f.competitionDensityScore > 0.7) reasons.push('Low competition density')
  return reasons
}

function formatValue(n: number | null): string {
  if (n === null || n === 0) return 'TBD'
  if (n >= 1_000_000_000) return `$${(n / 1_000_000_000).toFixed(1)}B`
  if (n >= 1_000_000) return `$${(n / 1_000_000).toFixed(1)}M`
  if (n >= 1_000) return `$${(n / 1_000).toFixed(0)}K`
  return `$${Math.round(n)}`
}
