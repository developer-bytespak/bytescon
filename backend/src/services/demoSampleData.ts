// =============================================================
// What a new demo account starts with, so every screen has something to show.
//
// Everything is invented and belongs to that one firm, so one client's changes
// never reach another. Records aren't flagged isDemo, because the app hides
// those rows from its normal lists.
// =============================================================
import { randomUUID } from 'crypto'
import { Prisma, type ClientCompany } from '@prisma/client'
import { prisma } from '../config/database'
import { scoreOpportunityForClient } from '../engines/probabilityEngine'
import { evaluateBidDecision } from './decisionEngine'
import { buildScoringInputs } from './scoring/scoringInputs'
import { seedComplianceMatrix, seedDemoWork } from './demoSampleWork'

const DAY = 86_400_000
const inDays = (n: number) => new Date(Date.now() + n * DAY)

// Three invented US companies per set, one for each kind of work below.
export interface UsRegion {
  city: string | null
  state: string
  placeOfPerformance: string
  clients: [string, string, string]
  partners: [string, string]
}

export const US_REGIONS: UsRegion[] = [
  { city: 'Arlington', state: 'VA', placeOfPerformance: 'Washington, DC', clients: ['Potomac Ridge Technologies', 'Rappahannock Route Logistics', 'Chesapeake Shoreline Facility Care'], partners: ['Blue Ridge Cyber LLC', 'Shenandoah Network Engineering'] },
  { city: 'San Antonio', state: 'TX', placeOfPerformance: 'San Antonio, TX', clients: ['Riverwalk Digital Systems', 'Gulf Plains Logistics', 'Hill Country Building Services'], partners: ['Brazos Cyber Partners', 'Pecos Network Solutions'] },
  { city: 'San Diego', state: 'CA', placeOfPerformance: 'San Diego, CA', clients: ['Harbor Point Digital', 'Point Loma Route Logistics', 'Mission Bay Facilities'], partners: ['Sierra Cyber Group', 'Cascade Network Engineering'] },
  { city: 'Chicago', state: 'IL', placeOfPerformance: 'Chicago, IL', clients: ['Lakeshore Data Systems', 'Prairie Route Logistics', 'Windy City Facility Care'], partners: ['Midland Cyber Works', 'Great Plains Network Group'] },
  { city: 'Atlanta', state: 'GA', placeOfPerformance: 'Atlanta, GA', clients: ['Peachtree Federal IT', 'Southern Crossing Freight', 'Magnolia Building Services'], partners: ['Chattahoochee Cyber LLC', 'Piedmont Network Engineering'] },
]

/** Every choice on the operator's form. */
export const US_STATES = [
  { code: 'AL', name: 'Alabama', capital: 'Montgomery' },
  { code: 'AK', name: 'Alaska', capital: 'Juneau' },
  { code: 'AZ', name: 'Arizona', capital: 'Phoenix' },
  { code: 'AR', name: 'Arkansas', capital: 'Little Rock' },
  { code: 'CA', name: 'California', capital: 'Sacramento' },
  { code: 'CO', name: 'Colorado', capital: 'Denver' },
  { code: 'CT', name: 'Connecticut', capital: 'Hartford' },
  { code: 'DE', name: 'Delaware', capital: 'Dover' },
  { code: 'DC', name: 'District of Columbia', capital: 'Washington' },
  { code: 'FL', name: 'Florida', capital: 'Tallahassee' },
  { code: 'GA', name: 'Georgia', capital: 'Atlanta' },
  { code: 'HI', name: 'Hawaii', capital: 'Honolulu' },
  { code: 'ID', name: 'Idaho', capital: 'Boise' },
  { code: 'IL', name: 'Illinois', capital: 'Springfield' },
  { code: 'IN', name: 'Indiana', capital: 'Indianapolis' },
  { code: 'IA', name: 'Iowa', capital: 'Des Moines' },
  { code: 'KS', name: 'Kansas', capital: 'Topeka' },
  { code: 'KY', name: 'Kentucky', capital: 'Frankfort' },
  { code: 'LA', name: 'Louisiana', capital: 'Baton Rouge' },
  { code: 'ME', name: 'Maine', capital: 'Augusta' },
  { code: 'MD', name: 'Maryland', capital: 'Annapolis' },
  { code: 'MA', name: 'Massachusetts', capital: 'Boston' },
  { code: 'MI', name: 'Michigan', capital: 'Lansing' },
  { code: 'MN', name: 'Minnesota', capital: 'Saint Paul' },
  { code: 'MS', name: 'Mississippi', capital: 'Jackson' },
  { code: 'MO', name: 'Missouri', capital: 'Jefferson City' },
  { code: 'MT', name: 'Montana', capital: 'Helena' },
  { code: 'NE', name: 'Nebraska', capital: 'Lincoln' },
  { code: 'NV', name: 'Nevada', capital: 'Carson City' },
  { code: 'NH', name: 'New Hampshire', capital: 'Concord' },
  { code: 'NJ', name: 'New Jersey', capital: 'Trenton' },
  { code: 'NM', name: 'New Mexico', capital: 'Santa Fe' },
  { code: 'NY', name: 'New York', capital: 'Albany' },
  { code: 'NC', name: 'North Carolina', capital: 'Raleigh' },
  { code: 'ND', name: 'North Dakota', capital: 'Bismarck' },
  { code: 'OH', name: 'Ohio', capital: 'Columbus' },
  { code: 'OK', name: 'Oklahoma', capital: 'Oklahoma City' },
  { code: 'OR', name: 'Oregon', capital: 'Salem' },
  { code: 'PA', name: 'Pennsylvania', capital: 'Harrisburg' },
  { code: 'RI', name: 'Rhode Island', capital: 'Providence' },
  { code: 'SC', name: 'South Carolina', capital: 'Columbia' },
  { code: 'SD', name: 'South Dakota', capital: 'Pierre' },
  { code: 'TN', name: 'Tennessee', capital: 'Nashville' },
  { code: 'TX', name: 'Texas', capital: 'Austin' },
  { code: 'UT', name: 'Utah', capital: 'Salt Lake City' },
  { code: 'VT', name: 'Vermont', capital: 'Montpelier' },
  { code: 'VA', name: 'Virginia', capital: 'Richmond' },
  { code: 'WA', name: 'Washington', capital: 'Olympia' },
  { code: 'WV', name: 'West Virginia', capital: 'Charleston' },
  { code: 'WI', name: 'Wisconsin', capital: 'Madison' },
  { code: 'WY', name: 'Wyoming', capital: 'Cheyenne' },
]

/** Invented names with the place in them, so they read as made up and rarely match a real firm. */
function inventedRegion(label: string, city: string | null, state: string, placeOfPerformance: string): UsRegion {
  return {
    city,
    state,
    placeOfPerformance,
    clients: [`${label} Ridgeline Technologies`, `${label} Crosspoint Logistics`, `${label} Stonegate Facility Care`],
    partners: [`${label} Ridgeline Cyber`, `${label} Crosspoint Networks`],
  }
}

export function regionForState(code: string): UsRegion | null {
  const named = US_REGIONS.find((region) => region.state === code)
  if (named) return named
  const state = US_STATES.find((option) => option.code === code)
  if (!state) return null
  return inventedRegion(code === 'DC' ? 'DC' : state.name, state.capital, state.code, `${state.capital}, ${state.code}`)
}

/** A place typed in under "Other", such as a US territory. */
export function regionForOtherLocation(location: string): UsRegion {
  return inventedRegion(location, null, location, location)
}

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

// Work already in progress, so the pipeline starts as it would for a real firm. These
// are extra to the opportunities above, which stay off it until someone opens them.
const PIPELINE_OPPORTUNITIES = [
  { pipelineStage: 'IDENTIFIED', priority: 'MEDIUM', nextAction: 'Review the solicitation and decide whether to qualify', nextActionDays: 3, title: 'Cloud Security Posture Assessment', agency: 'Department of Energy', naicsCode: '541512', setAsideType: 'SDVOSB', value: 2_600_000, days: 44, client: 0, incumbentProbability: 0.4, offersReceived: 5, agencySdvosbRate: 0.18, historicalAwardCount: 300, documentIntelScore: 0.7, description: 'Assess cloud security controls across agency workloads and recommend a prioritized remediation plan.' },
  { pipelineStage: 'QUALIFICATION', priority: 'MEDIUM', nextAction: 'Complete the bid scorecard', nextActionDays: 5, title: 'Regional Courier and Distribution Services', agency: 'Department of Veterans Affairs', naicsCode: '484121', setAsideType: 'WOSB', value: 1_350_000, days: 38, client: 1, incumbentProbability: 0.4, offersReceived: 4, agencySdvosbRate: 0.3, historicalAwardCount: 240, documentIntelScore: 0.65, description: 'Scheduled courier and distribution routes between regional medical centers and clinics.' },
  { pipelineStage: 'CAPTURE', priority: 'HIGH', nextAction: 'Confirm teaming partner and site visit date', nextActionDays: 7, title: 'Federal Campus Custodial Services', agency: 'General Services Administration', naicsCode: '561720', setAsideType: 'HUBZONE', value: 1_900_000, days: 52, client: 2, incumbentProbability: 0.35, offersReceived: 5, agencySdvosbRate: 0.12, historicalAwardCount: 280, documentIntelScore: 0.65, description: 'Custodial and grounds services for a multi-building federal campus.' },
  { pipelineStage: 'PROPOSAL', priority: 'CRITICAL', nextAction: 'Finish the technical approach for review', nextActionDays: 4, title: 'Security Operations Center Support', agency: 'Department of the Treasury', naicsCode: '541519', setAsideType: 'SDVOSB', value: 5_400_000, days: 26, client: 0, incumbentProbability: 0.45, offersReceived: 4, agencySdvosbRate: 0.2, historicalAwardCount: 380, documentIntelScore: 0.75, description: 'Round-the-clock monitoring, incident response and reporting for a federal security operations center.' },
] as const

const PROPOSAL_SECTIONS = [
  { title: 'Technical Approach', draft: 'Our approach begins with a two-week discovery of the current environment, followed by a phased roadmap agreed with the program office.' },
  { title: 'Management Plan', draft: 'A named program manager is the single point of accountability, supported by weekly status reporting and a shared risk register.' },
  { title: 'Past Performance', draft: null },
]

type SampleOpportunity = (typeof OPPORTUNITIES)[number] | (typeof PIPELINE_OPPORTUNITIES)[number]

/** Scores aren't written by hand: the engine works them out, as it does for real ones. */
async function createScoredOpportunity(consultingFirmId: string, sample: SampleOpportunity, client: ClientCompany, placeOfPerformance: string | null) {
  const { title, agency, naicsCode, setAsideType, value, days, incumbentProbability, offersReceived, agencySdvosbRate, historicalAwardCount, documentIntelScore, description } = sample
  const opportunity = await prisma.opportunity.create({
    data: {
      title, agency, naicsCode, setAsideType, incumbentProbability, offersReceived, agencySdvosbRate, historicalAwardCount, documentIntelScore, description,
      placeOfPerformance,
      consultingFirmId,
      samNoticeId: `DEMO-${randomUUID()}`,
      status: 'ACTIVE',
      isDemo: false,
      estimatedValue: new Prisma.Decimal(value),
      postedDate: new Date(Date.now() - 7 * DAY),
      responseDeadline: inDays(days),
    },
  })
  const scored = scoreOpportunityForClient(await buildScoringInputs(opportunity, client))
  if (scored.status !== 'OK') throw new Error(`Sample opportunity could not be scored: ${scored.failureReason}`)
  await prisma.opportunity.update({
    where: { id: opportunity.id },
    data: {
      isScored: true,
      probabilityScore: scored.probability,
      expectedValue: new Prisma.Decimal(Math.round(value * scored.probability)),
    },
  })
  await evaluateBidDecision(opportunity.id, client.id)
  return opportunity
}

async function seedProposal(consultingFirmId: string, ownerUserId: string, opportunity: { id: string; title: string }): Promise<void> {
  const proposal = await prisma.proposal.create({
    data: { consultingFirmId, opportunityId: opportunity.id, title: `Proposal: ${opportunity.title}`, createdByUserId: ownerUserId },
  })
  for (const section of PROPOSAL_SECTIONS) {
    await prisma.proposalSection.create({
      data: { consultingFirmId, opportunityId: opportunity.id, proposalId: proposal.id, title: section.title, draft: section.draft, status: 'DRAFTING' },
    })
  }
  await seedComplianceMatrix(consultingFirmId, ownerUserId, opportunity.id)
}

/** Adds whichever in-progress pursuits an account lacks, so it's safe to repeat. */
export async function ensureSamplePipeline(consultingFirmId: string, ownerUserId: string, clients: ClientCompany[], placeOfPerformance: string | null): Promise<void> {
  for (const sample of PIPELINE_OPPORTUNITIES) {
    if (await prisma.opportunity.findFirst({ where: { consultingFirmId, title: sample.title }, select: { id: true } })) continue
    const opportunity = await createScoredOpportunity(consultingFirmId, sample, clients[sample.client], placeOfPerformance)
    await prisma.bidPursuit.create({
      data: {
        consultingFirmId,
        opportunityId: opportunity.id,
        ownerUserId,
        pipelineStage: sample.pipelineStage,
        priority: sample.priority,
        nextAction: sample.nextAction,
        nextActionDueAt: inDays(sample.nextActionDays),
      },
    })
    if (sample.pipelineStage === 'PROPOSAL') await seedProposal(consultingFirmId, ownerUserId, opportunity)
  }
}

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
  for (const sample of OPPORTUNITIES) {
    opportunities.push(await createScoredOpportunity(consultingFirmId, sample, clients[sample.client], region.placeOfPerformance))
  }
  const zeroTrust = opportunities[0]
  await seedProposal(consultingFirmId, ownerUserId, zeroTrust)
  await ensureSamplePipeline(consultingFirmId, ownerUserId, clients, region.placeOfPerformance)

  const partner = await prisma.partner.create({ data: { consultingFirmId, name: region.partners[0] } })
  await prisma.partner.create({ data: { consultingFirmId, name: region.partners[1] } })

  await seedDemoWork({ consultingFirmId, ownerUserId, clients, proposalOpportunityId: zeroTrust.id, partnerId: partner.id, placeOfPerformance: region.placeOfPerformance })
}
