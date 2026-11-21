// Who is bidding with a teaming partner. A contractor bids as its own company;
// a consulting firm bids on behalf of one of its clients, never as itself, so
// a teaming deal, its agreement and its workshare belong to that client.
import { AccountType } from '@prisma/client'
import { prisma } from '../config/database'
import { NotFoundError, ValidationError } from '../utils/errors'

export interface Bidder { id: string; name: string; isSelf: boolean }

export async function resolveBidder(consultingFirmId: string, clientCompanyId?: string | null): Promise<Bidder> {
  const firm = await prisma.consultingFirm.findUnique({ where: { id: consultingFirmId }, select: { accountType: true } })
  if (!firm) throw new NotFoundError('Firm')
  const select = { id: true, name: true, isSelf: true } as const

  if (firm.accountType === AccountType.CONTRACTOR) {
    const self = await prisma.clientCompany.findFirst({ where: { consultingFirmId, isSelf: true, archivedAt: null }, select })
    if (!self) throw new ValidationError('Fill in My profile first: your company is the one bidding.')
    return self
  }

  if (clientCompanyId) {
    const client = await prisma.clientCompany.findFirst({
      where: { id: clientCompanyId, consultingFirmId, isSelf: false, archivedAt: null },
      select,
    })
    if (!client) throw new ValidationError('That client is not one of your active clients.')
    return client
  }
  const clients = await prisma.clientCompany.findMany({
    where: { consultingFirmId, isSelf: false, archivedAt: null, isActive: true },
    select,
    take: 2,
  })
  if (clients.length === 1) return clients[0]
  throw new ValidationError(clients.length === 0
    ? 'Add the client you are bidding for under Clients first.'
    : 'Choose which client is bidding with this partner.')
}

/**
 * The company bidding on a pursuit, when it is known: a contractor's own
 * company; else the one client its teaming deals, scorecards or bid decisions
 * name; else a firm's only client. Null when a consulting firm's records
 * don't say which client, so nothing is guessed.
 */
export async function bidderForPursuit(consultingFirmId: string, pursuit: { id: string; opportunityId: string }): Promise<Bidder | null> {
  const firm = await prisma.consultingFirm.findUnique({ where: { id: consultingFirmId }, select: { accountType: true } })
  if (!firm) return null
  const select = { id: true, name: true, isSelf: true } as const
  if (firm.accountType === AccountType.CONTRACTOR) {
    return prisma.clientCompany.findFirst({ where: { consultingFirmId, isSelf: true, archivedAt: null }, select })
  }
  const [deals, scorecards, decisions] = await Promise.all([
    prisma.teamingArrangement.findMany({ where: { consultingFirmId, opportunityId: pursuit.opportunityId, isArchived: false, clientCompanyId: { not: null } }, select: { clientCompanyId: true } }),
    prisma.scorecard.findMany({ where: { consultingFirmId, bidPursuitId: pursuit.id, clientCompanyId: { not: null } }, select: { clientCompanyId: true } }),
    prisma.bidDecision.findMany({ where: { opportunityId: pursuit.opportunityId, clientCompany: { consultingFirmId } }, select: { clientCompanyId: true } }),
  ])
  for (const rows of [deals, scorecards, decisions]) {
    const ids = [...new Set(rows.map((r) => r.clientCompanyId).filter((id): id is string => !!id))]
    if (ids.length === 1) return prisma.clientCompany.findFirst({ where: { id: ids[0], consultingFirmId, isSelf: false }, select })
    if (ids.length > 1) return null
  }
  const clients = await prisma.clientCompany.findMany({ where: { consultingFirmId, isSelf: false, archivedAt: null, isActive: true }, select, take: 2 })
  return clients.length === 1 ? clients[0] : null
}
