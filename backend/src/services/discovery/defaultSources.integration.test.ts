// Every built-in opportunity source is on for every account: a new account gets
// all of them enabled, and the server-start step switches them on for existing ones.
import { describe, it, expect, afterAll } from 'vitest'
import { prisma } from '../../config/database'
import { createTestFirm, cleanupFirm } from '../../test-utils/testClient'
import { BUILT_IN } from './adapters'
import { enableAllSources, enableAllSourcesForAllFirms } from './defaultSources'

const firms: string[] = []
afterAll(async () => { for (const id of firms) await cleanupFirm(id) })

const sourcesOf = (consultingFirmId: string) =>
  prisma.opportunitySourceConfig.findMany({ where: { consultingFirmId }, select: { adapterKey: true, isEnabled: true } })

describe('enableAllSources', () => {
  it('gives an account every built-in source, switched on', async () => {
    const firm = await createTestFirm()
    firms.push(firm.id)
    await enableAllSources(firm.id)
    const rows = await sourcesOf(firm.id)
    expect(rows.map((r) => r.adapterKey).sort()).toEqual(BUILT_IN.map((a) => a.key).sort())
    expect(rows.every((r) => r.isEnabled)).toBe(true)
  })

  it('switches on a source that was off and adds missing ones, without duplicates', async () => {
    const firm = await createTestFirm()
    firms.push(firm.id)
    await prisma.opportunitySourceConfig.create({
      data: { consultingFirmId: firm.id, adapterKey: 'grants_gov', displayName: 'Grants.gov', category: 'GRANTS_GOV', isEnabled: false, configJson: { kept: true } },
    })
    await enableAllSources(firm.id)
    await enableAllSources(firm.id)
    const rows = await sourcesOf(firm.id)
    expect(rows).toHaveLength(BUILT_IN.length)
    expect(rows.every((r) => r.isEnabled)).toBe(true)
    // The account's own settings on an existing source are kept.
    const grants = await prisma.opportunitySourceConfig.findFirstOrThrow({ where: { consultingFirmId: firm.id, adapterKey: 'grants_gov' } })
    expect(grants.configJson).toEqual({ kept: true })
  })

  it('switches them on for existing accounts at server start, but not for test accounts', async () => {
    const real = await createTestFirm()
    const test = await createTestFirm()
    firms.push(real.id, test.id)
    await prisma.consultingFirm.update({ where: { id: test.id }, data: { isTest: true } })
    expect(await enableAllSourcesForAllFirms([real.id, test.id])).toEqual({ firms: 1 })
    expect(await sourcesOf(real.id)).toHaveLength(BUILT_IN.length)
    expect(await sourcesOf(test.id)).toHaveLength(0)
  })
})
