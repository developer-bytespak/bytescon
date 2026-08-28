// =============================================================
// Market Watchlist Digest Worker
// BullMQ cron: runs Monday 13:00 UTC (~9 AM Eastern, start of work week)
// For each firm with watchlist entries, sends a single digest email
// summarizing recent BigQuery activity for the watched NAICS / agencies.
// =============================================================
import { Worker, Queue, Job } from 'bullmq'
import { redis } from '../config/redis'
import { prisma } from '../config/database'
import { logger } from '../utils/logger'
import { sendEmail } from '../services/mailer'
import { getCompetitionProfile, getAgencyProfile } from '../services/bigquery/analyticsService'
import { renderWatchlistDigestEmail, DigestRow } from '../services/watchlistDigestEmail'

export const WATCHLIST_DIGEST_QUEUE_NAME = 'watchlist-digest'

export const watchlistDigestQueue = new Queue(WATCHLIST_DIGEST_QUEUE_NAME, {
  connection: redis,
  defaultJobOptions: {
    attempts: 2,
    backoff: { type: 'fixed', delay: 30000 },
    removeOnComplete: 10,
    removeOnFail: 10,
  },
})

async function buildDigestForFirm(consultingFirmId: string): Promise<DigestRow[]> {
  const entries = await prisma.marketWatchlistEntry.findMany({
    where: { consultingFirmId },
  })
  const rows: DigestRow[] = []
  for (const e of entries) {
    if (e.naicsCode) {
      const profile = await getCompetitionProfile(e.naicsCode).catch(() => null)
      if (profile) {
        const top = profile.topWinners?.[0]
        rows.push({
          kind: 'NAICS',
          label: e.naicsCode,
          title: `NAICS ${e.naicsCode}`,
          stat1Label: 'Total Awards',
          stat1Value: profile.totalAwards.toLocaleString(),
          stat2Label: 'Avg Award',
          stat2Value: formatBigDollars(profile.avgAwardAmount),
          callout: top ? `Top winner: ${top.name} · ${(top.shareOfWins * 100).toFixed(1)}% share of ${profile.totalAwards} contracts` : undefined,
        })
      }
    } else if (e.agency) {
      const profile = await getAgencyProfile(e.agency).catch(() => null)
      if (profile) {
        const topNaics = profile.topNaicsCodes?.[0]
        rows.push({
          kind: 'AGENCY',
          label: e.agency,
          title: e.agency,
          stat1Label: 'Awards',
          stat1Value: profile.totalAwards.toLocaleString(),
          stat2Label: 'Avg Award',
          stat2Value: formatBigDollars(profile.avgAwardAmount),
          callout: topNaics ? `Top NAICS: ${topNaics.naics} (${topNaics.count} awards) · Competitiveness: ${profile.competitiveness}` : `Competitiveness: ${profile.competitiveness}`,
        })
      }
    }
  }
  return rows
}

function formatBigDollars(n: number): string {
  if (n >= 1e9) return `$${(n / 1e9).toFixed(1)}B`
  if (n >= 1e6) return `$${(n / 1e6).toFixed(1)}M`
  if (n >= 1e3) return `$${(n / 1e3).toFixed(0)}K`
  return `$${Math.round(n)}`
}

async function sendDigestEmail(opts: { to: string; firmId: string; firmName: string; subject: string; html: string; text: string }) {
  const result = await sendEmail({
    to: opts.to,
    subject: opts.subject,
    htmlBody: opts.html,
    textBody: opts.text,
    category: 'TRANSACTIONAL',
    consultingFirmId: opts.firmId,
  })
  if (result.delivered) {
    logger.info('Digest email sent', { to: opts.to, subject: opts.subject, messageId: result.providerMessageId })
  } else if (result.devFallback) {
    logger.warn('Mailer not configured — digest email logged instead', {
      to: opts.to, subject: opts.subject, firmName: opts.firmName,
    })
  } else {
    logger.error('Watchlist digest email failed', {
      to: opts.to, firmId: opts.firmId, error: result.error,
    })
  }
}

async function runWatchlistDigest(): Promise<void> {
  const startTime = Date.now()
  logger.info('Watchlist digest worker started')

  const firms = await prisma.consultingFirm.findMany({
    where: { isActive: true },
    select: { id: true, name: true, contactEmail: true },
  })

  let firmsWithEntries = 0
  let totalDigestRows = 0

  // Compute "Monday of this week" so the email header shows the right date
  const now = new Date()
  const day = now.getUTCDay() // 0 = Sun, 1 = Mon
  const diff = day === 0 ? -6 : 1 - day
  const weekStart = new Date(Date.UTC(
    now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + diff,
  ))

  const appUrl = process.env.APP_URL || 'https://bytescon.com'

  for (const firm of firms) {
    try {
      const rows = await buildDigestForFirm(firm.id)
      if (rows.length === 0) continue
      firmsWithEntries++
      totalDigestRows += rows.length

      // Render the branded digest email
      const { subject, html, text } = await renderWatchlistDigestEmail({
        firmId: firm.id,
        rows,
        weekStart,
        appUrl,
      })

      // Send (or log if mailer not configured)
      if (firm.contactEmail) {
        await sendDigestEmail({
          to: firm.contactEmail,
          firmId: firm.id,
          firmName: firm.name,
          subject,
          html,
          text,
        })
      } else {
        logger.warn('Watchlist digest skipped — firm has no contactEmail', {
          firmId: firm.id, firmName: firm.name,
        })
      }

      // Mark entries as digested-now so we don't double-send
      await prisma.marketWatchlistEntry.updateMany({
        where: { consultingFirmId: firm.id },
        data: { lastDigestAt: new Date() },
      })

      logger.info('Watchlist digest delivered', {
        firmId: firm.id,
        firmName: firm.name,
        entries: rows.length,
      })
    } catch (err) {
      logger.error('Watchlist digest failed for firm (continuing)', {
        firmId: firm.id,
        error: (err as Error).message,
      })
    }
  }

  logger.info('Watchlist digest run complete', {
    firmsScanned: firms.length,
    firmsWithEntries,
    totalDigestRows,
    durationMs: Date.now() - startTime,
  })
}

export function startWatchlistDigestWorker(): Worker {
  const worker = new Worker(
    WATCHLIST_DIGEST_QUEUE_NAME,
    async (_job: Job) => runWatchlistDigest(),
    { connection: redis, concurrency: 1 },
  )

  // Monday at 13:00 UTC (~9 AM Eastern, ~6 AM Pacific)
  watchlistDigestQueue
    .add('weekly-watchlist-digest', {}, {
      repeat: { pattern: '0 13 * * 1' },
      removeOnComplete: 10,
    })
    .catch(() => { /* repeat job already exists */ })

  worker.on('completed', (job) => {
    logger.info('Watchlist digest job completed', { jobId: job.id })
  })
  worker.on('failed', (job, err) => {
    logger.error('Watchlist digest job failed', { jobId: job?.id, error: err.message })
  })
  worker.on('error', (err) => {
    logger.error('Watchlist digest worker error', { error: err.message })
  })

  logger.info('Watchlist digest worker started — schedule: Monday 13:00 UTC')
  return worker
}
