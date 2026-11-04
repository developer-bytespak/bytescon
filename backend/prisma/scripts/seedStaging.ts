// =============================================================
// Staging seed — the test data the internal team works with.
//
// Catalog and legal documents, then a demo firm, its first staff admin, a demo
// client and sample opportunities. Everything is invented; nothing is copied
// from production. Safe to re-run: it updates rather than duplicates, and it
// doesn't reset the admin's password once the account exists.
//
// It refuses to run unless APP_ENV=staging, so it can't touch production.
//
// Run (Render shell on bytescon-api-staging):
//   npm run db:seed-staging
// =============================================================
import { PrismaClient } from '@prisma/client'
import { loadFarCatalog } from '../seeds/loadFarCatalog'
import { loadLegalDocs } from '../seeds/loadLegal'
import { seedNaicsCodes } from '../seedNaics'
import { readStagingSeedSettings, seedStagingData } from '../../src/services/stagingSeed'

async function main() {
  readStagingSeedSettings()
  const prisma = new PrismaClient()
  try {
    await seedNaicsCodes(prisma)
    await loadFarCatalog(prisma)
    await loadLegalDocs(prisma)
    await seedStagingData(prisma)
    console.log('Staging seed complete.')
  } finally {
    await prisma.$disconnect()
  }
}

if (require.main === module) {
  main().catch((err) => {
    console.error('Staging seed FAILED:', (err as Error).message)
    process.exit(1)
  })
}
