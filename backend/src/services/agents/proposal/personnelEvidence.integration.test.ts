// =============================================================
// §8.4 — Personnel evidence for the Proposal Agent.
//
// The subject of these tests is what the agent is ALLOWED TO SEE. Every
// prohibition in the prompt is a request; the guarantee is that unapproved and
// unverified material never reaches the model at all, and that is what is
// asserted here — on the payload, not on generated prose.
// =============================================================
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { prisma } from '../../../config/database'
import { createTestFirm, createTestUser, cleanupFirm, disconnectDb, TestFirm, TestUser } from '../../../test-utils/testClient'
import { buildKeyPersonnelEvidence, PERSONNEL_EVIDENCE_RULE } from './personnelEvidence'
import { buildDeterministicSkeleton, parseSectionDraft, sectionUserPayload, type SectionDraftFacts } from './proposalDrafts'

let firmA: TestFirm, firmB: TestFirm
let adminA: TestUser
let proposalA = '', proposalEmpty = '', proposalB = ''

async function makeProposal(firm: TestFirm, title: string) {
  const opp = await prisma.opportunity.create({
    data: {
      consultingFirmId: firm.id, title: `${title} opp`, agency: 'DEPT OF TEST',
      responseDeadline: new Date(Date.now() + 30 * 86400000),
    },
    select: { id: true },
  })
  const p = await prisma.proposal.create({
    data: { consultingFirmId: firm.id, opportunityId: opp.id, title }, select: { id: true },
  })
  return p.id
}

async function makePerson(firm: TestFirm, first: string, last: string, over: Record<string, unknown> = {}) {
  return prisma.personnel.create({
    data: { consultingFirmId: firm.id, firstName: first, lastName: last, ...over }, select: { id: true },
  })
}

async function select(firm: TestFirm, proposalId: string, personnelId: string, resumeId: string | null, role: string) {
  return prisma.proposalKeyPersonnel.create({
    data: { consultingFirmId: firm.id, proposalId, personnelId, resumeId, proposalRole: role }, select: { id: true },
  })
}

const facts = (over: Partial<SectionDraftFacts> = {}): SectionDraftFacts => ({
  sectionId: 'sec-1', sectionTitle: 'Key Personnel', sectionNumber: 'L.3',
  requirements: [], lmMappings: [], capabilitySources: [], pastPerformance: [],
  keyPersonnel: [], lockedContent: null, existingDraft: null, ...over,
})

beforeAll(async () => {
  firmA = await createTestFirm({ name: 'PE Firm A' })
  firmB = await createTestFirm({ name: 'PE Firm B' })
  adminA = await createTestUser(firmA.id, { role: 'ADMIN' })
  proposalA = await makeProposal(firmA, 'PE Proposal A')
  proposalEmpty = await makeProposal(firmA, 'PE Proposal Empty')
  proposalB = await makeProposal(firmB, 'PE Proposal B')
})

afterAll(async () => {
  await cleanupFirm(firmA.id)
  await cleanupFirm(firmB.id)
  await disconnectDb()
})

describe('§8.4 evidence assembly', () => {
  it('returns nothing when nobody was selected', async () => {
    expect(await buildKeyPersonnelEvidence(firmA.id, proposalEmpty)).toEqual([])
  })

  it('reports a selected person with no approved resume as having no evidence', async () => {
    const person = await makePerson(firmA, 'Noah', 'Draftonly', { jobTitle: 'Senior Cyber Analyst' })
    await prisma.personnelResume.create({
      data: {
        consultingFirmId: firmA.id, personnelId: person.id, versionNumber: 1, status: 'DRAFT',
        content: { certifications: ['CISSP-FROM-A-DRAFT'], education: 'PhD-FROM-A-DRAFT' },
      },
    })
    await select(firmA, proposalA, person.id, null, 'Analyst')

    const [entry] = (await buildKeyPersonnelEvidence(firmA.id, proposalA)).filter((e) => e.personnelId === person.id)
    expect(entry.hasApprovedResume).toBe(false)
    expect(entry.approvedResumeContent).toBeNull()
    // The draft's contents are simply not present to be quoted.
    expect(JSON.stringify(entry)).not.toContain('CISSP-FROM-A-DRAFT')
    expect(JSON.stringify(entry)).not.toContain('PhD-FROM-A-DRAFT')
    expect(entry.missingEvidence.join(' ')).toMatch(/no approved resume/i)
    // A job title containing "Senior Cyber Analyst" yields no qualification.
    expect(entry.verifiedLaborQualifications).toEqual([])
    expect(entry.yearsExperienceStated).toBeNull()
  })

  it('supplies an approved resume and only VERIFIED qualifications', async () => {
    const person = await makePerson(firmA, 'Vera', 'Verified', { yearsExperience: 9 })
    const approved = await prisma.personnelResume.create({
      data: {
        consultingFirmId: firmA.id, personnelId: person.id, versionNumber: 1, status: 'APPROVED',
        approvedAt: new Date(), content: { summary: 'APPROVED-SUMMARY-TEXT' },
      },
      select: { id: true },
    })
    await prisma.personnelLaborQualification.create({
      data: {
        consultingFirmId: firmA.id, personnelId: person.id, laborCategory: 'Systems Engineer',
        verification: 'VERIFIED', yearsExperience: 7, evidence: 'Reviewed employment letter',
      },
    })
    await prisma.personnelLaborQualification.create({
      data: {
        consultingFirmId: firmA.id, personnelId: person.id, laborCategory: 'UNVERIFIED-CATEGORY',
        verification: 'UNVERIFIED', evidence: 'UNVERIFIED-EVIDENCE-TEXT',
      },
    })
    await prisma.personnelLaborQualification.create({
      data: {
        consultingFirmId: firmA.id, personnelId: person.id, laborCategory: 'REJECTED-CATEGORY',
        verification: 'REJECTED',
      },
    })
    await select(firmA, proposalA, person.id, approved.id, 'Lead Engineer')

    const [entry] = (await buildKeyPersonnelEvidence(firmA.id, proposalA)).filter((e) => e.personnelId === person.id)
    expect(entry.hasApprovedResume).toBe(true)
    expect(entry.approvedResumeContent).toEqual({ summary: 'APPROVED-SUMMARY-TEXT' })
    expect(entry.verifiedLaborQualifications.map((q) => q.laborCategory)).toEqual(['Systems Engineer'])
    expect(JSON.stringify(entry)).not.toContain('UNVERIFIED-CATEGORY')
    expect(JSON.stringify(entry)).not.toContain('UNVERIFIED-EVIDENCE-TEXT')
    expect(JSON.stringify(entry)).not.toContain('REJECTED-CATEGORY')
    expect(entry.yearsExperienceStated).toBe(9)
    expect(entry.verifiedLaborQualifications[0].yearsExperienceStated).toBe(7)
  })

  it('never derives years of experience from dates', async () => {
    const person = await makePerson(firmA, 'Dana', 'Dateless')
    const approved = await prisma.personnelResume.create({
      data: {
        consultingFirmId: firmA.id, personnelId: person.id, versionNumber: 1, status: 'APPROVED',
        approvedAt: new Date(), content: { employment: [{ from: '2005-01-01', to: '2026-01-01' }] },
      },
      select: { id: true },
    })
    await prisma.personnelLaborQualification.create({
      data: {
        consultingFirmId: firmA.id, personnelId: person.id, laborCategory: 'Analyst', verification: 'VERIFIED',
        effectiveDate: new Date('2005-01-01'), expirationDate: new Date('2030-01-01'),
      },
    })
    await select(firmA, proposalA, person.id, approved.id, 'Analyst')

    const [entry] = (await buildKeyPersonnelEvidence(firmA.id, proposalA)).filter((e) => e.personnelId === person.id)
    expect(entry.yearsExperienceStated).toBeNull()
    expect(entry.verifiedLaborQualifications[0].yearsExperienceStated).toBeNull()
    expect(entry.missingEvidence.join(' ')).toMatch(/no years-of-experience figure/i)
  })

  it('treats a superseded resume as no evidence', async () => {
    const person = await makePerson(firmA, 'Sam', 'Superseded')
    const old = await prisma.personnelResume.create({
      data: {
        consultingFirmId: firmA.id, personnelId: person.id, versionNumber: 1, status: 'SUPERSEDED',
        supersededAt: new Date(), content: { summary: 'SUPERSEDED-CONTENT' },
      },
      select: { id: true },
    })
    await select(firmA, proposalA, person.id, old.id, 'Analyst')
    const [entry] = (await buildKeyPersonnelEvidence(firmA.id, proposalA)).filter((e) => e.personnelId === person.id)
    expect(entry.hasApprovedResume).toBe(false)
    expect(JSON.stringify(entry)).not.toContain('SUPERSEDED-CONTENT')
  })

  it('drops an archived person entirely', async () => {
    const person = await makePerson(firmA, 'Arch', 'Ived', { isArchived: true })
    await prisma.personnelResume.create({
      data: {
        consultingFirmId: firmA.id, personnelId: person.id, versionNumber: 1, status: 'APPROVED',
        approvedAt: new Date(), content: { summary: 'ARCHIVED-PERSON-CONTENT' },
      },
    })
    await select(firmA, proposalA, person.id, null, 'Analyst')
    const all = await buildKeyPersonnelEvidence(firmA.id, proposalA)
    expect(all.some((e) => e.personnelId === person.id)).toBe(false)
    expect(JSON.stringify(all)).not.toContain('ARCHIVED-PERSON-CONTENT')
  })

  it('reaches no other tenant, even for a proposal id that exists', async () => {
    const person = await makePerson(firmB, 'Bee', 'Other')
    const approved = await prisma.personnelResume.create({
      data: {
        consultingFirmId: firmB.id, personnelId: person.id, versionNumber: 1, status: 'APPROVED',
        approvedAt: new Date(), content: { summary: 'FIRM-B-ONLY-CONTENT' },
      },
      select: { id: true },
    })
    await select(firmB, proposalB, person.id, approved.id, 'Analyst')
    expect(await buildKeyPersonnelEvidence(firmA.id, proposalB)).toEqual([])
    const own = await buildKeyPersonnelEvidence(firmB.id, proposalB)
    expect(own).toHaveLength(1)
    expect(JSON.stringify(await buildKeyPersonnelEvidence(firmA.id, proposalA))).not.toContain('FIRM-B-ONLY-CONTENT')
  })
})

describe('§8.4 evidence in the drafting payload', () => {
  it('carries the personnel rule and the evidence verbatim', async () => {
    const evidence = await buildKeyPersonnelEvidence(firmA.id, proposalA)
    const payload = sectionUserPayload(facts({ keyPersonnel: evidence }))
    expect(payload.keyPersonnelEvidenceRule).toBe(PERSONNEL_EVIDENCE_RULE)
    expect(String(payload.keyPersonnelEvidenceRule)).toMatch(/must not be written, implied or inferred/i)
    expect(payload.keyPersonnel).toEqual(evidence)
  })

  it('discards a citation naming a person who was never supplied', () => {
    const supplied = facts({
      keyPersonnel: [{
        id: 'sel-1', personnelId: 'p-1', fullName: 'Real Person', proposalRole: null, laborCategory: null,
        hasApprovedResume: true, approvedResumeId: 'r-1', approvedResumeVersion: 1,
        approvedResumeContent: { summary: 'ok' }, yearsExperienceStated: 5,
        verifiedLaborQualifications: [], missingEvidence: [],
      }],
    })
    const fallback = buildDeterministicSkeleton(supplied)
    const { draft, warnings } = parseSectionDraft(JSON.stringify({
      sectionId: 'sec-1',
      content: 'Our proposed lead holds a CISSP.',
      citations: [
        { sourceType: 'OTHER_SUPPLIED_SOURCE', sourceId: 'sel-1', sourceReference: null, supportedClaim: 'Named key person' },
        { sourceType: 'OTHER_SUPPLIED_SOURCE', sourceId: 'sel-INVENTED', sourceReference: null, supportedClaim: 'Invented person' },
      ],
      insufficientSourceMaterial: false,
    }), supplied, fallback)

    expect(draft.citations.map((c) => c.sourceId)).toEqual(['sel-1'])
    expect(warnings.join(' ')).toMatch(/not supplied/i)
    // A discarded citation overrides the model's own claim of sufficiency.
    expect(draft.insufficientSourceMaterial).toBe(true)
  })

  it('marks a person without an approved resume in the deterministic skeleton', () => {
    const skeleton = buildDeterministicSkeleton(facts({
      keyPersonnel: [{
        id: 'sel-2', personnelId: 'p-2', fullName: 'No Evidence', proposalRole: 'Lead', laborCategory: null,
        hasApprovedResume: false, approvedResumeId: null, approvedResumeVersion: null,
        approvedResumeContent: null, yearsExperienceStated: null,
        verifiedLaborQualifications: [], missingEvidence: ['No approved resume version exists for this person.'],
      }],
    }))
    expect(skeleton.content).toContain('NO APPROVED RESUME')
    expect(skeleton.source).toBe('DETERMINISTIC_SKELETON')
    expect(skeleton.insufficientSourceMaterial).toBe(true)
    expect(skeleton.citations).toEqual([])
  })
})
