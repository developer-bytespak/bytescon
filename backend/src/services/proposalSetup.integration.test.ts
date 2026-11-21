// A new proposal sets itself up: requirements (when it has none) and then its
// first sections, from verified requirements, else the unverified ones (marked),
// else the standard sections. Work already there is never replaced.
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { prisma } from '../config/database'
import { createTestFirm, cleanupFirm, disconnectDb, TestFirm } from '../test-utils/testClient'
import { setUpProposal, UNVERIFIED_OUTLINE_NOTE } from './proposalSetup'
import { STANDARD_OUTLINE } from './proposalSectionDraft'

let firm: TestFirm
// No plan and no tokens: the set-up can't have the AI read requirements.
let broke: TestFirm

beforeAll(async () => {
  firm = await createTestFirm()
  broke = await createTestFirm({ plan: 'none' })
  await prisma.consultingFirm.update({ where: { id: broke.id }, data: { proposalTokens: 0 } })
})
afterAll(async () => {
  await cleanupFirm(firm.id)
  await cleanupFirm(broke.id)
  await disconnectDb()
})

async function start(requirements: { text: string; section: string; status: string }[] = [], owner: TestFirm = firm) {
  const opp = await prisma.opportunity.create({
    data: { consultingFirmId: owner.id, title: 'Roof replacement', agency: 'GSA', naicsCode: '238160', responseDeadline: new Date(Date.now() + 30 * 86400000) },
  })
  if (requirements.length) {
    const matrix = await prisma.complianceMatrix.create({ data: { opportunityId: opp.id, consultingFirmId: owner.id } })
    await prisma.matrixRequirement.createMany({
      data: requirements.map((r, i) => ({ matrixId: matrix.id, section: 'L', requirementText: r.text, proposalSection: r.section, verificationStatus: r.status, sortOrder: i })),
    })
  }
  const proposal = await prisma.proposal.create({ data: { consultingFirmId: owner.id, opportunityId: opp.id, title: opp.title, setupStatus: 'PREPARING' } })
  return { opp, proposal }
}

const sectionsOf = (proposalId: string) => prisma.proposalSection.findMany({ where: { proposalId }, orderBy: { sortOrder: 'asc' } })

describe('setUpProposal', () => {
  it('builds the sections from the verified requirements when there are some', async () => {
    const { proposal } = await start([
      { text: 'Describe the roofing method.', section: 'Technical Approach', status: 'VERIFIED' },
      { text: 'List the crew.', section: 'Staffing', status: 'UNVERIFIED' },
    ])
    await setUpProposal(firm.id, proposal.id, null)
    const sections = await sectionsOf(proposal.id)
    expect(sections.map((s) => s.title)).toEqual(['Technical Approach'])
    expect(sections[0].outline).not.toContain(UNVERIFIED_OUTLINE_NOTE)
    const after = await prisma.proposal.findUniqueOrThrow({ where: { id: proposal.id } })
    expect(after.setupStatus).toBe('DONE')
    expect(after.setupNote).toMatch(/from the verified requirements/)
  })

  it('uses the requirements just read, marked as not verified, when none is verified yet', async () => {
    const { proposal } = await start([
      { text: 'Describe the roofing method.', section: 'Technical Approach', status: 'UNVERIFIED' },
      { text: 'Rejected one.', section: 'Ignore Me', status: 'REJECTED' },
    ])
    await setUpProposal(firm.id, proposal.id, null)
    const sections = await sectionsOf(proposal.id)
    expect(sections.map((s) => s.title)).toEqual(['Technical Approach'])
    expect(sections[0].outline).toContain(UNVERIFIED_OUTLINE_NOTE)
    expect((await prisma.proposal.findUniqueOrThrow({ where: { id: proposal.id } })).setupNote).toMatch(/verify them in the Compliance Matrix/)
  })

  it('falls back to the standard sections, and says why the requirements were not read', async () => {
    const { proposal } = await start([], broke)
    await setUpProposal(broke.id, proposal.id, null)
    expect((await sectionsOf(proposal.id)).map((s) => s.title)).toEqual(STANDARD_OUTLINE.map((s) => s.title))
    const after = await prisma.proposal.findUniqueOrThrow({ where: { id: proposal.id } })
    expect(after.setupStatus).toBe('DONE')
    expect(after.setupNote).toMatch(/Requirements were not read: (AI call limit|You have no proposal tokens)/)
  })

  it('never replaces sections a proposal already has', async () => {
    const { opp, proposal } = await start([{ text: 'Describe the roofing method.', section: 'Technical Approach', status: 'VERIFIED' }])
    await prisma.proposalSection.create({ data: { consultingFirmId: firm.id, opportunityId: opp.id, proposalId: proposal.id, title: 'My own section', sortOrder: 0 } })
    await setUpProposal(firm.id, proposal.id, null)
    expect((await sectionsOf(proposal.id)).map((s) => s.title)).toEqual(['My own section'])
  })
})
