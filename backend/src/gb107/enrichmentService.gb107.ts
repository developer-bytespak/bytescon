// =============================================================
// GB-107 enrichment orchestrator.
//
// Per-opportunity flow: claim → sibling-copy (free) or API fetch
// (budgeted) → sanitize → store (description swapped from URL
// pointer to real text) → clause extraction → compliance matrix →
// audit (SHA-256 of stored text) → re-score enqueue.
//
// Status lifecycle on Opportunity.descriptionEnrichmentStatus:
//   null → QUEUED → IN_PROGRESS → COMPLETED | FAILED | NOT_FOUND
// Rate-limit outcomes restore QUEUED so the row retries next cycle.
// =============================================================
import { createHash } from 'crypto'
import type { PrismaClient, Prisma } from '@prisma/client'
import type { Redis } from 'ioredis'
import type { Logger } from 'winston'
import { logAudit } from '../services/auditService'
import { scoringQueue } from '../workers/scoringWorker'
import { getGb107Config } from './config.gb107'
import { Gb107RateLimiter } from './rateLimiter.gb107'
import { fetchNoticeDescription, fetchNoticeLinks } from './samDescriptionClient.gb107'
import { sanitizeDescriptionHtml, htmlToPlainText } from './sanitizer.gb107'
import { extractRequirements } from './clauseExtractor.gb107'
import { writeRequirementsToMatrix } from './matrixWriter.gb107'
import { GB107_STATUS, type EnrichOutcome } from './types.gb107'

export interface Gb107Deps {
  prisma: PrismaClient
  redis: Redis
  logger: Logger
}

const MIN_USEFUL_TEXT_CHARS = 20

function sha256(text: string): string {
  return createHash('sha256').update(text).digest('hex')
}

async function audit(
  deps: Gb107Deps,
  consultingFirmId: string,
  opportunityId: string,
  outcome: string,
  after: Record<string, unknown>,
): Promise<void> {
  // System action — no user actor. Awaited (unlike request-path audit
  // calls) so the worker's audit trail is ordered and complete before the
  // enrichment outcome is observable; logAudit never throws.
  await logAudit({
    consultingFirmId,
    actorUserId: null,
    action: 'UPDATE',
    entityType: 'OpportunityDescriptionEnrichment',
    entityId: opportunityId,
    rationale: `GB-107 description enrichment: ${outcome}`,
    after,
  })
}

async function markStatus(
  prisma: PrismaClient,
  opportunityId: string,
  status: string,
  extra: Prisma.OpportunityUpdateInput = {},
): Promise<void> {
  await prisma.opportunity.update({
    where: { id: opportunityId },
    data: { descriptionEnrichmentStatus: status, ...extra },
  })
}

function looksLikeUrlPointer(description: string | null): boolean {
  return !!description && /^https?:\/\//i.test(description.trim())
}

/**
 * Enrich one opportunity. Serialized by the worker (concurrency 1),
 * shared daily budget via Redis. Returns the terminal outcome for
 * this attempt; QUEUED means "try again next cycle".
 */
export async function enrichOpportunityDescription(
  deps: Gb107Deps,
  opportunityId: string,
): Promise<EnrichOutcome> {
  const { prisma, logger } = deps
  const cfg = getGb107Config()

  const opp = await prisma.opportunity.findUnique({
    where: { id: opportunityId },
    select: {
      id: true,
      consultingFirmId: true,
      samNoticeId: true,
      title: true,
      description: true,
      descriptionEnrichmentStatus: true,
    },
  })
  if (!opp) return { status: GB107_STATUS.FAILED, message: 'Opportunity not found' }
  if (opp.descriptionEnrichmentStatus === GB107_STATUS.COMPLETED) {
    return { status: GB107_STATUS.COMPLETED, message: 'Already enriched' }
  }
  if (!opp.samNoticeId) {
    await markStatus(prisma, opp.id, GB107_STATUS.FAILED, {
      descriptionEnrichmentError: 'No samNoticeId on record',
      descriptionEnrichmentAttemptedAt: new Date(),
    })
    return { status: GB107_STATUS.FAILED, message: 'No samNoticeId on record' }
  }

  // Claim (optimistic — another worker cycle may hold it). Prisma's `not`
  // filter excludes NULL rows, so never-attempted rows need their own branch.
  const claimed = await prisma.opportunity.updateMany({
    where: {
      id: opp.id,
      OR: [
        { descriptionEnrichmentStatus: null },
        { descriptionEnrichmentStatus: { not: GB107_STATUS.IN_PROGRESS } },
      ],
    },
    data: {
      descriptionEnrichmentStatus: GB107_STATUS.IN_PROGRESS,
      descriptionEnrichmentAttemptedAt: new Date(),
    },
  })
  if (claimed.count === 0) {
    return { status: GB107_STATUS.IN_PROGRESS, message: 'Enrichment already in progress' }
  }

  try {
    // ── Sibling copy: the same public notice may already be enriched on
    // another tenant's row. Notice content is public federal data keyed by
    // samNoticeId, so copying it is not cross-tenant leakage — and it costs
    // zero API budget.
    const sibling = await prisma.opportunity.findFirst({
      where: {
        samNoticeId: opp.samNoticeId,
        descriptionEnrichmentStatus: GB107_STATUS.COMPLETED,
        id: { not: opp.id },
        descriptionHtml: { not: null },
      },
      select: { description: true, descriptionHtml: true, pointOfContact: true, resourceLinks: true },
    })
    if (sibling?.descriptionHtml && sibling.description) {
      return await storeEnrichment(deps, cfg.fetchLinks, {
        opportunityId: opp.id,
        consultingFirmId: opp.consultingFirmId,
        samNoticeId: opp.samNoticeId,
        title: opp.title,
        html: sibling.descriptionHtml,
        text: sibling.description,
        pointOfContact: sibling.pointOfContact,
        resourceLinks: sibling.resourceLinks,
        source: 'sibling-copy',
      })
    }

    // ── API path.
    if (!cfg.samGovApiKey) {
      await markStatus(prisma, opp.id, GB107_STATUS.QUEUED, {
        descriptionEnrichmentError: 'No SAM.gov API key configured (SAM_GOV_API_KEY or SAM_API_KEY)',
      })
      return {
        status: GB107_STATUS.QUEUED,
        message: 'No SAM.gov API key configured (SAM_GOV_API_KEY or SAM_API_KEY) — enrichment skipped',
      }
    }

    const limiter = new Gb107RateLimiter(deps.redis, cfg.ratePerDay, cfg.burstIntervalMs)
    const budget = await limiter.acquire()
    if (!budget.ok) {
      await markStatus(prisma, opp.id, GB107_STATUS.QUEUED, {
        descriptionEnrichmentError: `Rate limited (${budget.reason}) until ${budget.retryAfter.toISOString()}`,
      })
      await audit(deps, opp.consultingFirmId, opp.id, 'RATE_LIMITED', {
        samNoticeId: opp.samNoticeId,
        reason: budget.reason,
        retryAfter: budget.retryAfter.toISOString(),
      })
      return {
        status: GB107_STATUS.RATE_LIMITED,
        message: `Daily SAM.gov budget exhausted — retry after ${budget.retryAfter.toISOString()}`,
      }
    }

    const fetched = await fetchNoticeDescription(opp.samNoticeId, cfg)
    if (!fetched.ok) {
      if (fetched.kind === 'RATE_LIMITED') {
        await limiter.haltForDay()
        await markStatus(prisma, opp.id, GB107_STATUS.QUEUED, {
          descriptionEnrichmentError: fetched.message,
        })
        await audit(deps, opp.consultingFirmId, opp.id, 'RATE_LIMITED', {
          samNoticeId: opp.samNoticeId,
          httpStatus: fetched.status,
          message: fetched.message,
        })
        logger.warn('GB-107: SAM.gov rate limit hit — halting enrichment for the day', {
          opportunityId: opp.id,
          status: fetched.status,
        })
        return { status: GB107_STATUS.RATE_LIMITED, message: fetched.message }
      }

      const terminalStatus =
        fetched.kind === 'NOT_FOUND' ? GB107_STATUS.NOT_FOUND : GB107_STATUS.FAILED
      await markStatus(prisma, opp.id, terminalStatus, {
        descriptionEnrichmentError: fetched.message,
      })
      await audit(deps, opp.consultingFirmId, opp.id, terminalStatus, {
        samNoticeId: opp.samNoticeId,
        httpStatus: fetched.status,
        message: fetched.message,
      })
      return { status: terminalStatus, message: fetched.message }
    }

    const html = sanitizeDescriptionHtml(fetched.html)
    const text = htmlToPlainText(fetched.html)
    if (text.length < MIN_USEFUL_TEXT_CHARS) {
      await markStatus(prisma, opp.id, GB107_STATUS.FAILED, {
        descriptionEnrichmentError: 'Description body contained no usable text',
      })
      await audit(deps, opp.consultingFirmId, opp.id, 'FAILED', {
        samNoticeId: opp.samNoticeId,
        message: 'Description body contained no usable text',
      })
      return { status: GB107_STATUS.FAILED, message: 'Description body contained no usable text' }
    }

    let pointOfContact: unknown = null
    let resourceLinks: unknown = null
    if (cfg.fetchLinks) {
      const linkBudget = await limiter.acquire()
      if (linkBudget.ok) {
        const links = await fetchNoticeLinks(opp.samNoticeId, cfg)
        pointOfContact = links?.pointOfContact ?? null
        resourceLinks = links?.resourceLinks ?? null
      }
    }

    return await storeEnrichment(deps, cfg.fetchLinks, {
      opportunityId: opp.id,
      consultingFirmId: opp.consultingFirmId,
      samNoticeId: opp.samNoticeId,
      title: opp.title,
      html,
      text,
      pointOfContact,
      resourceLinks,
      source: 'api',
    })
  } catch (err) {
    const message = (err as Error).message
    logger.error('GB-107 enrichment failed unexpectedly', { opportunityId: opp.id, error: message })
    await markStatus(prisma, opp.id, GB107_STATUS.FAILED, {
      descriptionEnrichmentError: message.slice(0, 500),
    }).catch(() => undefined)
    await audit(deps, opp.consultingFirmId, opp.id, 'FAILED', {
      samNoticeId: opp.samNoticeId,
      message: message.slice(0, 500),
    })
    return { status: GB107_STATUS.FAILED, message }
  }
}

async function storeEnrichment(
  deps: Gb107Deps,
  fetchLinksEnabled: boolean,
  args: {
    opportunityId: string
    consultingFirmId: string
    samNoticeId: string
    title: string
    html: string
    text: string
    pointOfContact: unknown
    resourceLinks: unknown
    source: 'api' | 'sibling-copy'
  },
): Promise<EnrichOutcome> {
  const { prisma } = deps
  const { requirements, summary } = extractRequirements(`${args.title}\n${args.text}`)

  const { written } = await writeRequirementsToMatrix(prisma, {
    opportunityId: args.opportunityId,
    consultingFirmId: args.consultingFirmId,
    sourceLabel: `GB-107 SAM.gov description (${args.source})`,
    requirements,
  })

  await prisma.opportunity.update({
    where: { id: args.opportunityId },
    data: {
      description: args.text,
      descriptionHtml: args.html,
      descriptionEnrichmentStatus: GB107_STATUS.COMPLETED,
      descriptionEnrichedAt: new Date(),
      descriptionEnrichmentError: null,
      extractedClauses: summary as unknown as Prisma.InputJsonValue,
      ...(args.pointOfContact !== null && {
        pointOfContact: args.pointOfContact as Prisma.InputJsonValue,
      }),
      ...(args.resourceLinks !== null && {
        resourceLinks: args.resourceLinks as Prisma.InputJsonValue,
      }),
      // The description content changed materially — invalidate the score.
      isScored: false,
    },
  })

  await audit(deps, args.consultingFirmId, args.opportunityId, 'COMPLETED', {
    samNoticeId: args.samNoticeId,
    source: args.source,
    textSha256: sha256(args.text),
    textChars: args.text.length,
    htmlChars: args.html.length,
    farClauses: summary.far,
    dfarsClauses: summary.dfars,
    requirementsWritten: written,
    linksFetched: fetchLinksEnabled && args.pointOfContact !== null,
  })

  // Re-score with the enriched content (existing scoring path, unchanged).
  await scoringQueue
    .add('score-opportunity', {
      opportunityId: args.opportunityId,
      consultingFirmId: args.consultingFirmId,
    })
    .catch((err: Error) =>
      deps.logger.warn('GB-107: re-score enqueue failed', {
        opportunityId: args.opportunityId,
        error: err.message,
      }),
    )

  return {
    status: GB107_STATUS.COMPLETED,
    message: `Enriched via ${args.source}: ${args.text.length} chars, ${written} requirements`,
    source: args.source,
    requirementsWritten: written,
  }
}
