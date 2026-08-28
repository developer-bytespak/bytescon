// =============================================================
// Backfill: clear the synthesized "000000" NAICS placeholder.
//
// services/samApi.ts used to write the literal string "000000" whenever
// SAM.gov omitted a notice's NAICS code (it now writes "", the column
// default). Rows created before that fix still carry the placeholder, where
// it is indistinguishable from a real code: it satisfies the MCP's ^\d{6}$
// NAICS filter, counts as its own sector in analytics groupBys, and makes
// "no code published" look like present data.
//
// This sets those rows to "" so absence is representable. It does NOT touch
// rows with a genuine NAICS code, and it is idempotent — re-running finds
// nothing to do.
//
// Scoring impact: none. computeNaicsOverlap already returns 0 for both
// "000000" and "" (neither matches a client code), so the win probability of
// every affected row is unchanged by this backfill alone. What changes is
// that PROBABILITY_RENORMALIZE_ABSENT can now tell the two apart and drop
// the NAICS factor's weight instead of scoring it as a real mismatch.
//
// Run INSIDE the container (DATABASE_URL already resolves there):
//   docker exec bytescon_backend npx ts-node prisma/scripts/backfillPlaceholderNaics.ts
//
// Run from the Windows host — backend/.env points DATABASE_URL at the compose
// hostname `postgres`, which does not resolve off-container, so override it:
//   cd backend && DATABASE_URL="postgresql://bytescon_user:bytescon_pass@localhost:5432/bytescon_platform" \
//     npx ts-node prisma/scripts/backfillPlaceholderNaics.ts
//
// Pass --dry-run to report counts without writing.
// =============================================================

import { PrismaClient } from '@prisma/client'

const prisma = new PrismaClient()
const DRY_RUN = process.argv.includes('--dry-run')

/** Any all-zeros NAICS is a placeholder, whatever its length. */
const PLACEHOLDER_PATTERN = '^0+$'

async function main(): Promise<void> {
  const [total, placeholders] = await Promise.all([
    prisma.opportunity.count(),
    prisma.opportunity.count({ where: { naicsCode: { in: ['000000', '00000', '0000', '000', '00', '0'] } } }),
  ])

  // Catch any all-zeros width the enum above missed (e.g. zero-padded oddities).
  const regexMatches = await prisma.$queryRawUnsafe<{ count: bigint }[]>(
    `SELECT count(*)::bigint AS count FROM opportunities WHERE "naicsCode" ~ '${PLACEHOLDER_PATTERN}'`
  )
  const byRegex = Number(regexMatches[0]?.count ?? 0)

  console.log(`opportunities total:            ${total}`)
  console.log(`all-zeros NAICS (exact list):   ${placeholders}`)
  console.log(`all-zeros NAICS (regex sweep):  ${byRegex}`)

  if (byRegex === 0) {
    console.log('Nothing to backfill — no placeholder NAICS rows remain.')
    return
  }

  if (DRY_RUN) {
    console.log(`--dry-run: would clear ${byRegex} row(s) to "".`)
    return
  }

  const updated = await prisma.$executeRawUnsafe(
    `UPDATE opportunities SET "naicsCode" = '' WHERE "naicsCode" ~ '${PLACEHOLDER_PATTERN}'`
  )
  console.log(`Cleared ${updated} placeholder NAICS value(s) to "".`)

  const remaining = await prisma.$queryRawUnsafe<{ count: bigint }[]>(
    `SELECT count(*)::bigint AS count FROM opportunities WHERE "naicsCode" ~ '${PLACEHOLDER_PATTERN}'`
  )
  console.log(`Remaining placeholder rows: ${Number(remaining[0]?.count ?? 0)} (expected 0)`)
}

main()
  .catch((err) => {
    console.error('backfillPlaceholderNaics failed:', err)
    process.exitCode = 1
  })
  .finally(() => prisma.$disconnect())
