// =============================================================
// §6.1A — Contract award-history source.
//
// Award history is ALREADY ingested by the working USAspending enrichment
// pathway and hangs off AwardHistory (keyed to an Opportunity), not off
// Opportunity itself. Re-normalizing awards into the Opportunity domain would
// create exactly the duplicate/disconnected list §6 forbids, so this source
// uses the delegated-sync path instead of fetchPage.
//
// Division of responsibility, deliberately non-overlapping with the existing
// enrichment worker:
//   - enrichmentWorker  → FIRST-TIME enrichment (isEnriched=false), owns
//                          scoring and the isEnriched flag. Untouched.
//   - this adapter      → REFRESH of award evidence for opportunities the
//                          enrichment worker never revisits (isEnriched=true),
//                          which §6.2C/§6.2D retention and competitor stats
//                          depend on. Writes AwardHistory only (skipDuplicates)
//                          and never flips isEnriched or triggers re-scoring.
//
// The USAspending API is public, so no credential is introduced.
// =============================================================
import { SourceCategory } from '@prisma/client'
import {
  SourceAdapter,
  AdapterEnv,
  ConfigureResult,
  FetchPageArgs,
  FetchPageResult,
  DelegatedSyncContext,
  DelegatedSyncResult,
} from '../sourceAdapter'
import { prisma } from '../../../config/database'
import { usaSpendingService } from '../../usaSpending'
import { logger } from '../../../utils/logger'

/** Bounded per-run batch so one sync cannot monopolise the provider. */
export const AWARD_REFRESH_BATCH = 20
/** Opportunities whose award evidence is younger than this are left alone. */
export const AWARD_REFRESH_STALENESS_DAYS = 14

export const awardHistoryAdapter: SourceAdapter = {
  key: 'contract_awards',
  displayName: 'Contract Award History (USAspending)',
  category: SourceCategory.CONTRACT_AWARDS,
  produces: 'OPPORTUNITY',
  supportsIncremental: true,
  pageSize: AWARD_REFRESH_BATCH,
  coverageNote:
    'Federal prime contract award history from the public USAspending API. Refreshes historical award evidence on existing opportunities — it does not create opportunity records, and first-time enrichment remains the enrichment worker’s job.',

  configure(): ConfigureResult {
    // Public API, no credential required.
    return { state: 'READY' }
  },

  async fetchPage(_env: AdapterEnv, _args: FetchPageArgs): Promise<FetchPageResult> {
    // Not used — this source implements runDelegatedSync.
    return { records: [], nextPageToken: null }
  },

  async runDelegatedSync(ctx: DelegatedSyncContext): Promise<DelegatedSyncResult> {
    const staleBefore = new Date(ctx.now.getTime() - AWARD_REFRESH_STALENESS_DAYS * 86400000)

    // Already-enriched, non-demo opportunities whose award evidence is stale.
    const targets = await prisma.opportunity.findMany({
      where: {
        consultingFirmId: ctx.consultingFirmId,
        isDemo: false,
        isEnriched: true,
        naicsCode: { not: '' },
        OR: [{ sourceLastSyncedAt: null }, { sourceLastSyncedAt: { lt: staleBefore } }],
      },
      select: { id: true, naicsCode: true, agency: true },
      orderBy: [{ sourceLastSyncedAt: 'asc' }, { createdAt: 'desc' }],
      take: AWARD_REFRESH_BATCH,
    })

    let created = 0
    let updated = 0
    let skipped = 0
    let errorCount = 0

    for (const opp of targets) {
      try {
        const enrichment = await usaSpendingService.enrichOpportunity({
          naicsCode: opp.naicsCode,
          agency: opp.agency,
        })

        if (enrichment.awards.length === 0) {
          skipped++
        } else {
          const result = await prisma.awardHistory.createMany({
            data: enrichment.awards.slice(0, 50).map((award) => ({
              opportunityId: opp.id,
              awardingAgency: opp.agency,
              recipientName: award.recipientName,
              recipientUei: award.recipientUei,
              awardAmount: award.awardAmount,
              awardDate: award.awardDate ? new Date(award.awardDate) : ctx.now,
              baseAndAllOptions: award.baseAndAllOptions,
              naics: opp.naicsCode,
              awardType: award.awardType,
              contractNumber: award.contractNumber,
            })),
            skipDuplicates: true,
          })
          created += result.count
          updated++
        }

        // Freshness stamp only. isEnriched, scoring and probability are the
        // enrichment/scoring workers' responsibility and are not touched here.
        await prisma.opportunity.update({
          where: { id: opp.id },
          data: { sourceLastSyncedAt: ctx.now },
        })
      } catch (err) {
        errorCount++
        logger.warn('Award-history refresh failed for opportunity', {
          opportunityId: opp.id,
          error: (err as Error).message,
        })
      }
    }

    return {
      recordsFetched: targets.length,
      recordsCreated: created,
      recordsUpdated: updated,
      recordsSkipped: skipped,
      errorCount,
      note: `Refreshed award evidence for ${updated} of ${targets.length} enriched opportunity record(s).`,
    }
  },
}
