// =============================================================
// What a new demo account starts with, so every screen has something to show.
//
// Everything is invented and belongs to that one firm, so one client's changes
// never reach another. Records aren't flagged isDemo, because the app hides
// those rows from its normal lists.
// =============================================================
import { randomUUID } from 'crypto'
import { AccountType, Prisma, type ClientCompany } from '@prisma/client'
import { prisma } from '../config/database'
import { scoreOpportunityForClient } from '../engines/probabilityEngine'
import { evaluateBidDecision } from './decisionEngine'
import { buildScoringInputs } from './scoring/scoringInputs'
import { seedComplianceMatrix, seedDemoWork } from './demoSampleWork'
import { businessTypeByKey, DEFAULT_BUSINESS_TYPE, type DemoBusinessType } from './demoBusinessTypes'

const DAY = 86_400_000
const inDays = (n: number) => new Date(Date.now() + n * DAY)

// Invented names for a place. The business type supplies the rest of each company's
// name, such as Potomac Ridge Technologies or Potomac Ridge Builders.
export interface UsRegion {
  city: string | null
  state: string
  placeOfPerformance: string
  clientPrefixes: [string, string, string]
  partnerPrefixes: [string, string]
}

export const US_REGIONS: UsRegion[] = [
  { city: 'Arlington', state: 'VA', placeOfPerformance: 'Washington, DC', clientPrefixes: ['Potomac Ridge', 'Rappahannock Route', 'Chesapeake Shoreline'], partnerPrefixes: ['Blue Ridge', 'Shenandoah'] },
  { city: 'San Antonio', state: 'TX', placeOfPerformance: 'San Antonio, TX', clientPrefixes: ['Riverwalk', 'Gulf Plains', 'Hill Country'], partnerPrefixes: ['Brazos', 'Pecos'] },
  { city: 'San Diego', state: 'CA', placeOfPerformance: 'San Diego, CA', clientPrefixes: ['Harbor Point', 'Point Loma', 'Mission Bay'], partnerPrefixes: ['Sierra', 'Cascade'] },
  { city: 'Chicago', state: 'IL', placeOfPerformance: 'Chicago, IL', clientPrefixes: ['Lakeshore', 'Prairie Route', 'Windy City'], partnerPrefixes: ['Midland', 'Great Plains'] },
  { city: 'Atlanta', state: 'GA', placeOfPerformance: 'Atlanta, GA', clientPrefixes: ['Peachtree', 'Southern Crossing', 'Magnolia'], partnerPrefixes: ['Chattahoochee', 'Piedmont'] },
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

/** Names with the place in them, so they read as made up and rarely match a real firm. */
function inventedRegion(label: string, city: string | null, state: string, placeOfPerformance: string): UsRegion {
  return {
    city,
    state,
    placeOfPerformance,
    clientPrefixes: [`${label} Ridgeline`, `${label} Crosspoint`, `${label} Stonegate`],
    partnerPrefixes: [`${label} Ridgeline`, `${label} Crosspoint`],
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
  { sdvosb: true, smallBusiness: true },
  { smallBusiness: true, wosb: true },
  { smallBusiness: true, hubzone: true },
]

// The signals the scoring engine reads, by position in a business type's opportunity
// list. Scores aren't written by hand: the engine works them out from these.
const OPPORTUNITY_SIGNALS = [
  { setAsideType: 'SDVOSB', value: 4_200_000, days: 34, client: 0, incumbentProbability: 0.3, offersReceived: 4, agencySdvosbRate: 0.22, historicalAwardCount: 420, documentIntelScore: 0.8 },
  { setAsideType: 'SDVOSB', value: 8_750_000, days: 48, client: 0, incumbentProbability: 0.55, offersReceived: 6, agencySdvosbRate: 0.3, historicalAwardCount: 610, documentIntelScore: 0.6 },
  { setAsideType: 'NONE', value: 12_400_000, days: 62, client: 0, incumbentProbability: 0.7, offersReceived: 9, agencySdvosbRate: 0.05, historicalAwardCount: 300, documentIntelScore: 0.45 },
  { setAsideType: 'WOSB', value: 1_850_000, days: 21, client: 1, incumbentProbability: 0.35, offersReceived: 3, agencySdvosbRate: 0.3, historicalAwardCount: 150, documentIntelScore: 0.75 },
  { setAsideType: 'SBA', value: 3_100_000, days: 40, client: 1, incumbentProbability: 0.6, offersReceived: 7, agencySdvosbRate: 0.12, historicalAwardCount: 220, documentIntelScore: 0.5 },
  { setAsideType: 'HUBZONE', value: 960_000, days: 15, client: 2, incumbentProbability: 0.25, offersReceived: 5, agencySdvosbRate: 0.12, historicalAwardCount: 500, documentIntelScore: 0.7 },
  { setAsideType: 'SBA', value: 5_600_000, days: 55, client: 2, incumbentProbability: 0.65, offersReceived: 8, agencySdvosbRate: 0.08, historicalAwardCount: 350, documentIntelScore: 0.4 },
  { setAsideType: 'NONE', value: 22_000_000, days: 75, client: 0, incumbentProbability: 0.9, offersReceived: 2, agencySdvosbRate: 0.04, historicalAwardCount: 90, documentIntelScore: 0.25 },
  { setAsideType: 'SBA', value: 2_750_000, days: 29, client: 1, incumbentProbability: 0.45, offersReceived: 5, agencySdvosbRate: 0.15, historicalAwardCount: 260, documentIntelScore: 0.55 },
  { setAsideType: 'SDVOSB', value: 1_600_000, days: 37, client: 0, incumbentProbability: 0.5, offersReceived: 4, agencySdvosbRate: 0.25, historicalAwardCount: 330, documentIntelScore: 0.6 },
  { setAsideType: 'HUBZONE', value: 1_250_000, days: 23, client: 2, incumbentProbability: 0.3, offersReceived: 6, agencySdvosbRate: 0.1, historicalAwardCount: 410, documentIntelScore: 0.65 },
  { setAsideType: 'NONE', value: 9_800_000, days: 66, client: 0, incumbentProbability: 0.75, offersReceived: 8, agencySdvosbRate: 0.06, historicalAwardCount: 180, documentIntelScore: 0.4 },
  { setAsideType: 'WOSB', value: 2_200_000, days: 31, client: 1, incumbentProbability: 0.4, offersReceived: 4, agencySdvosbRate: 0.28, historicalAwardCount: 170, documentIntelScore: 0.7 },
  { setAsideType: 'SBA', value: 4_400_000, days: 50, client: 2, incumbentProbability: 0.6, offersReceived: 7, agencySdvosbRate: 0.09, historicalAwardCount: 290, documentIntelScore: 0.45 },
  { setAsideType: 'SDVOSB', value: 3_300_000, days: 42, client: 0, incumbentProbability: 0.35, offersReceived: 5, agencySdvosbRate: 0.2, historicalAwardCount: 380, documentIntelScore: 0.7 },
  { setAsideType: 'NONE', value: 15_000_000, days: 80, client: 1, incumbentProbability: 0.85, offersReceived: 3, agencySdvosbRate: 0.05, historicalAwardCount: 120, documentIntelScore: 0.3 },
  // Work already in progress, so the pipeline starts as it would for a real firm.
  { pipeline: { stage: 'IDENTIFIED', priority: 'MEDIUM', nextAction: 'Review the solicitation and decide whether to qualify', days: 3 }, setAsideType: 'SDVOSB', value: 2_600_000, days: 44, client: 0, incumbentProbability: 0.4, offersReceived: 5, agencySdvosbRate: 0.18, historicalAwardCount: 300, documentIntelScore: 0.7 },
  { pipeline: { stage: 'QUALIFICATION', priority: 'MEDIUM', nextAction: 'Complete the bid scorecard', days: 5 }, setAsideType: 'WOSB', value: 1_350_000, days: 38, client: 1, incumbentProbability: 0.4, offersReceived: 4, agencySdvosbRate: 0.3, historicalAwardCount: 240, documentIntelScore: 0.65 },
  { pipeline: { stage: 'CAPTURE', priority: 'HIGH', nextAction: 'Confirm teaming partner and site visit date', days: 7 }, setAsideType: 'HUBZONE', value: 1_900_000, days: 52, client: 2, incumbentProbability: 0.35, offersReceived: 5, agencySdvosbRate: 0.12, historicalAwardCount: 280, documentIntelScore: 0.65 },
  { pipeline: { stage: 'PROPOSAL', priority: 'CRITICAL', nextAction: 'Finish the technical approach for review', days: 4 }, setAsideType: 'SDVOSB', value: 5_400_000, days: 26, client: 0, incumbentProbability: 0.45, offersReceived: 4, agencySdvosbRate: 0.2, historicalAwardCount: 380, documentIntelScore: 0.75 },
] as const

const PROPOSAL_SECTIONS = [
  { title: 'Technical Approach', draft: 'Our approach begins with a two-week discovery of the current environment, followed by a phased plan agreed with the program office.' },
  { title: 'Management Plan', draft: 'A named program manager is the single point of accountability, supported by weekly status reporting and a shared risk register.' },
  { title: 'Past Performance', draft: null },
]

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

/** One invented notice, scored by the real engine, so re-scoring lands on the same numbers. */
async function createInventedOpportunity(consultingFirmId: string, type: DemoBusinessType, clients: ClientCompany[], placeOfPerformance: string | null, index: number) {
  const signals = OPPORTUNITY_SIGNALS[index]
  const { value, days, client, setAsideType, incumbentProbability, offersReceived, agencySdvosbRate, historicalAwardCount, documentIntelScore } = signals
  const agency = type.agencies[index % type.agencies.length]
  const title = type.opportunities[index]
  const opportunity = await prisma.opportunity.create({
    data: {
      title, agency, setAsideType, incumbentProbability, offersReceived, agencySdvosbRate, historicalAwardCount, documentIntelScore,
      naicsCode: type.naicsCodes[client],
      description: `${title} for the ${agency}, with regular reporting to the program office.`,
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
  const scored = scoreOpportunityForClient(await buildScoringInputs(opportunity, clients[client]))
  if (scored.status !== 'OK') throw new Error(`Sample opportunity could not be scored: ${scored.failureReason}`)
  await prisma.opportunity.update({
    where: { id: opportunity.id },
    data: { isScored: true, probabilityScore: scored.probability, expectedValue: new Prisma.Decimal(Math.round(value * scored.probability)) },
  })
  await evaluateBidDecision(opportunity.id, clients[client].id)
  return opportunity
}

/**
 * Adds invented open notices to an account that has fewer than it should, using
 * titles it doesn't already have. Returns how many were added.
 */
export async function inventOpenNotices(consultingFirmId: string, count: number): Promise<number> {
  if (count <= 0) return 0
  const firm = await prisma.consultingFirm.findUnique({ where: { id: consultingFirmId }, select: { demoBusinessType: true, accountType: true } })
  const type = businessTypeByKey(firm?.demoBusinessType)
  let clients = await prisma.clientCompany.findMany({ where: { consultingFirmId }, orderBy: { createdAt: 'asc' } })
  // A contractor's own company stands in for each of the three sample clients.
  if (firm?.accountType === AccountType.CONTRACTOR) {
    const self = clients.find((c) => c.isSelf)
    clients = self ? [self, self, self] : []
  }
  if (!type || clients.length < 3) return 0
  const used = new Set((await prisma.opportunity.findMany({ where: { consultingFirmId }, select: { title: true } })).map((o) => o.title))
  const placed = await prisma.opportunity.findFirst({ where: { consultingFirmId, placeOfPerformance: { not: null } }, select: { placeOfPerformance: true } })
  let added = 0
  for (const [index, signals] of OPPORTUNITY_SIGNALS.entries()) {
    if (added >= count) break
    if ('pipeline' in signals || used.has(type.opportunities[index])) continue
    await createInventedOpportunity(consultingFirmId, type, clients, placed?.placeOfPerformance ?? null, index)
    added++
  }
  return added
}

export async function seedDemoSampleData(consultingFirmId: string, ownerUserId: string, region: UsRegion = US_REGIONS[0], type: DemoBusinessType = DEFAULT_BUSINESS_TYPE): Promise<void> {
  const firm = await prisma.consultingFirm.findUnique({ where: { id: consultingFirmId }, select: { name: true, accountType: true } })
  const contractor = firm?.accountType === AccountType.CONTRACTOR
  const clients: ClientCompany[] = []
  if (contractor && firm) {
    // A contractor bids for itself: one own-company record, matched by a
    // registration profile, stands in for every sample client below.
    const uei = `DEMO${randomUUID().replace(/-/g, '').slice(0, 8).toUpperCase()}`
    await prisma.registrationProfile.create({
      data: { consultingFirmId, samStatus: 'ACTIVE', samExpiryDate: inDays(300), uei, naicsCodes: type.naicsCodes, setAsideCerts: ['SDVOSB'] },
    })
    const self = await prisma.clientCompany.create({
      data: { ...CLIENT_PROFILES[0], naicsCodes: type.naicsCodes, name: firm.name, city: region.city, state: region.state, uei, samRegStatus: 'Active', samRegExpiry: inDays(300), isSelf: true, consultingFirmId },
    })
    clients.push(self, self, self)
  } else {
    for (const [index, profile] of CLIENT_PROFILES.entries()) {
      clients.push(await prisma.clientCompany.create({
        data: {
          ...profile,
          naicsCodes: [type.naicsCodes[index], type.naicsCodes[(index + 1) % type.naicsCodes.length]],
          name: `${region.clientPrefixes[index]} ${type.clientSuffixes[index]}`,
          city: region.city,
          state: region.state,
          uei: `DEMO${randomUUID().replace(/-/g, '').slice(0, 8).toUpperCase()}`,
          consultingFirmId,
        },
      }))
    }
  }

  const opportunities = []
  for (const [index, signals] of OPPORTUNITY_SIGNALS.entries()) {
    const opportunity = await createInventedOpportunity(consultingFirmId, type, clients, region.placeOfPerformance, index)
    opportunities.push(opportunity)
    if ('pipeline' in signals) {
      await prisma.bidPursuit.create({
        data: {
          consultingFirmId,
          opportunityId: opportunity.id,
          ownerUserId,
          pipelineStage: signals.pipeline.stage,
          priority: signals.pipeline.priority,
          nextAction: signals.pipeline.nextAction,
          nextActionDueAt: inDays(signals.pipeline.days),
        },
      })
      if (signals.pipeline.stage === 'PROPOSAL') await seedProposal(consultingFirmId, ownerUserId, opportunity)
    }
  }
  await seedProposal(consultingFirmId, ownerUserId, opportunities[0])

  const partner = await prisma.partner.create({ data: { consultingFirmId, name: `${region.partnerPrefixes[0]} ${type.partnerSuffixes[0]}` } })
  await prisma.partner.create({ data: { consultingFirmId, name: `${region.partnerPrefixes[1]} ${type.partnerSuffixes[1]}` } })

  await seedDemoWork({ consultingFirmId, ownerUserId, clients, proposalOpportunity: opportunities[0], partnerId: partner.id, placeOfPerformance: region.placeOfPerformance, type, contractor })
}
