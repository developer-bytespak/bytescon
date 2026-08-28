// =============================================================
// One-time cutover: six-tier catalog → single $99 base plan + add-ons.
//
//   npx ts-node src/scripts/migrateToSinglePlan.ts --owner-email <email>            (dry run)
//   npx ts-node src/scripts/migrateToSinglePlan.ts --owner-email <email> --execute  (apply)
//
// What it does, in order:
//   1. Locates the owner/demo account by user email or name fragment and
//      ABORTS unless exactly one firm matches. That firm gets isOwnerComp=true
//      and is otherwise left completely untouched.
//   2. Seeds the new plan catalog + deactivates legacy plan rows
//      (getOrSeedPlans does both).
//   3. Every other firm with a Subscription on a legacy plan is re-pointed at
//      the base plan, preserving status / trial dates / billing cycle.
//   4. Legacy purchasedAddons slugs are rewritten to their new module slugs.
//   5. Firms holding a live stripeSubscriptionId on a legacy tier are LISTED
//      for manual review in the Stripe dashboard — never auto-canceled.
//
// Default is dry-run: prints every action it WOULD take and writes nothing.
// =============================================================
import { prisma } from '../config/database'
import { getOrSeedPlans, LEGACY_PLAN_SLUGS } from '../services/billingService'
import { ADDON_ALIASES, resolveAddonSlug, BASE_PLAN_SLUG } from '../config/addons'

interface Args {
  ownerIdentifier: string
  execute: boolean
}

function parseArgs(): Args {
  const argv = process.argv.slice(2)
  const ownerIdx = argv.indexOf('--owner-email')
  const ownerIdentifier = ownerIdx >= 0 ? argv[ownerIdx + 1] : ''
  if (!ownerIdentifier) {
    console.error('Usage: migrateToSinglePlan.ts --owner-email <email-or-name-fragment> [--execute]')
    process.exit(1)
  }
  return { ownerIdentifier, execute: argv.includes('--execute') }
}

async function main() {
  const { ownerIdentifier, execute } = parseArgs()
  const mode = execute ? 'EXECUTE' : 'DRY RUN'
  console.log(`\n=== Single-plan cutover — ${mode} ===\n`)

  // ── 1. Owner account ───────────────────────────────────────
  const ownerUsers = await prisma.user.findMany({
    where: {
      OR: [
        { email: { contains: ownerIdentifier, mode: 'insensitive' } },
        { firstName: { contains: ownerIdentifier, mode: 'insensitive' } },
        { lastName: { contains: ownerIdentifier, mode: 'insensitive' } },
      ],
    },
    select: { id: true, email: true, consultingFirmId: true, role: true },
  })
  const ownerFirmIds = Array.from(new Set(ownerUsers.map((u) => u.consultingFirmId)))
  if (ownerFirmIds.length !== 1) {
    console.error(`ABORT: owner identifier "${ownerIdentifier}" matched ${ownerFirmIds.length} firms (need exactly 1).`)
    for (const u of ownerUsers) console.error(`  candidate: ${u.email} (firm ${u.consultingFirmId}, ${u.role})`)
    process.exit(2)
  }
  const ownerFirmId = ownerFirmIds[0]
  const ownerFirm = await prisma.consultingFirm.findUnique({
    where: { id: ownerFirmId },
    select: { id: true, name: true, isOwnerComp: true, subscription: { include: { plan: true } } },
  })
  console.log(`Owner firm: "${ownerFirm?.name}" (${ownerFirmId})`)
  console.log(`  matched users: ${ownerUsers.map((u) => u.email).join(', ')}`)
  console.log(`  current plan: ${ownerFirm?.subscription?.plan.slug ?? 'none'} — will be left untouched`)
  console.log(`  isOwnerComp: ${ownerFirm?.isOwnerComp} → true\n`)
  if (execute && !ownerFirm?.isOwnerComp) {
    await prisma.consultingFirm.update({ where: { id: ownerFirmId }, data: { isOwnerComp: true } })
  }

  // ── 2. Plan catalog ────────────────────────────────────────
  if (execute) {
    await getOrSeedPlans()
    console.log('Plan catalog seeded (base / all_access / beta_lifetime); legacy rows deactivated.\n')
  } else {
    console.log(`Would seed new plan catalog and deactivate legacy plans: ${LEGACY_PLAN_SLUGS.join(', ')}\n`)
  }

  const basePlan = execute
    ? await prisma.subscriptionPlan.findUnique({ where: { slug: BASE_PLAN_SLUG } })
    : null
  if (execute && !basePlan) throw new Error('base plan row missing after seed — aborting')

  // ── 3. Re-point legacy subscriptions ───────────────────────
  const legacySubs = await prisma.subscription.findMany({
    where: {
      plan: { slug: { in: LEGACY_PLAN_SLUGS } },
      consultingFirmId: { not: ownerFirmId },
    },
    include: {
      plan: { select: { slug: true } },
      consultingFirm: { select: { id: true, name: true, stripeSubscriptionId: true } },
    },
  })
  console.log(`Legacy-plan subscriptions to migrate: ${legacySubs.length}`)
  const stripeReview: string[] = []
  for (const sub of legacySubs) {
    const firm = sub.consultingFirm
    const note = firm.stripeSubscriptionId ? '  ⚠ LIVE STRIPE SUB — manual review' : ''
    console.log(`  ${firm.name} (${firm.id}): ${sub.plan.slug} → ${BASE_PLAN_SLUG} [status ${sub.status} preserved]${note}`)
    if (firm.stripeSubscriptionId) {
      stripeReview.push(`${firm.name} (${firm.id}): stripeSubscriptionId=${firm.stripeSubscriptionId} was on ${sub.plan.slug}`)
    }
    if (execute && basePlan) {
      await prisma.subscription.update({
        where: { id: sub.id },
        data: { planId: basePlan.id },
      })
    }
  }

  // ── 4. Alias legacy add-on slugs ───────────────────────────
  const legacySlugs = Object.keys(ADDON_ALIASES)
  const firmsWithLegacyAddons = await prisma.consultingFirm.findMany({
    where: { purchasedAddons: { hasSome: legacySlugs }, id: { not: ownerFirmId } },
    select: { id: true, name: true, purchasedAddons: true },
  })
  console.log(`\nFirms with legacy add-on slugs: ${firmsWithLegacyAddons.length}`)
  for (const firm of firmsWithLegacyAddons) {
    const rewritten = Array.from(new Set(firm.purchasedAddons.map(resolveAddonSlug)))
    console.log(`  ${firm.name}: [${firm.purchasedAddons.join(', ')}] → [${rewritten.join(', ')}]`)
    if (execute) {
      await prisma.consultingFirm.update({
        where: { id: firm.id },
        data: { purchasedAddons: rewritten },
      })
    }
  }

  // ── 5. Stripe manual-review list ───────────────────────────
  if (stripeReview.length > 0) {
    console.log('\n⚠ MANUAL REVIEW — live Stripe subscriptions on retired tiers (cancel/replace in the Stripe dashboard):')
    for (const line of stripeReview) console.log(`  ${line}`)
  } else {
    console.log('\nNo live Stripe subscriptions on legacy tiers — nothing to review in Stripe.')
  }

  console.log(`\n=== ${mode} complete ===`)
  if (!execute) console.log('Re-run with --execute to apply.\n')
}

main()
  .catch((err) => {
    console.error('Migration failed:', err)
    process.exit(1)
  })
  .finally(() => prisma.$disconnect())
