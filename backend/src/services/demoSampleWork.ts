// =============================================================
// The work a demo account has already done: past bids and their outcomes, an
// awarded contract with its billing, and the libraries a proposal draws on.
//
// Invented, like the rest of the sample data, and scoped to one firm. Nothing here
// uses a file, because the demo has none.
// =============================================================
import { createHash, randomUUID } from 'crypto'
import { Prisma } from '@prisma/client'
import { prisma } from '../config/database'
import type { DemoBusinessType } from './demoBusinessTypes'

const DAY = 86_400_000
const inDays = (n: number) => new Date(Date.now() + n * DAY)
const money = (n: number) => new Prisma.Decimal(n)

interface SampleContext {
  consultingFirmId: string
  ownerUserId: string
  clients: Array<{ id: string; name: string }>
  proposalOpportunity: { id: string; title: string }
  partnerId: string
  placeOfPerformance: string
  type: DemoBusinessType
  /** A contractor account: every entry in `clients` is its own company. */
  contractor?: boolean
  /**
   * The set-asides the operator ticked for a contractor's own company. When
   * given, the sample certifications are exactly these (so the records never
   * claim one the company doesn't have); otherwise a sample SDVOSB one.
   */
  setAsides?: Array<'SDVOSB' | 'WOSB' | 'HUBZONE' | 'SBA_8A'>
}

const SET_ASIDE_CERTIFICATION: Record<'SDVOSB' | 'WOSB' | 'HUBZONE' | 'SBA_8A', string> = {
  SDVOSB: 'SDVOSB Certification', WOSB: 'WOSB Certification', HUBZONE: 'HUBZone Certification', SBA_8A: '8(a) Certification',
}

// Two past bids per client, by position in a business type's past-bid list, so win
// rates by agency and client have something to show.
const PAST_BIDS = [
  { value: 2_300_000, client: 0, daysAgo: 210, outcome: 'WON', onTime: true },
  { value: 3_400_000, client: 0, daysAgo: 150, outcome: 'LOST', onTime: true },
  { value: 780_000, client: 1, daysAgo: 190, outcome: 'WON', onTime: true },
  { value: 1_450_000, client: 1, daysAgo: 120, outcome: 'LOST', onTime: true },
  { value: 640_000, client: 2, daysAgo: 170, outcome: 'LOST', onTime: false },
  { value: 2_100_000, client: 2, daysAgo: 45, outcome: null, onTime: true },
] as const

/** A finished bid's pipeline card: Submitted while waiting, closed once the outcome is known. */
async function createFinishedBidCard(consultingFirmId: string, ownerUserId: string, opportunityId: string, submissionRecordId: string, outcome: string | null, deadline: Date): Promise<void> {
  await prisma.bidPursuit.create({
    data: {
      consultingFirmId,
      opportunityId,
      ownerUserId,
      status: 'SUBMITTED',
      pipelineStage: outcome === 'WON' ? 'AWARDED' : outcome === 'LOST' ? 'LOST' : 'SUBMITTED',
      submissionRecordId,
      probabilityAtDecision: 0.6,
      decidedAt: deadline,
      firstViewedAt: new Date(deadline.getTime() - 20 * DAY),
      lastActivityAt: deadline,
      closedAt: outcome ? new Date(deadline.getTime() + 30 * DAY) : null,
      closeReason: outcome,
    },
  })
}

/** Real submission records, and client statistics worked out from them, so the funnel adds up. */
async function seedPastBids({ consultingFirmId, ownerUserId, clients, placeOfPerformance, type }: SampleContext): Promise<void> {
  for (const [index, bid] of PAST_BIDS.entries()) {
    const deadline = inDays(-bid.daysAgo)
    const opportunity = await prisma.opportunity.create({
      data: {
        consultingFirmId,
        title: type.pastBids[index],
        agency: type.agencies[index % type.agencies.length],
        naicsCode: type.naicsCodes[bid.client],
        placeOfPerformance,
        samNoticeId: `DEMO-${randomUUID()}`,
        status: bid.outcome ? 'AWARDED' : 'EXPIRED',
        isDemo: false,
        isScored: true,
        probabilityScore: 0.6,
        estimatedValue: money(bid.value),
        expectedValue: money(Math.round(bid.value * 0.6)),
        postedDate: new Date(deadline.getTime() - 30 * DAY),
        responseDeadline: deadline,
      },
    })
    const submission = await prisma.submissionRecord.create({
      data: {
        consultingFirmId,
        clientCompanyId: clients[bid.client].id,
        opportunityId: opportunity.id,
        submittedById: ownerUserId,
        submittedAt: new Date(deadline.getTime() + (bid.onTime ? -DAY : DAY)),
        wasOnTime: bid.onTime,
        status: 'APPROVED',
        outcome: bid.outcome,
        outcomeRecordedAt: bid.outcome ? new Date(deadline.getTime() + 30 * DAY) : null,
      },
    })
    await createFinishedBidCard(consultingFirmId, ownerUserId, opportunity.id, submission.id, bid.outcome, deadline)
  }

  // One stats row per distinct client: a contractor's own company fills every slot.
  for (const client of clients.filter((c, i) => clients.findIndex((x) => x.id === c.id) === i)) {
    const bids = PAST_BIDS.filter((bid) => clients[bid.client].id === client.id)
    const onTime = bids.filter((bid) => bid.onTime).length
    await prisma.performanceStats.create({
      data: {
        clientCompanyId: client.id,
        totalOpportunities: bids.length,
        totalSubmitted: bids.length,
        totalWon: bids.filter((bid) => bid.outcome === 'WON').length,
        totalLost: bids.filter((bid) => bid.outcome === 'LOST').length,
        submissionsOnTime: onTime,
        submissionsLate: bids.length - onTime,
        completionRate: onTime / bids.length,
        lastCalculatedAt: new Date(),
      },
    })
  }
}

async function seedContract({ consultingFirmId, ownerUserId, clients, type }: SampleContext): Promise<void> {
  const contract = await prisma.contract.create({
    data: {
      consultingFirmId,
      clientCompanyId: clients[0].id,
      ownerUserId,
      contractNumber: `DEMO-${randomUUID().slice(0, 8).toUpperCase()}`,
      title: `${type.contract.title} (awarded)`,
      agency: type.agencies[0],
      contractType: 'T&M',
      status: 'ACTIVE',
      awardValue: money(2_400_000),
      fundedValue: money(1_200_000),
      ceilingValue: money(2_400_000),
      startDate: inDays(-180),
      endDate: inDays(185),
      description: type.contract.work,
    },
  })
  const base = { consultingFirmId, contractId: contract.id }

  const clin = await prisma.clin.create({
    data: { ...base, clinNumber: '0001', title: type.contract.title, unit: 'Hours', fundedAmount: money(1_200_000), ceilingAmount: money(2_400_000), startDate: inDays(-180), endDate: inDays(185) },
  })
  await prisma.contractOptionPeriod.create({
    data: { ...base, label: 'Option Year 1', startDate: inDays(186), endDate: inDays(550), optionValue: money(1_300_000), exerciseDeadline: inDays(125) },
  })
  await prisma.contractLaborRate.createMany({
    data: [
      { ...base, categoryName: type.jobTitles[0], billingRate: money(135), costRate: money(92), effectiveStart: inDays(-180) },
      { ...base, categoryName: type.jobTitles[2], billingRate: money(78), costRate: money(51), effectiveStart: inDays(-180) },
    ],
  })
  await prisma.contractDeliverable.createMany({
    data: [
      { ...base, clinId: clin.id, ownerUserId, name: 'Monthly Status Report: last month', deliverableType: 'REPORT', frequency: 'MONTHLY', dueDate: inDays(-20), submissionDate: inDays(-22), status: 'ACCEPTED', acceptanceStatus: 'ACCEPTED', acceptanceDate: inDays(-15) },
      { ...base, clinId: clin.id, ownerUserId, name: 'Monthly Status Report: this month', deliverableType: 'REPORT', frequency: 'MONTHLY', dueDate: inDays(10), status: 'IN_PROGRESS' },
      { ...base, clinId: clin.id, ownerUserId, name: 'Quality Control Plan Update', deliverableType: 'PLAN', dueDate: inDays(32), status: 'NOT_STARTED' },
    ],
  })

  // Not billed yet, so they show as this period's approved time.
  const week = [6, 5, 4, 3].map((daysAgo) => ({
    ...base,
    clinId: clin.id,
    userId: ownerUserId,
    laborCategory: type.jobTitles[0],
    workDate: inDays(-daysAgo),
    hours: money(8),
    description: type.contract.title,
    status: 'APPROVED',
    approverUserId: ownerUserId,
    decidedAt: inDays(-2),
    appliedBillingRate: money(135),
    appliedCostRate: money(92),
    billingAmount: money(1080),
    costAmount: money(736),
  }))
  await prisma.timeEntry.createMany({ data: week })

  const invoices = [
    { number: 'INV-1001', amount: 96_000, paid: 96_000, status: 'PAID', issuedDaysAgo: 95, paidDaysAgo: 60 },
    { number: 'INV-1002', amount: 102_500, paid: 0, status: 'OVERDUE', issuedDaysAgo: 65, paidDaysAgo: null },
    { number: 'INV-1003', amount: 98_750, paid: 0, status: 'SUBMITTED', issuedDaysAgo: 12, paidDaysAgo: null },
  ]
  for (const invoice of invoices) {
    const issued = inDays(-invoice.issuedDaysAgo)
    const created = await prisma.contractInvoice.create({
      data: {
        ...base,
        invoiceNumber: invoice.number,
        status: invoice.status,
        invoiceDate: issued,
        dueDate: new Date(issued.getTime() + 30 * DAY),
        periodStart: new Date(issued.getTime() - 30 * DAY),
        periodEnd: issued,
        submittedAt: issued,
        paidAt: invoice.paidDaysAgo === null ? null : inDays(-invoice.paidDaysAgo),
        customerName: type.agencies[0],
        subtotal: money(invoice.amount),
        total: money(invoice.amount),
        amountPaid: money(invoice.paid),
        createdByUserId: ownerUserId,
      },
    })
    await prisma.contractInvoiceLineItem.create({
      data: { consultingFirmId, invoiceId: created.id, kind: 'LABOR', description: type.contract.title, amount: money(invoice.amount), clinId: clin.id },
    })
  }
}

async function seedLibraries({ consultingFirmId, ownerUserId, clients, type, setAsides }: SampleContext): Promise<void> {
  await prisma.pastPerformanceRecord.createMany({
    data: [
      { client: 0, bid: 0, number: '1001', value: 2_300_000, role: 'PRIME', rating: 'Very Good', status: 'APPROVED', start: -900, end: -170 },
      { client: 1, bid: 2, number: '1002', value: 780_000, role: 'PRIME', rating: 'Satisfactory', status: 'APPROVED', start: -800, end: -150 },
      { client: 2, bid: 4, number: '1003', value: 640_000, role: 'SUB', rating: 'Very Good', status: 'VERIFIED', start: -1000, end: -300 },
    ].map((record) => ({
      consultingFirmId,
      clientCompanyId: clients[record.client].id,
      contractNumber: `DEMO-PP-${record.number}`,
      contractTitle: type.pastBids[record.bid],
      customerName: type.agencies[record.bid % type.agencies.length],
      totalValue: money(record.value),
      naicsCode: type.naicsCodes[record.client],
      performerRole: record.role,
      periodOfPerformanceStart: inDays(record.start),
      periodOfPerformanceEnd: inDays(record.end),
      cparsRating: record.rating,
      workPerformed: `${type.pastBids[record.bid]}, delivered to the agreed schedule and quality standards.`,
      resultsOutcomes: 'Met every contract milestone, with no open corrective actions at closeout.',
      verificationStatus: record.status,
    })),
  })

  for (const narrative of type.capabilities) {
    const created = await prisma.capabilityNarrative.create({
      data: { consultingFirmId, title: narrative.title, createdByUserId: ownerUserId },
    })
    const version = await prisma.capabilityNarrativeVersion.create({
      data: {
        consultingFirmId,
        capabilityNarrativeId: created.id,
        versionNumber: 1,
        content: narrative.content,
        contentHash: createHash('sha256').update(narrative.content).digest('hex'),
        status: 'APPROVED',
        createdByUserId: ownerUserId,
        approvedByUserId: ownerUserId,
        approvedAt: new Date(),
      },
    })
    await prisma.capabilityNarrative.update({ where: { id: created.id }, data: { currentApprovedVersionId: version.id } })
  }

  const people = [['Jordan', 'Ellis', 14], ['Morgan', 'Reyes', 11], ['Taylor', 'Brooks', 8]] as const
  await prisma.personnel.createMany({
    data: people.map(([firstName, lastName, yearsExperience], index) => ({
      consultingFirmId,
      firstName,
      lastName,
      jobTitle: type.jobTitles[index],
      yearsExperience,
      summary: `${type.jobTitles[index]} with ${yearsExperience} years on federal contracts in ${type.label.toLowerCase()}.`,
      createdByUserId: ownerUserId,
    })),
  })

  await prisma.certification.createMany({
    data: [
      ...(setAsides ?? ['SDVOSB' as const]).map((key) => (
        { consultingFirmId, name: SET_ASIDE_CERTIFICATION[key], issuingBody: 'U.S. Small Business Administration', issueDate: inDays(-300), expiryDate: inDays(430), ownerUserId }
      )),
      { consultingFirmId, name: 'ISO 9001:2015', category: 'QUALITY', issuingBody: 'Independent registrar', issueDate: inDays(-500), expiryDate: inDays(45), ownerUserId },
    ],
  })
  await prisma.insurancePolicy.create({
    data: { consultingFirmId, policyType: 'General Liability', carrier: 'Sample Mutual', coverageAmount: money(2_000_000), effectiveDate: inDays(-120), expiryDate: inDays(245), ownerUserId },
  })
}

/** Verified requirements, so the matrix has content and "Generate outline" works. */
export async function seedComplianceMatrix(consultingFirmId: string, ownerUserId: string, opportunityId: string): Promise<void> {
  const matrix = await prisma.complianceMatrix.create({
    data: { consultingFirmId, opportunityId },
  })
  const requirements = [
    { section: 'L.3.1', sectionType: 'INSTRUCTION', proposalSection: 'Technical Approach', requirementText: 'Describe the approach to assessing the current environment and security controls.' },
    { section: 'L.3.2', sectionType: 'INSTRUCTION', proposalSection: 'Technical Approach', requirementText: 'Provide a phased plan for reaching the agency target state.' },
    { section: 'L.4.1', sectionType: 'INSTRUCTION', proposalSection: 'Management Plan', requirementText: 'Identify the program manager and describe the reporting structure.' },
    { section: 'L.5.1', sectionType: 'INSTRUCTION', proposalSection: 'Past Performance', requirementText: 'Provide three relevant contracts performed within the last five years.' },
    { section: 'M.2', sectionType: 'EVALUATION', proposalSection: 'Technical Approach', requirementText: 'Technical approach is evaluated as more important than price.' },
  ]
  await prisma.matrixRequirement.createMany({
    data: requirements.map((requirement, sortOrder) => ({
      ...requirement,
      consultingFirmId,
      matrixId: matrix.id,
      sortOrder,
      extractionMethod: 'MANUAL',
      verificationStatus: 'VERIFIED',
      ownerUserId,
    })),
  })
}

async function seedRelationships({ consultingFirmId, ownerUserId, clients, proposalOpportunity, partnerId, type, contractor }: SampleContext): Promise<void> {
  const proposalOpportunityId = proposalOpportunity.id
  const [agency, otherAgency] = type.agencies
  const office = await prisma.agencyOffice.create({
    data: { consultingFirmId, agencyName: agency, officeName: 'Office of Procurement Operations', createdByUserId: ownerUserId },
  })
  await prisma.agencyOffice.create({
    data: { consultingFirmId, agencyName: otherAgency, officeName: 'Acquisition Center', createdByUserId: ownerUserId },
  })
  const contact = await prisma.governmentContact.create({
    data: { consultingFirmId, agencyOfficeId: office.id, agencyName: agency, fullName: 'Alex Morgan', title: 'Contracting Officer', contactRole: 'CONTRACTING_OFFICER', ownerUserId, createdByUserId: ownerUserId },
  })
  const activity = await prisma.crmActivity.create({
    data: { consultingFirmId, activityType: 'CAPABILITY_BRIEFING', occurredAt: inDays(-9), subject: `${type.label} capability briefing`, summary: 'Walked the office through recent work. They asked about small business teaming.', governmentContactId: contact.id, agencyOfficeId: office.id, agencyName: agency, opportunityId: proposalOpportunityId, ownerUserId, followUpNeeded: true, createdByUserId: ownerUserId },
  })
  await prisma.crmFollowUp.create({
    data: { consultingFirmId, title: 'Send teaming partner summary to the contracting officer', dueAt: inDays(4), priority: 'HIGH', ownerUserId, governmentContactId: contact.id, opportunityId: proposalOpportunityId, activityId: activity.id, createdByUserId: ownerUserId },
  })
  await prisma.teamingArrangement.create({
    data: { consultingFirmId, opportunityId: proposalOpportunityId, partnerId, role: 'SUB', arrangementType: 'TEAMING_AGREEMENT', teamingStatus: 'COMMITTED', scopePercent: 25, workshareDescription: 'A defined share of the technical work, led by the partner.', ownerUserId },
  })
  // Document requests go to clients; a contractor account has none.
  if (!contractor) {
    await prisma.documentRequirement.createMany({
      data: [
        { consultingFirmId, clientCompanyId: clients[0].id, opportunityId: proposalOpportunityId, title: 'Capability Statement', description: 'Current capability statement for the proposal package.', dueDate: inDays(14), isPenaltyEnabled: false },
        { consultingFirmId, clientCompanyId: clients[1].id, title: 'Certificate of Insurance', description: 'Proof of current liability cover.', dueDate: inDays(21), isPenaltyEnabled: false },
      ],
    })
  }
  await prisma.userNotification.createMany({
    data: [
      { consultingFirmId, userId: ownerUserId, type: 'OPPORTUNITY_ALERT', title: contractor ? 'New opportunity matches your company' : 'New opportunity matches a client', body: contractor ? `${proposalOpportunity.title} fits your company.` : `${proposalOpportunity.title} fits one of your clients.`, linkPath: `/opportunities/${proposalOpportunityId}`, dedupeKey: `demo-${randomUUID()}` },
      { consultingFirmId, userId: ownerUserId, type: 'SUBMISSION_REMINDER', title: 'A proposal deadline is coming up', body: 'Review the proposal sections before the response deadline.', linkPath: `/opportunities/${proposalOpportunityId}/proposal`, dedupeKey: `demo-${randomUUID()}` },
    ],
  })
}

export async function seedDemoWork(context: SampleContext): Promise<void> {
  await seedPastBids(context)
  await seedContract(context)
  await seedLibraries(context)
  await seedRelationships(context)
}
