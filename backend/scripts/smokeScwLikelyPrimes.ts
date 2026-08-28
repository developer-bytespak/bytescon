// Smoke test: SCW-1 likelyPrimes against the Syracuse GSA opportunity
// (id 7e812d81-... in Bytescon Consulting tenant 34a4e6db-...).
// Reads only; safe to re-run.

process.env.DATABASE_URL =
  process.env.DATABASE_URL ||
  'postgresql://bytescon_user:bytescon_pass@localhost:5432/bytescon_platform'

import { findLikelyPrimes } from '../src/services/scw/likelyPrimes'
import { prisma } from '../src/config/database'

async function main() {
  const result = await findLikelyPrimes({
    opportunityId: '7e812d81-4177-4026-8bb5-61110ba0a68a',
    consultingFirmId: '34a4e6db-6422-4cd4-9c99-e9aaa4d3f067',
  })
  console.log(`Returned ${result.length} primes:\n`)
  for (const p of result) {
    console.log(`  ${p.confidence.composite.toFixed(3)}  ${p.primeName}`)
    console.log(`     awards=${p.pastAwardsCount}  $=${p.totalPastValue.toLocaleString()}  uei=${p.primeUei || 'n/a'}`)
    console.log(`     contact: ${p.contact.source}  sdvosb=${p.sdvosbCertified}`)
    console.log(`     reasons: ${p.confidence.topReasons.slice(0, 2).join(' | ')}`)
    if (p.dataQuality.warnings.length) {
      console.log(`     warnings: ${p.dataQuality.warnings.join(' | ')}`)
    }
    console.log()
  }
}

main()
  .catch((e) => { console.error('FAILED:', (e as Error).message); console.error((e as Error).stack); process.exitCode = 1 })
  .finally(() => prisma.$disconnect().catch(() => undefined))
