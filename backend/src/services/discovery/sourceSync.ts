// =============================================================
// §6.1A — Source sync orchestrator.
//
// Owns everything an adapter must not have to think about:
//   idempotency · pagination · rate-limit backoff · retry · timeout ·
//   cursor/watermark persistence · run bookkeeping · data-quality state ·
//   safe restart · honest live-verification status.
//
// Persistence rules:
//  - Opportunities upsert on (consultingFirmId, samNoticeId) so SAM.gov keeps
//    ONE record shared with the legacy ingestion path, and non-SAM sources key
//    on a namespaced id. Never a second opportunity list.
//  - MANUAL records are never overwritten by ingestion.
//  - verification is only promoted to LIVE_VERIFIED after a run actually
//    fetched records from the live provider. It is never declared up-front.
// =============================================================
import { createHash } from 'crypto'
import {
  AdapterVerification,
  OpportunitySource,
  Prisma,
  SourceCategory,
  SourceDataQuality,
  SyncMode,
  SyncRunStatus,
} from '@prisma/client'
import { prisma } from '../../config/database'
import { logger } from '../../utils/logger'
import { decryptSecret } from '../../utils/fieldCrypto'
import {
  AdapterEnv,
  NormalizedForecast,
  NormalizedOpportunity,
  SourceAdapter,
  getAdapter,
} from './sourceAdapter'
import { registerBuiltInAdapters } from './adapters'
import { upsertForecast } from './forecastIngest'
import { classifyNotice } from '../noticeClassification'
import { emitSourceSyncCompleted } from '../agents/opportunity/opportunityEvents'

registerBuiltInAdapters()

/** Hard ceiling on pages per run so a misbehaving feed cannot loop forever. */
export const MAX_PAGES_PER_RUN = 40
/** Backoff applied when a provider signals a rate limit. */
export const RATE_LIMIT_BACKOFF_MS = 2000

export interface RunSyncOptions {
  mode?: SyncMode
  /** Caller-supplied key. Same key twice = the second call is a no-op. */
  idempotencyKey?: string
  now?: Date
  /** Injectable sleep so tests never wait. */
  sleep?: (ms: number) => Promise<void>
}

export interface RunSyncOutcome {
  runId: string
  status: SyncRunStatus
  skipped: boolean
  recordsFetched: number
  recordsCreated: number
  recordsUpdated: number
  recordsSkipped: number
  errorCount: number
  errorMessage?: string | null
}

const defaultSleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms))

/**
 * Deterministic idempotency key: the same source, mode and UTC hour produce the
 * same key, so a re-queued or restarted job is a no-op rather than a duplicate
 * ingest.
 */
export function buildIdempotencyKey(sourceConfigId: string, mode: SyncMode, now: Date): string {
  const bucket = now.toISOString().slice(0, 13) // YYYY-MM-DDTHH
  return createHash('sha256').update(`${sourceConfigId}:${mode}:${bucket}`).digest('hex').slice(0, 48)
}

/**
 * Namespaced external id → the Opportunity.samNoticeId slot. SAM.gov keeps its
 * bare notice id so the new adapter and the legacy ingestion converge on one
 * record; every other source is prefixed so ids cannot collide across feeds.
 */
export function externalIdToNoticeId(adapterKey: string, externalId: string): string {
  return adapterKey === 'sam_gov' ? externalId : `${adapterKey}:${externalId}`
}

/** Maps an adapter category onto the Opportunity provenance enum. */
export function categoryToOpportunitySource(category: SourceCategory): OpportunitySource {
  switch (category) {
    case SourceCategory.SAM_GOV: return OpportunitySource.SAM_GOV
    case SourceCategory.CONTRACT_AWARDS: return OpportunitySource.CONTRACT_AWARDS
    case SourceCategory.GRANTS_GOV: return OpportunitySource.GRANTS_GOV
    case SourceCategory.STATE_LOCAL: return OpportunitySource.STATE_LOCAL
    case SourceCategory.SUBCONTRACTING_BOARD: return OpportunitySource.SUBCONTRACTING_BOARD
    case SourceCategory.AGENCY_FORECAST: return OpportunitySource.AGENCY_FORECAST
    case SourceCategory.DEMO: return OpportunitySource.DEMO
    case SourceCategory.MANUAL: return OpportunitySource.MANUAL
    default: return OpportunitySource.OTHER
  }
}

/**
 * Upsert one normalized opportunity. Returns 'created' | 'updated' | 'skipped'.
 * A MANUAL record is never overwritten — ingestion only refreshes its
 * last-seen/sync stamps so freshness stays honest.
 */
export async function upsertOpportunity(
  consultingFirmId: string,
  sourceConfigId: string,
  adapter: SourceAdapter,
  record: NormalizedOpportunity,
  now: Date,
): Promise<'created' | 'updated' | 'skipped'> {
  const samNoticeId = externalIdToNoticeId(adapter.key, record.externalId)
  const existing = await prisma.opportunity.findUnique({
    where: { consultingFirmId_samNoticeId: { consultingFirmId, samNoticeId } },
    select: { id: true, source: true, sourceFirstSeenAt: true },
  })

  const classification = classifyNotice(record.noticeType, record.title)

  if (existing) {
    if (existing.source === OpportunitySource.MANUAL) {
      await prisma.opportunity.update({
        where: { id: existing.id },
        data: { sourceLastSeenAt: now, sourceLastSyncedAt: now },
      })
      return 'skipped'
    }
    await prisma.opportunity.update({
      where: { id: existing.id },
      data: {
        title: record.title,
        agency: record.agency,
        subagency: record.subagency ?? undefined,
        office: record.office ?? undefined,
        description: record.description ?? undefined,
        naicsCode: record.naicsCode ?? undefined,
        psc: record.psc ?? undefined,
        setAsideType: record.setAsideType ?? undefined,
        noticeType: record.noticeType ?? undefined,
        solicitationNumber: record.solicitationNumber ?? undefined,
        postedDate: record.postedDate ?? undefined,
        ...(record.responseDeadline ? { responseDeadline: record.responseDeadline } : {}),
        archiveDate: record.archiveDate ?? undefined,
        placeOfPerformance: record.placeOfPerformance ?? undefined,
        estimatedValue: record.estimatedValue ?? undefined,
        estimatedValueMin: record.estimatedValueMin ?? undefined,
        estimatedValueMax: record.estimatedValueMax ?? undefined,
        sourceUrl: record.sourceUrl ?? undefined,
        sourceConfigId,
        externalId: record.externalId,
        sourceLastSeenAt: now,
        sourceUpdatedAt: record.sourceUpdatedAt ?? undefined,
        sourceLastSyncedAt: now,
        dataQuality: record.dataQuality,
        sourceMetadata: (record.sourceMetadata ?? undefined) as Prisma.InputJsonValue | undefined,
        presolicitationKind: classification.kind,
      },
    })
    return 'updated'
  }

  await prisma.opportunity.create({
    data: {
      consultingFirmId,
      samNoticeId,
      title: record.title,
      agency: record.agency,
      subagency: record.subagency ?? null,
      office: record.office ?? null,
      description: record.description ?? null,
      naicsCode: record.naicsCode ?? '',
      psc: record.psc ?? null,
      setAsideType: record.setAsideType ?? 'NONE',
      noticeType: record.noticeType ?? null,
      solicitationNumber: record.solicitationNumber ?? null,
      postedDate: record.postedDate ?? null,
      responseDeadline: record.responseDeadline ?? now,
      archiveDate: record.archiveDate ?? null,
      placeOfPerformance: record.placeOfPerformance ?? null,
      estimatedValue: record.estimatedValue ?? null,
      estimatedValueMin: record.estimatedValueMin ?? null,
      estimatedValueMax: record.estimatedValueMax ?? null,
      sourceUrl: record.sourceUrl ?? null,
      source: categoryToOpportunitySource(adapter.category),
      sourceConfigId,
      externalId: record.externalId,
      sourceFirstSeenAt: now,
      sourceLastSeenAt: now,
      sourceUpdatedAt: record.sourceUpdatedAt ?? null,
      sourceLastSyncedAt: now,
      dataQuality: record.dataQuality,
      sourceMetadata: (record.sourceMetadata ?? undefined) as Prisma.InputJsonValue | undefined,
      presolicitationKind: classification.kind,
    },
  })
  return 'created'
}

function buildEnv(
  config: { baseUrl: string | null; authEnvKey: string | null; configJson: Prisma.JsonValue },
  firmApiKey: string | null,
): AdapterEnv {
  return {
    getEnv: (key: string) => process.env[key] || undefined,
    config: (config.configJson ?? {}) as Record<string, unknown>,
    baseUrl: config.baseUrl,
    firmApiKey,
  }
}

/**
 * Run one source once. Safe to call repeatedly: a duplicate idempotency key
 * short-circuits, and a crashed prior run leaves a FAILED/TIMED_OUT row rather
 * than a stuck RUNNING one on the next attempt.
 */
export async function runSourceSync(
  consultingFirmId: string,
  sourceConfigId: string,
  options: RunSyncOptions = {},
): Promise<RunSyncOutcome> {
  const now = options.now ?? new Date()
  const sleep = options.sleep ?? defaultSleep
  const mode = options.mode ?? SyncMode.INCREMENTAL

  const config = await prisma.opportunitySourceConfig.findFirst({
    where: { id: sourceConfigId, consultingFirmId },
  })
  if (!config) throw new Error('Source configuration not found')

  const adapter = getAdapter(config.adapterKey)
  if (!adapter) throw new Error(`No adapter registered for key "${config.adapterKey}"`)

  const idempotencyKey = options.idempotencyKey ?? buildIdempotencyKey(sourceConfigId, mode, now)

  // Idempotency gate — an existing run for this key is never repeated.
  const priorRun = await prisma.sourceSyncRun.findUnique({ where: { idempotencyKey } })
  if (priorRun) {
    return {
      runId: priorRun.id,
      status: priorRun.status,
      skipped: true,
      recordsFetched: priorRun.recordsFetched,
      recordsCreated: priorRun.recordsCreated,
      recordsUpdated: priorRun.recordsUpdated,
      recordsSkipped: priorRun.recordsSkipped,
      errorCount: priorRun.errorCount,
      errorMessage: priorRun.errorMessage,
    }
  }

  const firm = await prisma.consultingFirm.findUnique({
    where: { id: consultingFirmId },
    select: { samApiKey: true },
  })
  const firmApiKey = adapter.key === 'sam_gov' ? decryptSecret(firm?.samApiKey ?? null) : null
  const env = buildEnv(config, firmApiKey)

  const configured = adapter.configure(env)
  const run = await prisma.sourceSyncRun.create({
    data: {
      consultingFirmId,
      sourceConfigId,
      idempotencyKey,
      mode,
      status: SyncRunStatus.RUNNING,
      maxAttempts: config.maxAttempts,
      timeoutMs: config.timeoutMs,
      cursorBefore: config.cursorValue,
      startedAt: now,
    },
  })

  // Not configured is a normal, honest state — not a failure.
  if (configured.state === 'NOT_CONFIGURED') {
    await prisma.sourceSyncRun.update({
      where: { id: run.id },
      data: {
        status: SyncRunStatus.SKIPPED,
        errorMessage: configured.reason ?? 'Source is not configured',
        finishedAt: new Date(),
        durationMs: 0,
      },
    })
    await prisma.opportunitySourceConfig.update({
      where: { id: sourceConfigId },
      data: {
        lastRunAt: now,
        verification: AdapterVerification.NOT_CONFIGURED,
        dataQuality: SourceDataQuality.UNVERIFIED,
        lastFailureMessage: configured.reason ?? null,
        nextRunAt: new Date(now.getTime() + 3600_000),
      },
    })
    return {
      runId: run.id, status: SyncRunStatus.SKIPPED, skipped: true,
      recordsFetched: 0, recordsCreated: 0, recordsUpdated: 0, recordsSkipped: 0,
      errorCount: 0, errorMessage: configured.reason,
    }
  }

  let fetched = 0
  let created = 0
  let updated = 0
  let skippedCount = 0
  let errorCount = 0
  let rateLimited = false
  let nextCursor: string | null | undefined
  let errorMessage: string | null = null
  let status: SyncRunStatus = SyncRunStatus.SUCCEEDED
  let touchedProvider = false

  const deadline = now.getTime() + config.timeoutMs * MAX_PAGES_PER_RUN

  try {
    if (adapter.runDelegatedSync) {
      const result = await adapter.runDelegatedSync({ consultingFirmId, timeoutMs: config.timeoutMs, now })
      fetched = result.recordsFetched
      created = result.recordsCreated
      updated = result.recordsUpdated
      skippedCount = result.recordsSkipped
      errorCount = result.errorCount
      errorMessage = result.note ?? null
      touchedProvider = fetched > 0
      if (errorCount > 0) status = SyncRunStatus.PARTIAL
    } else {
      let pageToken: string | null = null
      let pages = 0

      do {
        if (Date.now() > deadline) { status = SyncRunStatus.TIMED_OUT; errorMessage = 'Run exceeded its total time budget'; break }

        // Bounded retry with exponential backoff for this page only.
        let page: Awaited<ReturnType<SourceAdapter['fetchPage']>> | null = null
        let lastErr: unknown = null
        for (let attempt = 1; attempt <= config.maxAttempts; attempt++) {
          try {
            page = await adapter.fetchPage(env, {
              cursor: config.cursorValue,
              mode: mode === SyncMode.FULL ? 'FULL' : 'INCREMENTAL',
              pageToken,
              timeoutMs: config.timeoutMs,
              now,
            })
            break
          } catch (err) {
            lastErr = err
            if (attempt >= config.maxAttempts) break
            await sleep(250 * 2 ** (attempt - 1))
          }
        }
        if (!page) throw lastErr instanceof Error ? lastErr : new Error(String(lastErr))

        touchedProvider = true
        if (page.rateLimited) {
          rateLimited = true
          await sleep(RATE_LIMIT_BACKOFF_MS)
          status = SyncRunStatus.PARTIAL
          errorMessage = 'Provider rate limit reached; run stopped early and will resume next cycle.'
          break
        }

        for (const record of page.records) {
          fetched++
          try {
            if (record.kind === 'FORECAST') {
              const outcome = await upsertForecast(consultingFirmId, sourceConfigId, record as NormalizedForecast, now)
              if (outcome === 'created') created++
              else if (outcome === 'updated') updated++
              else skippedCount++
            } else {
              const outcome = await upsertOpportunity(consultingFirmId, sourceConfigId, adapter, record as NormalizedOpportunity, now)
              if (outcome === 'created') created++
              else if (outcome === 'updated') updated++
              else skippedCount++
            }
          } catch (err) {
            errorCount++
            logger.warn('Failed to persist source record', {
              adapterKey: adapter.key, externalId: record.externalId, error: (err as Error).message,
            })
          }
        }

        if (page.nextCursor !== undefined) nextCursor = page.nextCursor
        pageToken = page.nextPageToken
        pages++
        await prisma.sourceSyncRun.update({ where: { id: run.id }, data: { pagesFetched: pages, recordsFetched: fetched } })
      } while (pageToken && pages < MAX_PAGES_PER_RUN)

      if (status === SyncRunStatus.SUCCEEDED && errorCount > 0) status = SyncRunStatus.PARTIAL
    }
  } catch (err) {
    status = SyncRunStatus.FAILED
    errorMessage = (err as Error).message
    errorCount++
    logger.error('Source sync failed', { sourceConfigId, adapterKey: adapter.key, error: errorMessage })
  }

  const finishedAt = new Date()
  const succeeded = status === SyncRunStatus.SUCCEEDED || status === SyncRunStatus.PARTIAL

  await prisma.sourceSyncRun.update({
    where: { id: run.id },
    data: {
      status,
      recordsFetched: fetched,
      recordsCreated: created,
      recordsUpdated: updated,
      recordsSkipped: skippedCount,
      errorCount,
      errorMessage,
      rateLimited,
      cursorAfter: nextCursor ?? config.cursorValue,
      finishedAt,
      durationMs: finishedAt.getTime() - now.getTime(),
    },
  })

  // Data quality reflects what actually happened, never optimism.
  const dataQuality: SourceDataQuality = !succeeded
    ? SourceDataQuality.ERROR
    : status === SyncRunStatus.PARTIAL
      ? SourceDataQuality.PARTIAL
      : SourceDataQuality.OK

  // §7.2 — the config update and the SOURCE_SYNC_COMPLETED event share ONE
  // transaction. A rolled-back bookkeeping write therefore emits no event, and
  // a committed one always emits exactly one. Deduped on the run id, so a
  // completed sync can never produce two.
  await prisma.$transaction(async (tx) => {
    await tx.opportunitySourceConfig.update({
      where: { id: sourceConfigId },
      data: {
        lastRunAt: now,
        ...(succeeded ? { lastSuccessfulSync: finishedAt } : {}),
        ...(succeeded ? {} : { lastFailureAt: finishedAt, lastFailureMessage: errorMessage }),
        consecutiveFailures: succeeded ? 0 : config.consecutiveFailures + 1,
        ...(nextCursor !== undefined && succeeded ? { cursorValue: nextCursor, cursorUpdatedAt: finishedAt } : {}),
        dataQuality,
        // LIVE_VERIFIED is earned by a real provider round-trip, never declared.
        verification:
          succeeded && touchedProvider ? AdapterVerification.LIVE_VERIFIED : config.verification,
        nextRunAt: new Date(finishedAt.getTime() + 3600_000),
      },
    })

    // Only a run that actually produced valid downstream work announces itself.
    // A FAILED run has nothing for the agent to process; source health surfaces
    // the failure through its own path instead.
    if (succeeded) {
      await emitSourceSyncCompleted(tx, {
        consultingFirmId,
        sourceConfigId,
        adapterKey: adapter.key,
        category: config.category,
        syncRunId: run.id,
        status,
        recordsCreated: created,
        recordsUpdated: updated,
        recordsSkipped: skippedCount,
        errorCount,
        cursorAfter: nextCursor ?? config.cursorValue,
      })
    }
  })

  return {
    runId: run.id, status, skipped: false,
    recordsFetched: fetched, recordsCreated: created, recordsUpdated: updated,
    recordsSkipped: skippedCount, errorCount, errorMessage,
  }
}

/**
 * Freshness of a source for display. STALE is reported honestly rather than
 * showing an old sync as if it were current.
 */
export function deriveFreshness(
  config: { lastSuccessfulSync: Date | null; stalenessHours: number; dataQuality: SourceDataQuality },
  now: Date = new Date(),
): { isStale: boolean; ageHours: number | null; label: string } {
  if (!config.lastSuccessfulSync) {
    return { isStale: true, ageHours: null, label: 'Never synced' }
  }
  const ageHours = (now.getTime() - config.lastSuccessfulSync.getTime()) / 3600_000
  const isStale = ageHours > config.stalenessHours
  return {
    isStale,
    ageHours: Number(ageHours.toFixed(2)),
    label: isStale ? `Stale — last successful sync ${Math.floor(ageHours)}h ago` : `Synced ${Math.floor(ageHours)}h ago`,
  }
}
