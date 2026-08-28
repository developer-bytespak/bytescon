// One-off smoke for the SCW demo seed. Verifies each seeded opportunity
// produces real primes from the corpus + the SCW-5 inbox surfaces them.

process.env.DATABASE_URL =
  process.env.DATABASE_URL ||
  'postgresql://bytescon_user:bytescon_pass@localhost:5432/bytescon_platform'

import { findLikelyPrimes } from '../src/services/scw/likelyPrimes'
import { getNotificationInbox } from '../src/services/scw/notifications'
import { prisma } from '../src/config/database'

const TENANT = '34a4e6db-6422-4cd4-9c99-e9aaa4d3f067'
const IDS = ['scw-demo-va-541512', 'scw-demo-dhs-236220', 'scw-demo-dod-236220']

async function main() {
  console.log('=== SCW-1 per demo opportunity ===')
  for (const id of IDS) {
    const primes = await findLikelyPrimes({ opportunityId: id, consultingFirmId: TENANT })
    const qualifying = primes.filter((p) => p.confidence.composite >= 0.6)
    console.log(`\n${id}: ${primes.length} primes, ${qualifying.length} clear the 0.6 SCW-5 floor`)
    primes.slice(0, 5).forEach((p) =>
      console.log(`   ${p.confidence.composite.toFixed(3)}  ${p.primeName}  (${p.pastAwardsCount} awards, $${(p.totalPastValue / 1_000_000).toFixed(0)}M)`),
    )
  }
  console.log('\n=== SCW-5 notification inbox ===')
  const inbox = await getNotificationInbox({ consultingFirmId: TENANT })
  console.log(`${inbox.length} notifications`)
  inbox.forEach((n) =>
    console.log(`  ${n.daysRemaining}d  topPrimes=${n.topPrimes.length}  ${n.opportunityTitle.slice(0, 60)}`),
  )
}

main()
  .catch((e) => {
    console.error('FAILED:', (e as Error).message)
    console.error((e as Error).stack)
    process.exitCode = 1
  })
  .finally(() => prisma.$disconnect().catch(() => undefined))
