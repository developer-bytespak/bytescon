// =============================================================
// saveSyncedLead — each firm keeps its own copy of a public lead (B5).
//
// The lead id from SUBNet / SAM.gov used to be unique across the whole
// platform: the first firm to sync a lead owned it, and every later firm's
// sync silently edited that firm's row and never got the lead itself.
// =============================================================
import { describe, it, expect, beforeEach, afterEach, afterAll } from 'vitest'
import { prisma } from '../../config/database'
import { createTestFirm, cleanupFirm, disconnectDb, TestFirm } from '../../test-utils/testClient'
import { saveSyncedLead } from './subcontractLeads'
import type { SubnetOpportunity } from '../subnetScraper'

let firmA: TestFirm
let firmB: TestFirm
let seq = 0

function lead(overrides: Partial<SubnetOpportunity> = {}): SubnetOpportunity {
  return {
    externalId: `subnet-${Date.now()}-${process.pid}-${++seq}`,
    title: 'Network engineering support — subcontract',
    primeContractor: 'Acme Federal Prime',
    primeContractorUei: null,
    naicsCode: '541512',
    agency: 'Department of Example',
    estimatedValue: 250000,
    responseDeadline: new Date(Date.now() + 14 * 86_400_000),
    description: 'Original description',
    contactEmail: 'sblo@acme.example',
    contactName: 'Pat SBLO',
    sourceUrl: 'https://example.gov/lead',
    setAside: 'SBA',
    source: 'sba_subnet',
    ...overrides,
  }
}

const rowsFor = (firmId: string, externalId: string) =>
  prisma.subcontractOpportunity.findMany({ where: { consultingFirmId: firmId, externalId } })

beforeEach(async () => {
  firmA = await createTestFirm({ name: 'Leads Firm A' })
  firmB = await createTestFirm({ name: 'Leads Firm B' })
})

afterEach(async () => {
  await cleanupFirm(firmA?.id).catch(() => {
    // already removed
  })
  await cleanupFirm(firmB?.id).catch(() => {
    // already removed
  })
})

afterAll(async () => {
  await disconnectDb()
})

describe('saveSyncedLead', () => {
  it('two firms syncing the same lead each get their own copy', async () => {
    const opp = lead()
    const a = await saveSyncedLead(firmA.id, opp)
    const b = await saveSyncedLead(firmB.id, opp)

    expect(a.created).toBe(true)
    expect(b.created).toBe(true)
    expect(b.id).not.toBe(a.id)
    expect(await rowsFor(firmA.id, opp.externalId)).toHaveLength(1)
    expect(await rowsFor(firmB.id, opp.externalId)).toHaveLength(1)
  })

  it('a re-sync updates only that firm’s copy', async () => {
    const opp = lead()
    const a = await saveSyncedLead(firmA.id, opp)
    await saveSyncedLead(firmB.id, opp)

    const again = await saveSyncedLead(firmB.id, { ...opp, title: 'Updated by firm B sync', description: 'New text' })
    expect(again.created).toBe(false)

    const [rowA] = await rowsFor(firmA.id, opp.externalId)
    const [rowB] = await rowsFor(firmB.id, opp.externalId)
    expect(rowA.id).toBe(a.id)
    expect(rowA.title).toBe(opp.title)
    expect(rowA.description).toBe('Original description')
    expect(rowB.title).toBe('Updated by firm B sync')
  })

  it('a re-sync keeps the firm’s own SAVED / DISMISSED triage', async () => {
    const opp = lead()
    const a = await saveSyncedLead(firmA.id, opp)
    await prisma.subcontractOpportunity.update({
      where: { id: a.id },
      data: { status: 'DISMISSED', dismissedReason: 'Not our NAICS', dismissedAt: new Date() },
    })

    await saveSyncedLead(firmA.id, { ...opp, title: 'Refreshed title' })
    await saveSyncedLead(firmB.id, opp)

    const [rowA] = await rowsFor(firmA.id, opp.externalId)
    const [rowB] = await rowsFor(firmB.id, opp.externalId)
    expect(rowA).toMatchObject({ status: 'DISMISSED', dismissedReason: 'Not our NAICS', title: 'Refreshed title' })
    expect(rowB.status).toBe('OPEN')
  })

  it('manually added leads (no external id) never collide', async () => {
    const base = { title: 'Manual lead', primeContractor: 'Some Prime', status: 'OPEN' }
    await prisma.subcontractOpportunity.create({ data: { consultingFirmId: firmA.id, ...base } })
    await prisma.subcontractOpportunity.create({ data: { consultingFirmId: firmA.id, ...base } })
    expect(await prisma.subcontractOpportunity.count({ where: { consultingFirmId: firmA.id, externalId: null } })).toBe(2)
  })
})
