// =============================================================
// Ops trigger: one-off Winners Intel refresh from the host.
//
// Backs the SCW Phase 2C activation. Sets the host-side env vars so the
// app can reach the dockerized Postgres + Redis from outside the
// compose network, then invokes triggerWinnersIntelRefresh().
//
// Run from backend/ via:
//   npx ts-node scripts/triggerWinnersIntelRefresh.ts
//
// Safe to re-run: persistAwards/persistSubawards are idempotent by their
// USAspending IDs. Distillation re-runs against the same refreshBatchId.
// =============================================================

// Host-side env: must be set BEFORE importing anything that reads config.
process.env.DATABASE_URL =
  process.env.DATABASE_URL ||
  'postgresql://bytescon_user:bytescon_pass@localhost:5432/bytescon_platform'
process.env.REDIS_URL = process.env.REDIS_URL || 'redis://localhost:6379'
process.env.ENABLE_WINNERS_INTEL = 'true'

import { triggerWinnersIntelRefresh } from '../src/workers/winnersIntelRefreshWorker'
import { prisma } from '../src/config/database'

async function main() {
  const start = new Date()
  console.log(`[${start.toISOString()}] Starting Winners Intel refresh...`)

  try {
    const result = await triggerWinnersIntelRefresh()
    const end = new Date()
    const elapsedSec = Math.round((end.getTime() - start.getTime()) / 1000)

    console.log(`[${end.toISOString()}] Done in ${elapsedSec}s`)
    console.log(JSON.stringify(result, null, 2))
  } catch (err) {
    console.error('Refresh threw:', (err as Error).message)
    console.error((err as Error).stack)
    process.exitCode = 1
  } finally {
    await prisma.$disconnect().catch(() => undefined)
  }
}

main()
