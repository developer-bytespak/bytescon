// =============================================================
// What a new demo account starts with, so every screen has something to show.
//
// Everything is invented and belongs to that one firm, so one client's changes
// never reach another. Records aren't flagged isDemo, because the app hides
// those rows from its normal lists.
// =============================================================
import { randomUUID } from 'crypto'
import { Prisma } from '@prisma/client'
import { prisma } from '../config/database'
import { scoreOpportunityForClient } from '../engines/probabilityEngine'
import { evaluateBidDecision } from './decisionEngine'
import { buildScoringInputs } from './scoring/scoringInputs'
import { seedDemoWork } from './demoSampleWork'

const DAY = 86_400_000
const inDays = (n: number) => new Date(Date.now() + n * DAY)

// Three invented US companies per set, one for each kind of work below.
export interface UsRegion {
  city: string
  state: string
  placeOfPerformance: string
  clients: [string, string, string]
  partners: [string, string]
}

export const US_REGIONS: UsRegion[] = [
  { city: 'Arlington', state: 'VA', placeOfPerformance: 'Washington, DC', clients: ['Potomac Ridge Technologies', 'Rappahannock Route Logistics', 'Tidewater Facility Services'], partners: ['Blue Ridge Cyber LLC', 'Shenandoah Network Engineering'] },
  { city: 'San Antonio', state: 'TX', placeOfPerformance: 'San Antonio, TX', clients: ['Alamo Secure Systems', 'Gulf Plains Logistics', 'Hill Country Building Services'], partners: ['Brazos Cyber Partners', 'Pecos Network Solutions'] },
  { city: 'San Diego', state: 'CA', placeOfPerformance: 'San Diego, CA', clients: ['Harbor Point Digital', 'Golden Coast Transport', 'Mission Bay Facilities'], partners: ['Sierra Cyber Group', 'Cascade Network Engineering'] },
  { city: 'Chicago', state: 'IL', placeOfPerformance: 'Chicago, IL', clients: ['Lakeshore Data Systems', 'Prairie Route Logistics', 'Windy City Facility Care'], partners: ['Midland Cyber Works', 'Great Plains Network Group'] },
  { city: 'Atlanta', state: 'GA', placeOfPerformance: 'Atlanta, GA', clients: ['Peachtree Federal IT', 'Southern Crossing Freight', 'Magnolia Building Services'], partners: ['Chattahoochee Cyber LLC', 'Piedmont Network Engineering'] },
]

const CLIENT_PROFILES = [
  { naicsCodes: ['541512', '541519'], sdvosb: true, smallBusiness: true },
  { naicsCodes: ['484121', '488510'], smallBusiness: true, wosb: true },
  { naicsCodes: ['561210', '561720'], smallBusiness: true, hubzone: true },
]

// The signals the scoring engine reads. Scores aren't written by hand: the engine
// works them out from these, so its regular re-scoring lands on the same numbers.
const OPPORTUNITIES = [
  { title: 'Zero Trust Architecture Assessment and Support', agency: 'Department of Homeland Security', naicsCode: '541512', setAsideType: 'SDVOSB', value: 4_200_000, days: 34, client: 0, incumbentProbability: 0.3, offersReceived: 4, agencySdvosbRate: 0.22, historicalAwardCount: 420, documentIntelScore: 0.8, description: 'Assess the current network and deliver a phased Zero Trust roadmap, with implementation support across three components.' },
  { title: 'Enterprise Help Desk Modernization', agency: 'Department of Veterans Affairs', naicsCode: '541519', setAsideType: 'SDVOSB', value: 8_750_000, days: 48, client: 0, incumbentProbability: 0.55, offersReceived: 6, agencySdvosbRate: 0.3, historicalAwardCount: 610, documentIntelScore: 0.6, description: 'Tier 1 and Tier 2 help desk services, ticketing migration and service-level reporting for regional medical centers.' },
  { title: 'Cloud Migration for Benefits Systems', agency: 'Social Security Administration', naicsCode: '541512', setAsideType: 'NONE', value: 12_400_000, days: 62, client: 0, incumbentProbability: 0.7, offersReceived: 9, agencySdvosbRate: 0.05, historicalAwardCount: 300, documentIntelScore: 0.45, description: 'Move legacy benefits applications to a FedRAMP High cloud environment and provide two years of operations support.' },
  { title: 'Medical Equipment Transport Services', agency: 'Department of Veterans Affairs', naicsCode: '484121', setAsideType: 'WOSB', value: 1_850_000, days: 21, client: 1, incumbentProbability: 0.35, offersReceived: 3, agencySdvosbRate: 0.3, historicalAwardCount: 150, documentIntelScore: 0.75, description: 'Scheduled and on-call transport of medical equipment between facilities in the Southeast region.' },
  { title: 'Regional Freight Brokerage', agency: 'General Services Administration', naicsCode: '488510', setAsideType: 'SBA', value: 3_100_000, days: 40, client: 1, incumbentProbability: 0.6, offersReceived: 7, agencySdvosbRate: 0.12, historicalAwardCount: 220, documentIntelScore: 0.5, description: 'Freight arrangement and tracking for federal civilian agencies under a five-year blanket purchase agreement.' },
  { title: 'Janitorial and Grounds Maintenance', agency: 'General Services Administration', naicsCode: '561720', setAsideType: 'HUBZONE', value: 960_000, days: 15, client: 2, incumbentProbability: 0.25, offersReceived: 5, agencySdvosbRate: 0.12, historicalAwardCount: 500, documentIntelScore: 0.7, description: 'Daily custodial services and seasonal grounds care across four federal buildings.' },
  { title: 'Facilities Operations Support', agency: 'Department of the Army', naicsCode: '561210', setAsideType: 'SBA', value: 5_600_000, days: 55, client: 2, incumbentProbability: 0.65, offersReceived: 8, agencySdvosbRate: 0.08, historicalAwardCount: 350, documentIntelScore: 0.4, description: 'Integrated facilities support including preventive maintenance and work order management at an installation.' },
  { title: 'Data Analytics Platform Sustainment', agency: 'Department of Defense', naicsCode: '541512', setAsideType: 'NONE', value: 22_000_000, days: 75, client: 0, incumbentProbability: 0.9, offersReceived: 2, agencySdvosbRate: 0.04, historicalAwardCount: 90, documentIntelScore: 0.25, description: 'Sustain and extend a logistics data platform. An incumbent has held this work for six years.' },
]

const PROPOSAL_SECTIONS = [
  { title: 'Technical Approach', draft: 'Our approach begins with a two-week discovery of the current environment, followed by a phased roadmap agreed with the program office.' },
  { title: 'Management Plan', draft: 'A named program manager is the single point of accountability, supported by weekly status reporting and a shared risk register.' },
  { title: 'Past Performance', draft: null },
]

export async function seedDemoSampleData(consultingFirmId: string, ownerUserId: string, region: UsRegion = US_REGIONS[0]): Promise<void> {
  const clients = []
  for (const [index, profile] of CLIENT_PROFILES.entries()) {
    const created = await prisma.clientCompany.create({
      data: {
        ...profile,
        name: region.clients[index],
        city: region.city,
        state: region.state,
        uei: `DEMO${randomUUID().replace(/-/g, '').slice(0, 8).toUpperCase()}`,
        consultingFirmId,
      },
    })
    clients.push(created)
  }

  const opportunities = []
  for (const { value, days, client, ...sample } of OPPORTUNITIES) {
    const opportunity = await prisma.opportunity.create({
      data: {
        ...sample,
        placeOfPerformance: region.placeOfPerformance,
        consultingFirmId,
        samNoticeId: `DEMO-${randomUUID()}`,
        status: 'ACTIVE',
        isDemo: false,
        estimatedValue: new Prisma.Decimal(value),
        postedDate: new Date(Date.now() - 7 * DAY),
        responseDeadline: inDays(days),
      },
    })
    const scored = scoreOpportunityForClient(await buildScoringInputs(opportunity, clients[client]))
    if (scored.status !== 'OK') throw new Error(`Sample opportunity could not be scored: ${scored.failureReason}`)
    await prisma.opportunity.update({
      where: { id: opportunity.id },
      data: {
        isScored: true,
        probabilityScore: scored.probability,
        expectedValue: new Prisma.Decimal(Math.round(value * scored.probability)),
      },
    })
    await evaluateBidDecision(opportunity.id, clients[client].id)
    opportunities.push(opportunity)
  }

  const [zeroTrust, helpDesk, transport, janitorial] = [opportunities[0], opportunities[1], opportunities[3], opportunities[5]]

  // A pipeline with work at different stages.
  const pipeline: Array<[typeof zeroTrust, 'QUALIFICATION' | 'CAPTURE' | 'PROPOSAL']> = [
    [zeroTrust, 'PROPOSAL'],
    [helpDesk, 'CAPTURE'],
    [transport, 'QUALIFICATION'],
    [janitorial, 'CAPTURE'],
  ]
  for (const [opportunity, pipelineStage] of pipeline) {
    await prisma.bidPursuit.create({
      data: { consultingFirmId, opportunityId: opportunity.id, pipelineStage, ownerUserId },
    })
  }

  const proposal = await prisma.proposal.create({
    data: { consultingFirmId, opportunityId: zeroTrust.id, title: `Proposal: ${zeroTrust.title}`, createdByUserId: ownerUserId },
  })
  for (const section of PROPOSAL_SECTIONS) {
    await prisma.proposalSection.create({
      data: { consultingFirmId, opportunityId: zeroTrust.id, proposalId: proposal.id, title: section.title, draft: section.draft, status: 'DRAFTING' },
    })
  }

  const partner = await prisma.partner.create({ data: { consultingFirmId, name: region.partners[0] } })
  await prisma.partner.create({ data: { consultingFirmId, name: region.partners[1] } })

  await seedDemoWork({ consultingFirmId, ownerUserId, clients, proposalOpportunityId: zeroTrust.id, partnerId: partner.id })
}
