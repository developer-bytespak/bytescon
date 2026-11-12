// =============================================================
// Profile gate: scoring, bid decisions, AI analysis and proposal generation
// run only for a company whose profile is complete (profileCompleteness.ts).
//
//   A named client           that client's profile must be complete.
//   A contractor             its own company's profile must be complete.
//   A consulting firm, no    at least one of its clients must be complete
//   client named             (an opportunity-level analysis has no single
//                            client to check).
//
// Refusals carry the missing fields so the screen can say exactly what to fill.
// Background work uses completeClientIds() to skip incomplete profiles quietly.
// =============================================================
import { AccountType, Prisma } from '@prisma/client'
import type { Request, Response, NextFunction } from 'express'
import type { AuthenticatedRequest } from '../types'
import { prisma } from '../config/database'
import { AppError } from '../utils/errors'
import { evaluateProfile, type MissingField, type ProfileCompleteness, type ProfileKind } from './profileCompleteness'

export const PROFILE_INCOMPLETE = 'PROFILE_INCOMPLETE'

export interface ProfileIncompleteDetails {
  clientCompanyId: string | null
  clientName: string | null
  isSelf: boolean
  missing: MissingField[]
}

/** 422 PROFILE_INCOMPLETE, with the fields to fill in `details`. */
export class ProfileIncompleteError extends AppError {
  public readonly details: ProfileIncompleteDetails
  constructor(message: string, details: ProfileIncompleteDetails) {
    super(message, 422, PROFILE_INCOMPLETE)
    this.details = details
  }
}

const PROFILE_SELECT = {
  id: true, name: true, isSelf: true, state: true, naicsCodes: true, uei: true, samRegStatus: true,
  setAsideStatusConfirmedAt: true, capabilityKeywords: true, city: true, streetAddress: true, zipCode: true,
  phone: true, website: true, cage: true, pscCodes: true, contractVehicles: true, employeeCount: true,
  annualRevenue: true, securityClearances: true, isoCertifications: true, brandingLogoUrl: true,
} satisfies Prisma.ClientCompanySelect

type ProfileRow = Prisma.ClientCompanyGetPayload<{ select: typeof PROFILE_SELECT }>

export interface ClientProfileStatus extends ProfileCompleteness {
  clientCompanyId: string
  name: string
  isSelf: boolean
}

/**
 * Past-performance projects that count for a client. A contractor's projects
 * are often kept firm-wide (no client set), so those count for its own company.
 */
async function pastPerformanceCounts(consultingFirmId: string, rows: ProfileRow[]): Promise<Map<string, number>> {
  const grouped = await prisma.pastPerformanceRecord.groupBy({
    by: ['clientCompanyId'],
    where: { consultingFirmId, isArchived: false },
    _count: { _all: true },
  })
  const byClient = new Map(grouped.map((g) => [g.clientCompanyId, g._count._all]))
  const firmWide = byClient.get(null) ?? 0
  return new Map(rows.map((r) => [r.id, (byClient.get(r.id) ?? 0) + (r.isSelf ? firmWide : 0)]))
}

/** A contractor's logo is the firm's branding logo (Settings), so it counts for its own company. */
function statusOf(row: ProfileRow, ppCount: number, kind: ProfileKind, firmLogo: string | null = null): ClientProfileStatus {
  const result = evaluateProfile({
    ...row,
    brandingLogoUrl: row.brandingLogoUrl ?? (row.isSelf ? firmLogo : null),
    annualRevenue: row.annualRevenue === null ? null : Number(row.annualRevenue),
    pastPerformanceCount: ppCount,
  }, kind)
  return { ...result, clientCompanyId: row.id, name: row.name, isSelf: row.isSelf }
}

/** Profile status of every active client of the firm (for a contractor, just its own company). */
export async function clientProfileStatuses(consultingFirmId: string): Promise<{ accountType: AccountType; clients: ClientProfileStatus[] }> {
  const firm = await prisma.consultingFirm.findUnique({ where: { id: consultingFirmId }, select: { accountType: true, brandingLogoUrl: true } })
  const accountType = firm?.accountType ?? AccountType.CONSULTING
  const contractor = accountType === AccountType.CONTRACTOR
  const rows = await prisma.clientCompany.findMany({
    where: { consultingFirmId, archivedAt: null, isActive: true, ...(contractor ? { isSelf: true } : { isSelf: false }) },
    select: PROFILE_SELECT,
    orderBy: { name: 'asc' },
  })
  const counts = await pastPerformanceCounts(consultingFirmId, rows)
  const kind: ProfileKind = contractor ? 'CONTRACTOR' : 'PROFILE'
  return { accountType, clients: rows.map((r) => statusOf(r, counts.get(r.id) ?? 0, kind, firm?.brandingLogoUrl ?? null)) }
}

/** Profile status of one client of the firm, or null when it isn't the firm's. */
export async function clientProfileStatus(consultingFirmId: string, clientCompanyId: string): Promise<ClientProfileStatus | null> {
  const row = await prisma.clientCompany.findFirst({ where: { id: clientCompanyId, consultingFirmId }, select: PROFILE_SELECT })
  if (!row) return null
  const [counts, firm] = await Promise.all([
    pastPerformanceCounts(consultingFirmId, [row]),
    row.isSelf ? prisma.consultingFirm.findUnique({ where: { id: consultingFirmId }, select: { brandingLogoUrl: true } }) : null,
  ])
  return statusOf(row, counts.get(row.id) ?? 0, row.isSelf ? 'CONTRACTOR' : 'PROFILE', firm?.brandingLogoUrl ?? null)
}

/** Ids of the given clients whose profiles are complete, for background work to keep. */
export async function completeClientIds(consultingFirmId: string, clientIds: string[]): Promise<Set<string>> {
  if (clientIds.length === 0) return new Set()
  const rows = await prisma.clientCompany.findMany({ where: { consultingFirmId, id: { in: clientIds } }, select: PROFILE_SELECT })
  const counts = await pastPerformanceCounts(consultingFirmId, rows)
  return new Set(rows.map((r) => statusOf(r, counts.get(r.id) ?? 0, r.isSelf ? 'CONTRACTOR' : 'PROFILE')).filter((s) => s.complete).map((s) => s.clientCompanyId))
}

function refuse(status: ClientProfileStatus): never {
  const whose = status.isSelf ? 'your company profile' : `the profile for ${status.name}`
  throw new ProfileIncompleteError(`Complete ${whose} first.`, {
    clientCompanyId: status.clientCompanyId, clientName: status.name, isSelf: status.isSelf, missing: status.missing,
  })
}

/**
 * Throw ProfileIncompleteError unless the profile this action depends on is
 * complete. `clientCompanyId` names the client the action is for, when it has one.
 */
export async function assertProfileReady(consultingFirmId: string, clientCompanyId?: string | null): Promise<void> {
  if (clientCompanyId) {
    const status = await clientProfileStatus(consultingFirmId, clientCompanyId)
    // An unknown client is the route's own 404 to report, not a profile problem.
    if (status && !status.complete) refuse(status)
    return
  }
  const { accountType, clients } = await clientProfileStatuses(consultingFirmId)
  if (clients.some((c) => c.complete)) return
  if (accountType === AccountType.CONTRACTOR && clients[0]) refuse(clients[0])
  throw new ProfileIncompleteError(
    clients.length === 0
      ? 'Add a client and complete its profile first.'
      : 'Complete at least one client profile first.',
    { clientCompanyId: null, clientName: null, isSelf: false, missing: [] },
  )
}

/**
 * Route guard. `clientIdOf` picks the client the action is for out of the
 * request (body, query or params) when the action has one.
 */
export function requireProfileReady(clientIdOf?: (req: Request) => unknown) {
  return (req: Request, _res: Response, next: NextFunction) => {
    const firmId = (req as AuthenticatedRequest).user?.consultingFirmId
    if (!firmId) return next()
    const raw = clientIdOf?.(req)
    const clientId = typeof raw === 'string' && raw.trim() ? raw.trim() : null
    assertProfileReady(firmId, clientId).then(() => next(), next)
  }
}
