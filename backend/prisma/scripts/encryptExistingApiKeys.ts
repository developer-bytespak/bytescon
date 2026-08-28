// =============================================================
// One-time migration: encrypt existing plaintext tenant API keys at rest.
// Run AFTER setting FIELD_ENCRYPTION_KEY. Idempotent — values already tagged
// "enc:v1:" are skipped, so it is safe to re-run.
//
//   cd backend
//   # PowerShell:  $env:FIELD_ENCRYPTION_KEY="<key>"; npx ts-node prisma/scripts/encryptExistingApiKeys.ts
//   # bash:        FIELD_ENCRYPTION_KEY=<key> npx ts-node prisma/scripts/encryptExistingApiKeys.ts
//
// On the droplet (inside the backend container, which already has the env var):
//   docker exec bytescon_backend npx ts-node prisma/scripts/encryptExistingApiKeys.ts
// =============================================================
import { prisma } from '../../src/config/database'
import { encryptSecret } from '../../src/utils/fieldCrypto'

const COLS = [
  'samApiKey',
  'anthropicApiKey',
  'openaiApiKey',
  'insightEngineApiKey',
  'deepseekApiKey',
] as const

async function main() {
  if (!process.env.FIELD_ENCRYPTION_KEY || process.env.FIELD_ENCRYPTION_KEY.trim() === '') {
    console.error('FIELD_ENCRYPTION_KEY is not set — aborting (would store plaintext, a no-op).')
    process.exit(1)
  }

  const firms = await prisma.consultingFirm.findMany({
    select: {
      id: true,
      samApiKey: true,
      anthropicApiKey: true,
      openaiApiKey: true,
      insightEngineApiKey: true,
      deepseekApiKey: true,
    },
  })

  let firmsUpdated = 0
  let keysEncrypted = 0
  for (const firm of firms) {
    const data: Record<string, string | null> = {}
    for (const col of COLS) {
      const val = (firm as Record<string, unknown>)[col] as string | null
      if (val && !val.startsWith('enc:v1:')) {
        data[col] = encryptSecret(val)
        keysEncrypted++
      }
    }
    if (Object.keys(data).length > 0) {
      await prisma.consultingFirm.update({ where: { id: firm.id }, data })
      firmsUpdated++
    }
  }

  console.log(`Done. Encrypted ${keysEncrypted} key(s) across ${firmsUpdated} firm(s) (of ${firms.length} total).`)
  await prisma.$disconnect()
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
