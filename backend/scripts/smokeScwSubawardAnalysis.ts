process.env.DATABASE_URL =
  process.env.DATABASE_URL ||
  'postgresql://bytescon_user:bytescon_pass@localhost:5432/bytescon_platform'

import { analyzeSubawards } from '../src/services/scw/subawardAnalysis'
import { prisma } from '../src/config/database'

async function main() {
  const r = await analyzeSubawards({ primeName: 'LOCKHEED MARTIN CORPORATION' })
  console.log(JSON.stringify(r, null, 2))
}

main()
  .catch((e) => { console.error('FAILED:', (e as Error).message); process.exitCode = 1 })
  .finally(() => prisma.$disconnect().catch(() => undefined))
