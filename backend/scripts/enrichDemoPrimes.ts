// One-off SAM Entity backfill for the top demo primes so spec §7's
// "at least 1 prime with contact data on file" criterion is met before
// VETS26. Uses the canonical recipientProfileService — no direct SAM API
// calls here; the service handles caching, staleness, and provider
// abstraction.
//
// Run:
//   cd backend
//   npx ts-node scripts/enrichDemoPrimes.ts

process.env.DATABASE_URL =
  process.env.DATABASE_URL ||
  'postgresql://bytescon_user:bytescon_pass@localhost:5432/bytescon_platform'

import {
  getOrFetchProfile,
  enrichContacts,
} from '../src/services/recipientProfileService'
import { prisma } from '../src/config/database'

const DEMO_UEIS: Array<{ uei: string; nameHint: string }> = [
  { uei: 'XAVBDA4D13N7', nameHint: 'FISHER SAND & GRAVEL CO' },
  { uei: 'DT2KS3HH5FP5', nameHint: 'ORACLE HEALTH GOVERNMENT SERVICES, INC.' },
]

async function main() {
  if (!process.env.SAM_API_KEY) {
    console.error('SAM_API_KEY not in env — getOrFetchProfile will throw on uncached fetches.')
    process.exitCode = 1
    return
  }

  for (const { uei, nameHint } of DEMO_UEIS) {
    console.log(`\n--- ${nameHint} (${uei}) ---`)
    try {
      const profile = await getOrFetchProfile(uei, { forceRefresh: false })
      console.log(`  legalName: ${profile.legalName}`)
      console.log(`  cage: ${profile.cageCode ?? '-'}  samStatus: ${profile.samRegStatus ?? '-'}`)
      console.log(`  sdvosb=${profile.sdvosb} wosb=${profile.wosb} hub=${profile.hubzone} sb=${profile.smallBusiness}`)
      console.log(`  phone: ${profile.phone ?? '-'}  website: ${profile.website ?? '-'}`)
      console.log(`  city: ${profile.city ?? '-'}, ${profile.state ?? '-'}`)
      console.log(`  samFetchedAt: ${profile.samFetchedAt?.toISOString() ?? '-'}`)

      // Second pass — run the sam_poc contact provider so contactsJson gets
      // populated with whatever POC rows SAM exposes for this UEI. Without
      // this, SCW-1's buildContact falls through to manual_research_required
      // even when the entity profile is on file.
      const enriched = await enrichContacts(uei, 'sam_poc')
      console.log(`  contacts via ${enriched.provider}: ${enriched.contacts.length} row(s)`)
      for (const c of enriched.contacts) {
        console.log(`    · ${c.name ?? '(no name)'} — ${c.email ?? '(no email)'} — ${c.phone ?? '(no phone)'} [${c.role ?? '?'}]`)
      }
    } catch (err) {
      console.error(`  FAILED: ${(err as Error).message}`)
    }
  }
}

main()
  .catch((e) => {
    console.error('FAILED:', (e as Error).message)
    process.exitCode = 1
  })
  .finally(() => prisma.$disconnect().catch(() => undefined))
