/**
 * One-shot backfill: compute FarClauseApplicability rows for every
 * opportunity that doesn't already have any. Idempotent because
 * writeFarApplicabilities deletes existing AI_EXTRACTED + INFERRED
 * rows for an opp before re-inserting.
 *
 * Usage (on droplet):
 *   docker exec bytescon_backend node dist/scripts/backfillFarApplicability.js
 *
 * Or for a dry run that prints what would be written without doing it:
 *   docker exec bytescon_backend node dist/scripts/backfillFarApplicability.js --dry
 *
 * Optional flags:
 *   --firm=<consultingFirmId>   restrict to one firm
 *   --limit=<N>                 process at most N opportunities (smoke test)
 *   --concurrency=<N>           parallel writes (default 5)
 */
import { prisma } from '../config/database'
import { writeFarApplicabilities } from '../services/far/farApplicabilityWriter'

interface Args {
  dry: boolean
  firmId: string | null
  limit: number | null
  concurrency: number
}

function parseArgs(): Args {
  const args: Args = { dry: false, firmId: null, limit: null, concurrency: 5 }
  for (const arg of process.argv.slice(2)) {
    if (arg === '--dry') args.dry = true
    else if (arg.startsWith('--firm=')) args.firmId = arg.slice('--firm='.length)
    else if (arg.startsWith('--limit=')) args.limit = parseInt(arg.slice('--limit='.length), 10)
    else if (arg.startsWith('--concurrency=')) args.concurrency = parseInt(arg.slice('--concurrency='.length), 10)
  }
  return args
}

async function processInBatches<T>(
  items: T[],
  concurrency: number,
  fn: (item: T) => Promise<void>,
): Promise<void> {
  let cursor = 0
  const workers = Array.from({ length: concurrency }, async () => {
    while (true) {
      const i = cursor++
      if (i >= items.length) return
      await fn(items[i])
    }
  })
  await Promise.all(workers)
}

async function main() {
  const args = parseArgs()

  // naicsCode is non-nullable in the schema; just drop opps that have ''.
  const where: any = {
    naicsCode: { not: '' },
  }
  if (args.firmId) where.consultingFirmId = args.firmId

  const opps = await prisma.opportunity.findMany({
    where,
    select: { id: true, consultingFirmId: true, agency: true, naicsCode: true },
    orderBy: { createdAt: 'desc' },
    take: args.limit ?? undefined,
  })

  console.log(`[backfill] candidates: ${opps.length}`)
  if (args.dry) console.log('[backfill] DRY RUN — no rows will be written')
  console.log(`[backfill] concurrency=${args.concurrency} firm=${args.firmId ?? 'ALL'} limit=${args.limit ?? 'none'}`)

  let processed = 0
  let written = 0
  let errors = 0
  const startedAt = Date.now()

  await processInBatches(opps, args.concurrency, async (opp) => {
    try {
      if (!args.dry) {
        const r = await writeFarApplicabilities(opp.id, opp.consultingFirmId)
        written += r.written
      }
      processed++
      if (processed % 200 === 0) {
        const elapsedSec = (Date.now() - startedAt) / 1000
        const rate = processed / elapsedSec
        const etaSec = (opps.length - processed) / rate
        console.log(
          `[backfill] ${processed}/${opps.length} opps · ${written} rows written · ${rate.toFixed(1)} opp/s · ETA ${Math.round(etaSec)}s`,
        )
      }
    } catch (err) {
      errors++
      console.warn(`[backfill] failed for opp ${opp.id} (${opp.naicsCode}/${opp.agency}): ${(err as Error).message}`)
    }
  })

  const elapsedSec = (Date.now() - startedAt) / 1000
  console.log('---')
  console.log(`[backfill] DONE in ${elapsedSec.toFixed(1)}s`)
  console.log(`[backfill] processed=${processed}/${opps.length} written=${written} errors=${errors}`)
  if (args.dry) console.log('[backfill] (dry run — DB not modified)')

  await prisma.$disconnect()
}

main().catch((err) => {
  console.error('[backfill] fatal:', err)
  process.exit(1)
})
