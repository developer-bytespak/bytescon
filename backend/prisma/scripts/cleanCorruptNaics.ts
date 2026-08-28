// =============================================================
// One-time repair: NULL out malformed NAICS / PSC codes in the
// winners_award_stage staging table.
//
// Background: an early version of the USAspending mapper coerced the
// { code, description } object form with String(), persisting the literal
// "[object Object]" as the NAICS for ~19K rows ($777B of obligations).
// Those rows grouped into one giant bucket that topped every NAICS
// aggregation on the Agency page. The mapper now validates code shape at
// ingest (usaspendingPull.ts) and the agency queries carry shape guards,
// but existing rows in any environment need this one-time sweep.
//
// Idempotent — rows already NULL or valid are untouched; safe to re-run.
// Affected (id, naics) pairs are copied to a timestamped side table first
// so the sweep is reversible.
//
//   cd backend
//   npx ts-node prisma/scripts/cleanCorruptNaics.ts
//
// On the droplet (inside the backend container):
//   docker exec bytescon_backend npx ts-node prisma/scripts/cleanCorruptNaics.ts
// =============================================================
import { prisma } from '../../src/config/database'

async function main() {
  const stamp = new Date().toISOString().slice(0, 10).replace(/-/g, '')
  const backupTable = `winners_naics_repair_backup_${stamp}`

  const [{ count: naicsCount }] = await prisma.$queryRawUnsafe<{ count: bigint }[]>(
    `SELECT COUNT(*)::bigint as count FROM winners_award_stage
     WHERE naics IS NOT NULL AND naics !~ '^[0-9]{2,6}$'`,
  )
  const [{ count: pscCount }] = await prisma.$queryRawUnsafe<{ count: bigint }[]>(
    `SELECT COUNT(*)::bigint as count FROM winners_award_stage
     WHERE "pscCode" IS NOT NULL AND "pscCode" !~ '^[A-Za-z0-9]{1,6}$'`,
  )
  console.log(`Malformed naics rows:   ${naicsCount}`)
  console.log(`Malformed pscCode rows: ${pscCount}`)

  if (Number(naicsCount) === 0 && Number(pscCount) === 0) {
    console.log('Nothing to repair — exiting.')
    return
  }

  await prisma.$executeRawUnsafe(
    `CREATE TABLE IF NOT EXISTS ${backupTable} AS
       SELECT id, naics, "pscCode" FROM winners_award_stage
       WHERE (naics IS NOT NULL AND naics !~ '^[0-9]{2,6}$')
          OR ("pscCode" IS NOT NULL AND "pscCode" !~ '^[A-Za-z0-9]{1,6}$')`,
  )
  console.log(`Backed up affected rows to ${backupTable}`)

  const naicsFixed = await prisma.$executeRawUnsafe(
    `UPDATE winners_award_stage SET naics = NULL
     WHERE naics IS NOT NULL AND naics !~ '^[0-9]{2,6}$'`,
  )
  const pscFixed = await prisma.$executeRawUnsafe(
    `UPDATE winners_award_stage SET "pscCode" = NULL
     WHERE "pscCode" IS NOT NULL AND "pscCode" !~ '^[A-Za-z0-9]{1,6}$'`,
  )
  console.log(`Repaired: ${naicsFixed} naics, ${pscFixed} pscCode. Done.`)
}

main()
  .catch((err) => {
    console.error('Repair failed:', err)
    process.exit(1)
  })
  .finally(() => prisma.$disconnect())
