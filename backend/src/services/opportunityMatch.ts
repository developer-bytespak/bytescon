// =============================================================
// "Matches my business type" — the Opportunities filter.
//
// The Opportunities list shows every available notice by default, in the
// demo and the full version alike. This filter narrows it to notices whose
// NAICS code fits:
//   business       a demo account's business type (its NAICS sectors)
//   clients        any of the firm's clients (a contractor's own company is
//                  one of its clients, so this covers it too)
//   client:<id>    one client
// A notice fits when its NAICS starts with one of the prefixes: a business
// type's sector codes, or a client's codes cut to 4 digits (industry group),
// as the earlier client filter did.
// =============================================================
import { prisma } from '../config/database'
import { isDemo } from './appEnvironment'
import { businessTypeByKey } from './demoBusinessTypes'

export type MatchMode = 'all' | 'business' | 'clients' | 'client'

export interface ResolvedMatch {
  mode: MatchMode
  clientCompanyId: string | null
  /** NAICS prefixes a notice must start with; null when not filtering. */
  prefixes: string[] | null
}

/** The firm's business type, on the demo. Null elsewhere, or for the operators' account. */
export async function demoBusinessType(consultingFirmId: string): Promise<{ key: string; label: string; naicsPrefixes: string[] } | null> {
  if (!isDemo()) return null
  const firm = await prisma.consultingFirm.findUnique({ where: { id: consultingFirmId }, select: { demoBusinessType: true } })
  const type = businessTypeByKey(firm?.demoBusinessType)
  return type ? { key: type.key, label: type.label, naicsPrefixes: type.naicsPrefixes } : null
}

const toPrefixes = (codes: string[]) => [...new Set(codes.map((c) => c.trim().slice(0, 4)).filter((c) => c.length >= 2))]

/**
 * Turn the request's `match` (or the older `clientId`) into NAICS prefixes.
 * Unknown values and `all` mean no filter.
 */
export async function resolveMatch(consultingFirmId: string, raw: { match?: unknown; clientId?: unknown }): Promise<ResolvedMatch> {
  const match = typeof raw.match === 'string' ? raw.match.trim() : ''
  const legacyClient = typeof raw.clientId === 'string' && raw.clientId.trim() ? raw.clientId.trim() : null
  const clientId = match.startsWith('client:') ? match.slice('client:'.length) : (!match && legacyClient) ? legacyClient : null

  if (clientId) {
    const client = await prisma.clientCompany.findFirst({ where: { id: clientId, consultingFirmId }, select: { naicsCodes: true } })
    return { mode: 'client', clientCompanyId: clientId, prefixes: toPrefixes(client?.naicsCodes ?? []) }
  }
  if (match === 'business') {
    const type = await demoBusinessType(consultingFirmId)
    // Outside the demo there is no business type of its own: use the clients'.
    if (type) return { mode: 'business', clientCompanyId: null, prefixes: type.naicsPrefixes }
  }
  if (match === 'business' || match === 'clients') {
    const clients = await prisma.clientCompany.findMany({ where: { consultingFirmId, isActive: true }, select: { naicsCodes: true } })
    return { mode: 'clients', clientCompanyId: null, prefixes: toPrefixes(clients.flatMap((c) => c.naicsCodes)) }
  }
  return { mode: 'all', clientCompanyId: null, prefixes: null }
}

/**
 * The Prisma condition for a resolved match. With prefixes to match but none
 * known (a client with no NAICS codes), nothing fits: an empty result, not
 * every notice.
 */
export function matchCondition(m: ResolvedMatch): { OR: Array<{ naicsCode: { startsWith: string } }> } | { id: { in: string[] } } | null {
  if (!m.prefixes) return null
  if (m.prefixes.length === 0) return { id: { in: [] } }
  return { OR: m.prefixes.map((prefix) => ({ naicsCode: { startsWith: prefix } })) }
}
