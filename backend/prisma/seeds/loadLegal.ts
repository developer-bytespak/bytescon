// =============================================================
// Seed loader for the versioned legal documents (Terms of Service).
// Idempotent — re-running
// publishes a new version only if the markdown body changed.
//
// Each version stores the SHA-256 hash of its body. UserAgreement
// rows pin to the contentHash, so a court-grade record exists of
// the exact text the user accepted.
// =============================================================
import * as crypto from 'crypto'
import * as fs from 'fs'
import * as path from 'path'
import { PrismaClient } from '@prisma/client'

const SEED_DIR = path.join(__dirname, 'legal')

function loadAndHash(file: string): { body: string; hash: string } {
  const body = fs.readFileSync(path.join(SEED_DIR, file), 'utf-8')
  const hash = crypto.createHash('sha256').update(body).digest('hex')
  return { body, hash }
}

const TOS_VERSION = '2.0'
const TOS_FILE = 'tos-v2.md'

export async function loadLegalDocs(prisma: PrismaClient): Promise<void> {
  const tos = loadAndHash(TOS_FILE)

  // Make TOS_VERSION the current version. If a row already exists with the
  // same hash, leave it in place; otherwise upsert and roll the current flag.
  // Rolling the version forces every user to re-accept on next login.
  const existingTos = await prisma.termsOfServiceVersion.findUnique({ where: { version: TOS_VERSION } })
  if (!existingTos || existingTos.contentHash !== tos.hash) {
    await prisma.termsOfServiceVersion.updateMany({
      where: { isCurrent: true },
      data: { isCurrent: false },
    })
    await prisma.termsOfServiceVersion.upsert({
      where: { version: TOS_VERSION },
      create: {
        version: TOS_VERSION,
        title: 'Terms of Service',
        body: tos.body,
        contentHash: tos.hash,
        isCurrent: true,
      },
      update: {
        body: tos.body,
        contentHash: tos.hash,
        isCurrent: true,
      },
    })
    console.log(`Seeded ToS v${TOS_VERSION} (current)`)
  } else {
    console.log('ToS already current — no change.')
  }
}
