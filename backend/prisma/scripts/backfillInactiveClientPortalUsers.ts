// =============================================================
// Backfill: deactivate portal users belonging to already-soft-deleted clients.
//
// DELETE /api/clients/:id only started cascading to ClientPortalUser in the
// 2026-07-30 portal-access fix. Every client soft-deleted BEFORE that deploy
// still has isActive=true portal users, so without this backfill those contacts
// stay "active" in the database even though their client is gone.
//
// The per-request check in services/portalAccountAccess.ts already refuses them
// (it tests the company flag too), so this is defense-in-depth and data hygiene
// rather than the primary control — but it matters for anything that reasons off
// ClientPortalUser.isActive alone, including admin lists and the reset-password
// flow, and it makes the DB state honest.
//
// Idempotent: re-running finds nothing to do. Read-only until you drop
// --dry-run.
//
// Run INSIDE the container:
//   docker exec bytescon_backend npx ts-node prisma/scripts/backfillInactiveClientPortalUsers.ts --dry-run
//   docker exec bytescon_backend npx ts-node prisma/scripts/backfillInactiveClientPortalUsers.ts
//
// From the Windows host, override DATABASE_URL (backend/.env points at the
// compose hostname `postgres`, which does not resolve off-container):
//   cd backend && DATABASE_URL="postgresql://bytescon_user:bytescon_pass@localhost:5432/bytescon_platform" \
//     npx ts-node prisma/scripts/backfillInactiveClientPortalUsers.ts --dry-run
// =============================================================

import { PrismaClient } from '@prisma/client'

const prisma = new PrismaClient()
const DRY_RUN = process.argv.includes('--dry-run')

async function main(): Promise<void> {
  const inactiveClients = await prisma.clientCompany.findMany({
    where: { isActive: false },
    select: { id: true, name: true },
  })

  if (inactiveClients.length === 0) {
    console.log('No inactive client companies — nothing to backfill.')
    return
  }

  const affected = await prisma.clientPortalUser.findMany({
    where: { isActive: true, clientCompanyId: { in: inactiveClients.map((c) => c.id) } },
    select: { id: true, email: true, clientCompanyId: true },
  })

  console.log(`inactive client companies:                 ${inactiveClients.length}`)
  console.log(`active portal users under them (to fix):   ${affected.length}`)

  if (affected.length === 0) {
    console.log('Nothing to backfill — no active portal users under inactive clients.')
    return
  }

  const byClient = new Map(inactiveClients.map((c) => [c.id, c.name]))
  for (const u of affected) {
    console.log(`  ${u.email}  (client: ${byClient.get(u.clientCompanyId) ?? u.clientCompanyId})`)
  }

  if (DRY_RUN) {
    console.log(`--dry-run: would deactivate ${affected.length} portal user(s).`)
    return
  }

  const result = await prisma.clientPortalUser.updateMany({
    where: { isActive: true, clientCompanyId: { in: inactiveClients.map((c) => c.id) } },
    data: { isActive: false },
  })
  console.log(`Deactivated ${result.count} portal user(s).`)

  const remaining = await prisma.clientPortalUser.count({
    where: { isActive: true, clientCompanyId: { in: inactiveClients.map((c) => c.id) } },
  })
  console.log(`Remaining active under inactive clients: ${remaining} (expected 0)`)
}

main()
  .catch((err) => {
    console.error('backfillInactiveClientPortalUsers failed:', err)
    process.exitCode = 1
  })
  .finally(() => prisma.$disconnect())
