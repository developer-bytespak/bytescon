// =============================================================
// §8.4 — Public API v1 DTOs.
//
// Nothing is spread from a Prisma row. Every field is named, once, here.
//
// That is the whole point: a `...row` in a serializer is how the column added
// six months from now — an internal note, a margin, a hashed secret, a scoring
// weight — silently becomes part of a customer-facing contract. Naming each
// field means a new column is invisible to this API until a human decides it
// should not be.
//
// Money crosses the wire as an exact decimal string. Rounding a Decimal into a
// JavaScript number to serialize it is how a contract value stops matching the
// contract.
// =============================================================
import { Prisma } from '@prisma/client'

function money(value: Prisma.Decimal | null | undefined): string | null {
  return value === null || value === undefined ? null : value.toFixed(2)
}

function date(value: Date | null | undefined): string | null {
  return value ? value.toISOString() : null
}

export interface OpportunityDto {
  id: string
  title: string
  agency: string
  subagency: string | null
  solicitationNumber: string | null
  naicsCode: string | null
  psc: string | null
  setAsideType: string
  status: string
  postedDate: string | null
  responseDeadline: string | null
  placeOfPerformance: string | null
  estimatedValue: string | null
  source: string
  sourceUrl: string | null
  createdAt: string
}

export const OPPORTUNITY_SELECT = {
  id: true, title: true, agency: true, subagency: true, solicitationNumber: true,
  naicsCode: true, psc: true, setAsideType: true, status: true, postedDate: true,
  responseDeadline: true, placeOfPerformance: true, estimatedValue: true,
  source: true, sourceUrl: true, createdAt: true,
} as const

export function toOpportunityDto(row: Record<string, unknown>): OpportunityDto {
  return {
    id: row.id as string,
    title: row.title as string,
    agency: row.agency as string,
    subagency: (row.subagency as string | null) ?? null,
    solicitationNumber: (row.solicitationNumber as string | null) ?? null,
    naicsCode: (row.naicsCode as string | null) || null,
    psc: (row.psc as string | null) ?? null,
    setAsideType: row.setAsideType as string,
    status: String(row.status),
    postedDate: date(row.postedDate as Date | null),
    responseDeadline: date(row.responseDeadline as Date | null),
    placeOfPerformance: (row.placeOfPerformance as string | null) ?? null,
    estimatedValue: money(row.estimatedValue as Prisma.Decimal | null),
    source: String(row.source),
    sourceUrl: (row.sourceUrl as string | null) ?? null,
    createdAt: date(row.createdAt as Date) as string,
  }
}

export interface PursuitDto {
  id: string
  opportunityId: string
  opportunityTitle: string | null
  status: string
  pipelineStage: string
  priority: string
  nextAction: string | null
  nextActionDueAt: string | null
  closedAt: string | null
  closeReason: string | null
  decidedAt: string | null
  lastActivityAt: string
  createdAt: string
}

export const PURSUIT_SELECT = {
  id: true, opportunityId: true, status: true, pipelineStage: true, priority: true,
  nextAction: true, nextActionDueAt: true, closedAt: true, closeReason: true,
  decidedAt: true, lastActivityAt: true, createdAt: true,
  opportunity: { select: { title: true } },
} as const

/**
 * Note what is absent: `probabilityAtDecision`, the scorecard, gate reviews and
 * every qualification recommendation. The firm's own read on its chances is
 * internal, and a pipeline integration has no business reading it.
 */
export function toPursuitDto(row: Record<string, unknown>): PursuitDto {
  const opp = row.opportunity as { title?: string } | null
  return {
    id: row.id as string,
    opportunityId: row.opportunityId as string,
    opportunityTitle: opp?.title ?? null,
    status: String(row.status),
    pipelineStage: String(row.pipelineStage),
    priority: String(row.priority),
    nextAction: (row.nextAction as string | null) ?? null,
    nextActionDueAt: date(row.nextActionDueAt as Date | null),
    closedAt: date(row.closedAt as Date | null),
    closeReason: (row.closeReason as string | null) ?? null,
    decidedAt: date(row.decidedAt as Date | null),
    lastActivityAt: date(row.lastActivityAt as Date) as string,
    createdAt: date(row.createdAt as Date) as string,
  }
}

export interface ContractDto {
  id: string
  contractNumber: string
  title: string
  agency: string | null
  contractType: string | null
  status: string
  startDate: string | null
  endDate: string | null
  ceilingValue: string | null
  fundedValue: string | null
  createdAt: string
}

export const CONTRACT_SELECT = {
  id: true, contractNumber: true, title: true, agency: true, contractType: true,
  status: true, startDate: true, endDate: true, ceilingValue: true, fundedValue: true,
  createdAt: true,
} as const

export function toContractDto(row: Record<string, unknown>): ContractDto {
  return {
    id: row.id as string,
    contractNumber: row.contractNumber as string,
    title: row.title as string,
    agency: (row.agency as string | null) ?? null,
    contractType: row.contractType ? String(row.contractType) : null,
    status: String(row.status),
    startDate: date(row.startDate as Date | null),
    endDate: date(row.endDate as Date | null),
    ceilingValue: money(row.ceilingValue as Prisma.Decimal | null),
    fundedValue: money(row.fundedValue as Prisma.Decimal | null),
    createdAt: date(row.createdAt as Date) as string,
  }
}

export interface ContactDto {
  id: string
  kind: 'GOVERNMENT' | 'PARTNER'
  fullName: string
  title: string | null
  email: string | null
  phone: string | null
  organization: string | null
  status: string | null
  updatedAt: string
}

export interface PartnerDto {
  id: string
  name: string
  uei: string | null
  cage: string | null
  partnerType: string
  website: string | null
  geography: string | null
  capabilities: string[]
  certifications: string[]
  primaryNaicsCodes: string[]
  isActive: boolean
  updatedAt: string
}

export const PARTNER_SELECT = {
  id: true, name: true, uei: true, cage: true, partnerType: true, website: true,
  geography: true, capabilities: true, certifications: true, primaryNaicsCodes: true,
  isActive: true, updatedAt: true,
} as const

/**
 * `notes`, `pastRelationship` and every performance record are absent. The
 * firm's private opinion of a teaming partner is not directory data.
 */
export function toPartnerDto(row: Record<string, unknown>): PartnerDto {
  return {
    id: row.id as string,
    name: row.name as string,
    uei: (row.uei as string | null) ?? null,
    cage: (row.cage as string | null) ?? null,
    partnerType: String(row.partnerType),
    website: (row.website as string | null) ?? null,
    geography: (row.geography as string | null) ?? null,
    capabilities: (row.capabilities as string[]) ?? [],
    certifications: (row.certifications as string[]) ?? [],
    primaryNaicsCodes: (row.primaryNaicsCodes as string[]) ?? [],
    isActive: Boolean(row.isActive),
    updatedAt: date(row.updatedAt as Date) as string,
  }
}

export interface PersonnelDto {
  id: string
  firstName: string
  lastName: string
  jobTitle: string | null
  employmentType: string
  location: string | null
  /** Human-entered only; never inferred from employment dates. */
  yearsExperienceStated: number | null
  verifiedLaborCategories: string[]
  hasApprovedResume: boolean
  isActive: boolean
  updatedAt: string
}

export const PERSONNEL_SELECT = {
  id: true, firstName: true, lastName: true, jobTitle: true, employmentType: true,
  location: true, yearsExperience: true, isActive: true, updatedAt: true,
  qualifications: { where: { verification: 'VERIFIED' as const }, select: { laborCategory: true } },
  resumes: { where: { status: 'APPROVED' as const }, select: { id: true } },
} as const

/**
 * No email, no phone, no resume content and no file. A directory answers "who
 * is on the bench and what has been verified", not "here is a person's
 * contact details and CV".
 */
export function toPersonnelDto(row: Record<string, unknown>): PersonnelDto {
  const quals = (row.qualifications as Array<{ laborCategory: string }>) ?? []
  const resumes = (row.resumes as Array<{ id: string }>) ?? []
  return {
    id: row.id as string,
    firstName: row.firstName as string,
    lastName: row.lastName as string,
    jobTitle: (row.jobTitle as string | null) ?? null,
    employmentType: String(row.employmentType),
    location: (row.location as string | null) ?? null,
    yearsExperienceStated: (row.yearsExperience as number | null) ?? null,
    verifiedLaborCategories: quals.map((q) => q.laborCategory),
    hasApprovedResume: resumes.length > 0,
    isActive: Boolean(row.isActive),
    updatedAt: date(row.updatedAt as Date) as string,
  }
}

export interface PageMeta {
  limit: number
  offset: number
  total: number
  hasMore: boolean
}

export function page<T>(items: T[], total: number, limit: number, offset: number): { data: T[]; meta: PageMeta } {
  return { data: items, meta: { limit, offset, total, hasMore: offset + items.length < total } }
}
