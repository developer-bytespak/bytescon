// =============================================================
// Every built-in opportunity source is on for every account.
//
// There is no Discovery page to add or switch on sources any more, so a new
// account gets one enabled source per built-in adapter, and server start turns
// them on for existing accounts (and adds any adapter registered since).
// A source that needs something the account has not given (its own SAM.gov key,
// a feed URL) still runs: the sync records it as not configured and skips it.
// =============================================================
import { Prisma, AdapterVerification } from '@prisma/client'
import { prisma } from '../../config/database'
import { BUILT_IN } from './adapters'

type Db = Prisma.TransactionClient | typeof prisma

const rowsFor = (consultingFirmId: string) => BUILT_IN.map((adapter) => ({
  consultingFirmId,
  adapterKey: adapter.key,
  displayName: adapter.displayName,
  category: adapter.category,
  isEnabled: true,
  // Never presented as live until a run proves it.
  verification: AdapterVerification.NOT_CONFIGURED,
}))

/** Adds every missing built-in source to the firm and switches all of them on. */
export async function enableAllSources(consultingFirmId: string, db: Db = prisma): Promise<void> {
  await db.opportunitySourceConfig.createMany({ data: rowsFor(consultingFirmId), skipDuplicates: true })
  await db.opportunitySourceConfig.updateMany({ where: { consultingFirmId, isEnabled: false }, data: { isEnabled: true } })
}

const FIRMS_PER_BATCH = 200

/**
 * Server start: every active, non-test account gets every source switched on.
 * `onlyFirmIds` narrows it (tests share one database with many accounts).
 */
export async function enableAllSourcesForAllFirms(onlyFirmIds?: string[]): Promise<{ firms: number }> {
  const firms = await prisma.consultingFirm.findMany({
    where: { isActive: true, isTest: false, ...(onlyFirmIds ? { id: { in: onlyFirmIds } } : {}) },
    select: { id: true },
  })
  for (let i = 0; i < firms.length; i += FIRMS_PER_BATCH) {
    const ids = firms.slice(i, i + FIRMS_PER_BATCH).map((f) => f.id)
    await prisma.opportunitySourceConfig.createMany({ data: ids.flatMap(rowsFor), skipDuplicates: true })
    await prisma.opportunitySourceConfig.updateMany({ where: { consultingFirmId: { in: ids }, isEnabled: false }, data: { isEnabled: true } })
  }
  return { firms: firms.length }
}
