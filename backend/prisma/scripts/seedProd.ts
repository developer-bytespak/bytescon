// =============================================================
// Production seed — catalog + legal only.
//
// Loads the FAR / DFARS / NIST / CMMC / Section 508 regulatory
// ontology and the current ToS version. Does NOT create
// the demo firm/user/opportunity that prisma/seed.ts creates for
// local dev.
//
// Idempotent — safe to re-run on every deploy.
//
// Run:
//   docker exec bytescon_backend npm run db:seed-prod
// =============================================================
import { PrismaClient } from '@prisma/client'
import { loadFarCatalog } from '../seeds/loadFarCatalog'
import { loadLegalDocs } from '../seeds/loadLegal'
import { seedNaicsCodes } from '../seedNaics'

const prisma = new PrismaClient()

async function main() {
  console.log('Seeding (production: catalog + legal only)...')
  await seedNaicsCodes(prisma)
  await loadFarCatalog(prisma)
  await loadLegalDocs(prisma)
  console.log('Production seed complete.')
}

main()
  .catch((err) => {
    console.error('Production seed FAILED:', err)
    process.exit(1)
  })
  .finally(() => prisma.$disconnect())
