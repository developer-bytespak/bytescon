// =============================================================
// Test data factories — minimal-by-default constructors that
// satisfy schema constraints with sensible defaults. Caller
// passes overrides only for fields that matter to the test.
//
// All IDs are unique-per-call so tests can run in parallel.
// =============================================================
import { prisma } from '../config/database'

let counter = 0
export function uniq(prefix: string): string {
  counter += 1
  return `${prefix}-${Date.now()}-${counter}`
}

// -------------------------------------------------------------
// ClientCompany
// -------------------------------------------------------------
export async function createTestClient(
  consultingFirmId: string,
  overrides: {
    name?: string
    sdvosb?: boolean
    wosb?: boolean
    hubzone?: boolean
    smallBusiness?: boolean
    naicsCodes?: string[]
  } = {},
) {
  return prisma.clientCompany.create({
    data: {
      consultingFirmId,
      name: overrides.name ?? `Test Client ${uniq('cc')}`,
      naicsCodes: overrides.naicsCodes ?? ['541330'],
      sdvosb: overrides.sdvosb ?? false,
      wosb: overrides.wosb ?? false,
      hubzone: overrides.hubzone ?? false,
      smallBusiness: overrides.smallBusiness ?? true,
      isActive: true,
    },
  })
}

// -------------------------------------------------------------
// Opportunity
// -------------------------------------------------------------
export async function createTestOpportunity(
  consultingFirmId: string,
  overrides: {
    title?: string
    agency?: string
    naicsCode?: string
    setAsideType?: string
    estimatedValue?: number
    responseDeadline?: Date
    isScored?: boolean
    probabilityScore?: number
    noticeType?: string
  } = {},
) {
  return prisma.opportunity.create({
    data: {
      consultingFirmId,
      title: overrides.title ?? `Test Opportunity ${uniq('opp')}`,
      agency: overrides.agency ?? 'Department of Defense',
      naicsCode: overrides.naicsCode ?? '541330',
      noticeType: overrides.noticeType,
      setAsideType: overrides.setAsideType ?? 'NONE',
      estimatedValue: overrides.estimatedValue ?? 100000,
      responseDeadline:
        overrides.responseDeadline ?? new Date(Date.now() + 30 * 24 * 3600 * 1000),
      isScored: overrides.isScored ?? false,
      probabilityScore: overrides.probabilityScore ?? 0,
    },
  })
}

// -------------------------------------------------------------
// AwardHistory — historical award attached to an opportunity
// -------------------------------------------------------------
export async function createTestAward(
  opportunityId: string,
  overrides: {
    awardingAgency?: string
    recipientName?: string
    recipientUei?: string
    awardAmount?: number
    awardDate?: Date
    naics?: string
    contractNumber?: string
  } = {},
) {
  return prisma.awardHistory.create({
    data: {
      opportunityId,
      awardingAgency: overrides.awardingAgency ?? 'Department of Defense',
      recipientName: overrides.recipientName ?? 'Acme Federal Inc',
      recipientUei: overrides.recipientUei ?? null,
      awardAmount: overrides.awardAmount ?? 250000,
      awardDate: overrides.awardDate ?? new Date(),
      naics: overrides.naics ?? '541330',
      contractNumber: overrides.contractNumber ?? `K-${uniq('contract')}`,
    },
  })
}

// -------------------------------------------------------------
// SubmissionRecord — bid submission with optional outcome
// -------------------------------------------------------------
export async function createTestSubmission(
  consultingFirmId: string,
  clientCompanyId: string,
  opportunityId: string,
  overrides: {
    submittedAt?: Date | null
    wasOnTime?: boolean
    outcome?: 'WON' | 'LOST' | 'NO_AWARD' | 'WITHDRAWN' | null
    submittedById?: string | null
  } = {},
) {
  return prisma.submissionRecord.create({
    data: {
      consultingFirmId,
      clientCompanyId,
      opportunityId,
      submittedById: overrides.submittedById ?? null,
      submittedAt: overrides.submittedAt ?? new Date(),
      wasOnTime: overrides.wasOnTime ?? true,
      outcome: overrides.outcome ?? null,
      outcomeRecordedAt: overrides.outcome ? new Date() : null,
    },
  })
}

// Re-export the firm + user helpers + cleanup so test files can
// import everything from one place.
export {
  buildTestApp,
  createTestFirm,
  createTestUser,
  cleanupFirm,
  disconnectDb,
  type TestFirm,
  type TestUser,
} from './testClient'
