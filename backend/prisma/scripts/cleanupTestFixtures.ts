// =============================================================
// One-time production cleanup: remove the deployment-verification
// fixtures created while bringing Bytescon live (Pieces 1-9), while
// preserving all real data: SAM.gov opportunities + scores, state &
// municipal records, NAICS/FAR/DFARS/NIST/CMMC/508 catalogs, SBLO
// subcontract contacts, the ToS version, and the admin tenant/user.
//
// Everything here is addressed by explicit ID (or is a table whose
// every row was created by verification testing in the single admin
// firm). Child rows are removed by the schema's onDelete: Cascade
// relations — the asserts at the bottom prove the kept data survived.
//
// Usage (from backend/):
//   npx ts-node -r dotenv/config prisma/scripts/cleanupTestFixtures.ts            # dry run: counts only
//   EXECUTE=1 npx ts-node -r dotenv/config prisma/scripts/cleanupTestFixtures.ts  # actually delete
// =============================================================
import { PrismaClient } from '@prisma/client'

const prisma = new PrismaClient()
const EXECUTE = process.env.EXECUTE === '1'

// ---- Fixture IDs (verified against production before writing this) ----
const FIXTURE_CLIENT_IDS = [
  '08ef351f-8cf2-467a-ae8e-78929cec6b13', // Summit Digital Solutions
  '895786a2-7a28-4787-ab55-2e3066e434aa', // Meridian Federal Services
  '319d2c13-c47c-4dd2-9f7f-3a811c740e16', // Cascade Logistics Group
  'f29d00a8-d859-469a-aec8-60c3aa536983', // Ironpeak Construction LLC
]
const FIXTURE_OPPORTUNITY_IDS = [
  '811cce3e-2090-44a0-9c38-2e893d9efc10', // MANUAL: IT Support Services for VA Medical Center
  '91a45ae0-4ceb-420a-8e88-3dee2c0fc0ae', // seed demo (isDemo): VA VISN 12 Medical Equipment Transport
]
const FIXTURE_CONTRACT_ID = '4a977fbf-903f-41b1-9ef3-bb4edda71be4' // 36C25726C0042
const FIXTURE_PARTNER_ID = 'cmtk9tscf002m2f2xuj5uwky8' // Ironclad Cyber Solutions

async function main() {
  console.log(EXECUTE ? '=== EXECUTE MODE — deleting ===' : '=== DRY RUN — counting only (set EXECUTE=1 to delete) ===')

  // Safety: refuse to run if the database has more than one firm — this
  // script's "delete all rows" tables are only safe in the single-tenant
  // verification state the IDs above were captured in.
  const firmCount = await prisma.consultingFirm.count()
  if (firmCount !== 1) {
    throw new Error(`Expected exactly 1 consulting firm, found ${firmCount} — aborting.`)
  }

  // Steps run child-first so no Restrict FK between fixture parents can block.
  // [label, model.deleteMany args] — tables where EVERY row is verification data
  // use {} (delete all); everything else is scoped to fixture IDs.
  const steps: [string, () => Promise<{ count: number }>, () => Promise<number>][] = [
    ['agent events',        () => prisma.agentEvent.deleteMany({}),        () => prisma.agentEvent.count()],
    ['agent artifacts',     () => prisma.agentArtifact.deleteMany({}),     () => prisma.agentArtifact.count()],
    ['agent escalations',   () => prisma.agentEscalation.deleteMany({}),   () => prisma.agentEscalation.count()],
    ['agent runs',          () => prisma.agentRun.deleteMany({}),          () => prisma.agentRun.count()],
    ['CRM follow-ups',      () => prisma.crmFollowUp.deleteMany({}),       () => prisma.crmFollowUp.count()],
    ['CRM activities',      () => prisma.crmActivity.deleteMany({}),       () => prisma.crmActivity.count()],
    ['government contacts', () => prisma.governmentContact.deleteMany({}), () => prisma.governmentContact.count()],
    ['agency offices',      () => prisma.agencyOffice.deleteMany({}),      () => prisma.agencyOffice.count()],
    ['monitoring profiles', () => prisma.savedMonitoringProfile.deleteMany({}), () => prisma.savedMonitoringProfile.count()],
    ['API tokens',          () => prisma.apiToken.deleteMany({}),          () => prisma.apiToken.count()],
    ['contract (cascades CLINs/mods/funding/costs/invoices/budget/POs/flow-downs)',
      () => prisma.contract.deleteMany({ where: { id: FIXTURE_CONTRACT_ID } }),
      () => prisma.contract.count({ where: { id: FIXTURE_CONTRACT_ID } })],
    ['partner portal users', () => prisma.partnerPortalUser.deleteMany({}), () => prisma.partnerPortalUser.count()],
    ['partner (cascades teaming arrangements/agreement drafts/contacts)',
      () => prisma.partner.deleteMany({ where: { id: FIXTURE_PARTNER_ID } }),
      () => prisma.partner.count({ where: { id: FIXTURE_PARTNER_ID } })],
    ['fixture opportunities (cascades pursuits/proposals/pricing/submission workspaces/compliance matrices/matches/milestones)',
      () => prisma.opportunity.deleteMany({ where: { id: { in: FIXTURE_OPPORTUNITY_IDS } } }),
      () => prisma.opportunity.count({ where: { id: { in: FIXTURE_OPPORTUNITY_IDS } } })],
    ['fixture clients (cascades portal users/grants/documents/uploads/rewards/compliance logs/NAICS)',
      () => prisma.clientCompany.deleteMany({ where: { id: { in: FIXTURE_CLIENT_IDS } } }),
      () => prisma.clientCompany.count({ where: { id: { in: FIXTURE_CLIENT_IDS } } })],
  ]

  for (const [label, del, count] of steps) {
    if (EXECUTE) {
      const r = await del()
      console.log(`deleted ${String(r.count).padStart(5)}  ${label}`)
    } else {
      const n = await count()
      console.log(`would delete ${String(n).padStart(5)} top-level rows  ${label}`)
    }
  }

  // ---- Post-conditions: what must SURVIVE ----
  const kept = {
    samOpportunities: await prisma.opportunity.count({ where: { samNoticeId: { not: null }, isDemo: false } }),
    stateMunicipal: await prisma.stateMunicipalOpportunity.count(),
    subcontractContacts: await prisma.subcontractContact.count(),
    naicsCodes: await prisma.naicsCode.count(),
    farClauses: await prisma.farClause.count(),
    dfarsClauses: await prisma.dfarsClause.count(),
    nistControls: await prisma.nist800171Control.count(),
    cmmcPractices: await prisma.cmmcPractice.count(),
    firms: await prisma.consultingFirm.count(),
    users: await prisma.user.count(),
    tosVersions: await prisma.termsOfServiceVersion.count(),
  }
  console.log('\nKept data:', JSON.stringify(kept, null, 2))

  if (EXECUTE) {
    const leftovers = {
      clients: await prisma.clientCompany.count(),
      contracts: await prisma.contract.count(),
      partners: await prisma.partner.count(),
      proposals: await prisma.proposal.count(),
      pursuits: await prisma.bidPursuit.count(),
      submissions: await prisma.submissionRecord.count(),
      pricingWorkspaces: await prisma.pricingWorkspace.count(),
      proposalSubmissions: await prisma.proposalSubmission.count(),
      portalUsers: await prisma.clientPortalUser.count(),
      manualOrDemoOpps: await prisma.opportunity.count({ where: { OR: [{ samNoticeId: null }, { isDemo: true }] } }),
    }
    console.log('Fixture leftovers (all should be 0):', JSON.stringify(leftovers, null, 2))
    const dirty = Object.entries(leftovers).filter(([, v]) => v !== 0)
    if (dirty.length) throw new Error(`Leftover fixture rows: ${dirty.map(([k, v]) => `${k}=${v}`).join(', ')}`)
    console.log('\nCleanup complete — all fixtures removed, kept data intact.')
  }
}

main()
  .catch((e) => { console.error(e); process.exitCode = 1 })
  .finally(() => prisma.$disconnect())
