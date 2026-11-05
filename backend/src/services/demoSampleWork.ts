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

const DAY = 86_400_000
const inDays = (n: number) => new Date(Date.now() + n * DAY)
const money = (n: number) => new Prisma.Decimal(n)

interface SampleContext {
  consultingFirmId: string
  ownerUserId: string
  clients: Array<{ id: string; name: string }>
  proposalOpportunityId: string
  partnerId: string
  placeOfPerformance: string
}

// Two past bids per client, so win rates by agency and client have something to show.
const PAST_BIDS = [
  { title: 'Network Security Monitoring Support', agency: 'Department of Veterans Affairs', naicsCode: '541512', value: 2_300_000, client: 0, daysAgo: 210, outcome: 'WON', onTime: true },
  { title: 'Identity Management Upgrade', agency: 'Department of Homeland Security', naicsCode: '541519', value: 3_400_000, client: 0, daysAgo: 150, outcome: 'LOST', onTime: true },
  { title: 'Medical Supply Courier Services', agency: 'Department of Veterans Affairs', naicsCode: '484121', value: 780_000, client: 1, daysAgo: 190, outcome: 'WON', onTime: true },
  { title: 'Fleet Logistics Support', agency: 'General Services Administration', naicsCode: '488510', value: 1_450_000, client: 1, daysAgo: 120, outcome: 'LOST', onTime: true },
  { title: 'Federal Building Custodial Services', agency: 'General Services Administration', naicsCode: '561720', value: 640_000, client: 2, daysAgo: 170, outcome: 'LOST', onTime: false },
  { title: 'Base Facilities Maintenance', agency: 'Department of the Army', naicsCode: '561210', value: 2_100_000, client: 2, daysAgo: 45, outcome: null, onTime: true },
] as const

/** Real submission records, and client statistics worked out from them, so the funnel adds up. */
async function seedPastBids({ consultingFirmId, ownerUserId, clients, placeOfPerformance }: SampleContext): Promise<void> {
  for (const bid of PAST_BIDS) {
    const deadline = inDays(-bid.daysAgo)
    const opportunity = await prisma.opportunity.create({
      data: {
        consultingFirmId,
        title: bid.title,
        agency: bid.agency,
        naicsCode: bid.naicsCode,
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
    // Finished bids are the only pipeline cards an account starts with. The open
    // opportunities have none, so opening any of them puts it in Identified.
    await prisma.bidPursuit.create({
      data: {
        consultingFirmId,
        opportunityId: opportunity.id,
        ownerUserId,
        status: 'SUBMITTED',
        pipelineStage: bid.outcome === 'WON' ? 'AWARDED' : bid.outcome === 'LOST' ? 'LOST' : 'SUBMITTED',
        submissionRecordId: submission.id,
        probabilityAtDecision: 0.6,
        decidedAt: deadline,
        firstViewedAt: new Date(deadline.getTime() - 20 * DAY),
        lastActivityAt: deadline,
        closedAt: bid.outcome ? new Date(deadline.getTime() + 30 * DAY) : null,
        closeReason: bid.outcome,
      },
    })
  }

  for (const [index, client] of clients.entries()) {
    const bids = PAST_BIDS.filter((bid) => bid.client === index)
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

async function seedContract({ consultingFirmId, ownerUserId, clients }: SampleContext): Promise<void> {
  const contract = await prisma.contract.create({
    data: {
      consultingFirmId,
      clientCompanyId: clients[0].id,
      ownerUserId,
      contractNumber: `DEMO-${randomUUID().slice(0, 8).toUpperCase()}`,
      title: 'IT Support Services (awarded)',
      agency: 'Department of Veterans Affairs',
      contractType: 'T&M',
      status: 'ACTIVE',
      awardValue: money(2_400_000),
      fundedValue: money(1_200_000),
      ceilingValue: money(2_400_000),
      startDate: inDays(-180),
      endDate: inDays(185),
      description: 'Help desk and field support across regional medical centers.',
    },
  })
  const base = { consultingFirmId, contractId: contract.id }

  const clin = await prisma.clin.create({
    data: { ...base, clinNumber: '0001', title: 'Help desk and field support', unit: 'Hours', fundedAmount: money(1_200_000), ceilingAmount: money(2_400_000), startDate: inDays(-180), endDate: inDays(185) },
  })
  await prisma.contractOptionPeriod.create({
    data: { ...base, label: 'Option Year 1', startDate: inDays(186), endDate: inDays(550), optionValue: money(1_300_000), exerciseDeadline: inDays(125) },
  })
  await prisma.contractLaborRate.createMany({
    data: [
      { ...base, categoryName: 'Senior Support Engineer', billingRate: money(135), costRate: money(92), effectiveStart: inDays(-180) },
      { ...base, categoryName: 'Support Technician', billingRate: money(78), costRate: money(51), effectiveStart: inDays(-180) },
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
    laborCategory: 'Senior Support Engineer',
    workDate: inDays(-daysAgo),
    hours: money(8),
    description: 'Tier 2 ticket resolution',
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
        customerName: 'Department of Veterans Affairs',
        subtotal: money(invoice.amount),
        total: money(invoice.amount),
        amountPaid: money(invoice.paid),
        createdByUserId: ownerUserId,
      },
    })
    await prisma.contractInvoiceLineItem.create({
      data: { consultingFirmId, invoiceId: created.id, kind: 'LABOR', description: 'Help desk and field support', amount: money(invoice.amount), clinId: clin.id },
    })
  }
}

async function seedLibraries({ consultingFirmId, ownerUserId, clients }: SampleContext): Promise<void> {
  await prisma.pastPerformanceRecord.createMany({
    data: [
      { consultingFirmId, clientCompanyId: clients[0].id, contractNumber: 'DEMO-PP-1001', contractTitle: 'Network Security Monitoring Support', customerName: 'Department of Veterans Affairs', totalValue: money(2_300_000), naicsCode: '541512', performerRole: 'PRIME', periodOfPerformanceStart: inDays(-900), periodOfPerformanceEnd: inDays(-170), cparsRating: 'Very Good', workPerformed: 'Round-the-clock security monitoring and incident response for regional networks.', resultsOutcomes: 'Reduced average incident response time by 38% in the first year.', verificationStatus: 'APPROVED' },
      { consultingFirmId, clientCompanyId: clients[1].id, contractNumber: 'DEMO-PP-1002', contractTitle: 'Medical Supply Courier Services', customerName: 'Department of Veterans Affairs', totalValue: money(780_000), naicsCode: '484121', performerRole: 'PRIME', periodOfPerformanceStart: inDays(-800), periodOfPerformanceEnd: inDays(-150), cparsRating: 'Satisfactory', workPerformed: 'Scheduled and same-day courier routes between medical centers.', resultsOutcomes: '99.2% on-time delivery across the contract.', verificationStatus: 'APPROVED' },
      { consultingFirmId, clientCompanyId: clients[2].id, contractNumber: 'DEMO-PP-1003', contractTitle: 'Regional Office Custodial Services', customerName: 'General Services Administration', totalValue: money(520_000), naicsCode: '561720', performerRole: 'SUB', periodOfPerformanceStart: inDays(-1000), periodOfPerformanceEnd: inDays(-300), cparsRating: 'Very Good', workPerformed: 'Custodial and grounds services for three federal buildings.', resultsOutcomes: 'No customer complaints in the final contract year.', verificationStatus: 'VERIFIED' },
    ],
  })

  const narratives = [
    { title: 'Zero Trust Implementation', content: 'Our engineers assess identity, device and network controls against federal zero trust guidance, then deliver a phased plan that keeps mission systems running throughout.' },
    { title: 'Federal Help Desk Operations', content: 'We run tiered support with documented escalation paths, measured against agreed service levels and reported monthly to the program office.' },
  ]
  for (const narrative of narratives) {
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

  await prisma.personnel.createMany({
    data: [
      { consultingFirmId, firstName: 'Jordan', lastName: 'Ellis', jobTitle: 'Program Manager', yearsExperience: 14, summary: 'Has led federal IT support programs of up to 60 staff.', createdByUserId: ownerUserId },
      { consultingFirmId, firstName: 'Morgan', lastName: 'Reyes', jobTitle: 'Cybersecurity Lead', yearsExperience: 11, summary: 'Designs zero trust roadmaps for civilian agencies.', createdByUserId: ownerUserId },
      { consultingFirmId, firstName: 'Taylor', lastName: 'Brooks', jobTitle: 'Senior Support Engineer', yearsExperience: 8, summary: 'Runs tier 2 and tier 3 support for distributed sites.', createdByUserId: ownerUserId },
    ],
  })

  await prisma.certification.createMany({
    data: [
      { consultingFirmId, name: 'SDVOSB Certification', issuingBody: 'U.S. Small Business Administration', issueDate: inDays(-300), expiryDate: inDays(430), ownerUserId },
      { consultingFirmId, name: 'ISO 9001:2015', category: 'QUALITY', issuingBody: 'Independent registrar', issueDate: inDays(-500), expiryDate: inDays(45), ownerUserId },
    ],
  })
  await prisma.insurancePolicy.create({
    data: { consultingFirmId, policyType: 'General Liability', carrier: 'Sample Mutual', coverageAmount: money(2_000_000), effectiveDate: inDays(-120), expiryDate: inDays(245), ownerUserId },
  })
}

/** Verified requirements, so the matrix has content and "Generate outline" works. */
async function seedComplianceMatrix({ consultingFirmId, ownerUserId, proposalOpportunityId }: SampleContext): Promise<void> {
  const matrix = await prisma.complianceMatrix.create({
    data: { consultingFirmId, opportunityId: proposalOpportunityId },
  })
  const requirements = [
    { section: 'L.3.1', sectionType: 'INSTRUCTION', proposalSection: 'Technical Approach', requirementText: 'Describe the approach to assessing current identity and access controls.' },
    { section: 'L.3.2', sectionType: 'INSTRUCTION', proposalSection: 'Technical Approach', requirementText: 'Provide a phased roadmap toward the agency zero trust target state.' },
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

async function seedRelationships({ consultingFirmId, ownerUserId, clients, proposalOpportunityId, partnerId }: SampleContext): Promise<void> {
  const office = await prisma.agencyOffice.create({
    data: { consultingFirmId, agencyName: 'Department of Homeland Security', officeName: 'Office of Procurement Operations', createdByUserId: ownerUserId },
  })
  await prisma.agencyOffice.create({
    data: { consultingFirmId, agencyName: 'Department of Veterans Affairs', officeName: 'Technology Acquisition Center', createdByUserId: ownerUserId },
  })
  const contact = await prisma.governmentContact.create({
    data: { consultingFirmId, agencyOfficeId: office.id, agencyName: 'Department of Homeland Security', fullName: 'Alex Morgan', title: 'Contracting Officer', contactRole: 'CONTRACTING_OFFICER', ownerUserId, createdByUserId: ownerUserId },
  })
  const activity = await prisma.crmActivity.create({
    data: { consultingFirmId, activityType: 'CAPABILITY_BRIEFING', occurredAt: inDays(-9), subject: 'Zero trust capability briefing', summary: 'Walked the office through recent zero trust work. They asked about small business teaming.', governmentContactId: contact.id, agencyOfficeId: office.id, agencyName: 'Department of Homeland Security', opportunityId: proposalOpportunityId, ownerUserId, followUpNeeded: true, createdByUserId: ownerUserId },
  })
  await prisma.crmFollowUp.create({
    data: { consultingFirmId, title: 'Send teaming partner summary to the contracting officer', dueAt: inDays(4), priority: 'HIGH', ownerUserId, governmentContactId: contact.id, opportunityId: proposalOpportunityId, activityId: activity.id, createdByUserId: ownerUserId },
  })
  await prisma.teamingArrangement.create({
    data: { consultingFirmId, opportunityId: proposalOpportunityId, partnerId, role: 'SUB', arrangementType: 'TEAMING_AGREEMENT', teamingStatus: 'COMMITTED', scopePercent: 25, workshareDescription: 'Network assessment and penetration testing.', ownerUserId },
  })
  await prisma.documentRequirement.createMany({
    data: [
      { consultingFirmId, clientCompanyId: clients[0].id, opportunityId: proposalOpportunityId, title: 'Capability Statement', description: 'Current capability statement for the proposal package.', dueDate: inDays(14), isPenaltyEnabled: false },
      { consultingFirmId, clientCompanyId: clients[1].id, title: 'Certificate of Insurance', description: 'Proof of current liability cover.', dueDate: inDays(21), isPenaltyEnabled: false },
    ],
  })
  await prisma.userNotification.createMany({
    data: [
      { consultingFirmId, userId: ownerUserId, type: 'OPPORTUNITY_ALERT', title: 'New opportunity matches a client', body: 'Zero Trust Architecture Assessment and Support fits one of your clients.', linkPath: `/opportunities/${proposalOpportunityId}`, dedupeKey: `demo-${randomUUID()}` },
      { consultingFirmId, userId: ownerUserId, type: 'SUBMISSION_REMINDER', title: 'A proposal deadline is coming up', body: 'Review the proposal sections before the response deadline.', linkPath: `/opportunities/${proposalOpportunityId}/proposal`, dedupeKey: `demo-${randomUUID()}` },
    ],
  })
}

export async function seedDemoWork(context: SampleContext): Promise<void> {
  await seedPastBids(context)
  await seedContract(context)
  await seedLibraries(context)
  await seedComplianceMatrix(context)
  await seedRelationships(context)
}
