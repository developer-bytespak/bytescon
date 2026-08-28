// =============================================================
// FAR Catalog Service — the regulatory ontology lookup layer.
//
// Resolves FAR / DFARS / NIST 800-171 / CMMC / Section 508
// references against the seeded catalog. Used by
// farContextBuilder, complianceGate, and (future) flowDownService.
//
// Catalog is small (~70 clauses + 25 NIST + 21 CMMC + 11 Sec 508)
// and rarely changes, so an in-memory cache with TTL is fine.
// =============================================================
import { prisma } from '../../config/database'

export type ClauseSource = 'FAR' | 'DFARS' | 'NIST' | 'CMMC' | 'SECTION_508'

export interface ClauseRecord {
  source: ClauseSource
  code: string
  title: string
  summary: string | null
  partNumber?: string
  prescribedAt?: string | null
  applicableContractTypes: string[]
  setAsideTriggers: string[]
  agencyTriggers: string[]
  flowDownRequired: boolean
  flowDownThreshold: number | null
  prerequisiteClauseCodes: string[]
  prohibitedClauseCodes: string[]
  commercialItemException: boolean
  isBlocking: boolean
  tags: string[]
}

interface CatalogCache {
  byCode: Map<string, ClauseRecord>          // key = "FAR:52.219-14"
  byContractType: Map<string, ClauseRecord[]>
  bySetAside: Map<string, ClauseRecord[]>
  byAgency: Map<string, ClauseRecord[]>
  byTag: Map<string, ClauseRecord[]>
  loadedAt: number
}

const CACHE_TTL_MS = 60 * 60 * 1000 // 1 hour
let cache: CatalogCache | null = null

function key(source: ClauseSource, code: string): string {
  return `${source}:${code}`
}

async function loadCache(): Promise<CatalogCache> {
  const farRows = await prisma.farClause.findMany()
  const dfarsRows = await prisma.dfarsClause.findMany()

  const byCode = new Map<string, ClauseRecord>()
  const byContractType = new Map<string, ClauseRecord[]>()
  const bySetAside = new Map<string, ClauseRecord[]>()
  const byAgency = new Map<string, ClauseRecord[]>()
  const byTag = new Map<string, ClauseRecord[]>()

  const indexInto = (map: Map<string, ClauseRecord[]>, k: string, rec: ClauseRecord) => {
    const arr = map.get(k) ?? []
    arr.push(rec)
    map.set(k, arr)
  }

  const ingest = (rec: ClauseRecord) => {
    byCode.set(key(rec.source, rec.code), rec)
    rec.applicableContractTypes.forEach((ct) => indexInto(byContractType, ct, rec))
    rec.setAsideTriggers.forEach((sa) => indexInto(bySetAside, sa, rec))
    rec.agencyTriggers.forEach((ag) => indexInto(byAgency, ag, rec))
    rec.tags.forEach((t) => indexInto(byTag, t, rec))
  }

  for (const r of farRows) {
    ingest({
      source: 'FAR',
      code: r.code,
      title: r.title,
      summary: r.summary,
      partNumber: r.partNumber,
      prescribedAt: r.prescribedAt,
      applicableContractTypes: r.applicableContractTypes,
      setAsideTriggers: r.setAsideTriggers,
      agencyTriggers: r.agencyTriggers,
      flowDownRequired: r.flowDownRequired,
      flowDownThreshold: r.flowDownThreshold ? Number(r.flowDownThreshold) : null,
      prerequisiteClauseCodes: r.prerequisiteClauseCodes,
      prohibitedClauseCodes: r.prohibitedClauseCodes,
      commercialItemException: r.commercialItemException,
      isBlocking: r.isBlocking,
      tags: r.tags,
    })
  }

  for (const r of dfarsRows) {
    ingest({
      source: 'DFARS',
      code: r.code,
      title: r.title,
      summary: r.summary,
      partNumber: r.partNumber,
      prescribedAt: r.prescribedAt,
      applicableContractTypes: r.applicableContractTypes,
      setAsideTriggers: [],
      agencyTriggers: r.agencyTriggers,
      flowDownRequired: r.flowDownRequired,
      flowDownThreshold: r.flowDownThreshold ? Number(r.flowDownThreshold) : null,
      prerequisiteClauseCodes: r.prerequisiteClauseCodes,
      prohibitedClauseCodes: [],
      commercialItemException: false,
      isBlocking: r.isBlocking,
      tags: r.tags,
    })
  }

  return { byCode, byContractType, bySetAside, byAgency, byTag, loadedAt: Date.now() }
}

async function getCache(): Promise<CatalogCache> {
  if (!cache || Date.now() - cache.loadedAt > CACHE_TTL_MS) {
    cache = await loadCache()
  }
  return cache
}

export async function invalidateCache(): Promise<void> {
  cache = null
}

// -------------------------------------------------------------
// PUBLIC API
// -------------------------------------------------------------

export async function lookup(code: string, source?: ClauseSource): Promise<ClauseRecord | null> {
  const c = await getCache()
  if (source) {
    return c.byCode.get(key(source, code)) ?? null
  }
  // Try FAR first, then DFARS — covers the vast majority of references
  return c.byCode.get(key('FAR', code)) ?? c.byCode.get(key('DFARS', code)) ?? null
}

export async function findByContractType(contractType: string, source?: ClauseSource): Promise<ClauseRecord[]> {
  const c = await getCache()
  const matches = c.byContractType.get(contractType) ?? []
  return source ? matches.filter((r) => r.source === source) : matches
}

export async function findBySetAside(setAside: string, source?: ClauseSource): Promise<ClauseRecord[]> {
  const c = await getCache()
  const matches = c.bySetAside.get(setAside) ?? []
  return source ? matches.filter((r) => r.source === source) : matches
}

export async function findByAgency(agency: string, source?: ClauseSource): Promise<ClauseRecord[]> {
  const c = await getCache()
  const matches = c.byAgency.get(agency) ?? []
  return source ? matches.filter((r) => r.source === source) : matches
}

export async function findByTag(tag: string, source?: ClauseSource): Promise<ClauseRecord[]> {
  const c = await getCache()
  const matches = c.byTag.get(tag) ?? []
  return source ? matches.filter((r) => r.source === source) : matches
}

export async function findPrerequisites(code: string, source: ClauseSource = 'FAR'): Promise<ClauseRecord[]> {
  const root = await lookup(code, source)
  if (!root) return []
  const result: ClauseRecord[] = []
  for (const prereqCode of root.prerequisiteClauseCodes) {
    const prereq = await lookup(prereqCode)
    if (prereq) result.push(prereq)
  }
  return result
}

/**
 * Compute the set of clauses that must flow down to subcontracts.
 * Considers the prime's clauses, the subcontract value (against each
 * clause's flowDownThreshold), and any commercial-item exception.
 */
export async function findFlowDowns(
  primeClauseCodes: { source: ClauseSource; code: string }[],
  subValue: number,
  isCommercialSub: boolean
): Promise<ClauseRecord[]> {
  const result: ClauseRecord[] = []
  for (const ref of primeClauseCodes) {
    const clause = await lookup(ref.code, ref.source)
    if (!clause || !clause.flowDownRequired) continue
    if (isCommercialSub && clause.commercialItemException) continue
    if (clause.flowDownThreshold !== null && subValue < clause.flowDownThreshold) continue
    result.push(clause)
  }
  return result
}

export interface OpportunityProfile {
  agency: string
  naicsCode?: string | null
  setAsideType?: string | null
  estimatedValue?: number | null
  contractType?: string | null    // FFP | T_AND_M | IDIQ | COST_REIMB | BPA | COMMERCIAL
  isCommercialItem?: boolean
}

/**
 * Determine the canonical regulatory frame for an opportunity:
 * which FAR/DFARS clauses apply, blocking prerequisites, flow-down set.
 */
export async function findApplicableForOpportunity(opp: OpportunityProfile): Promise<{
  far: ClauseRecord[]
  dfars: ClauseRecord[]
  blocking: ClauseRecord[]
  flowDownCandidates: ClauseRecord[]
}> {
  const c = await getCache()
  const isDoD = inferIsDoD(opp.agency)
  const contractType = (opp.contractType ?? 'FFP').toUpperCase()
  const setAside = normalizeSetAside(opp.setAsideType)

  const applicable = new Map<string, ClauseRecord>()

  // 1. Always-applicable foundational clauses
  const foundational = ['52.204-7', '52.204-8', '52.204-13', '52.209-5', '52.252-1', '52.252-2']
  for (const code of foundational) {
    const rec = await lookup(code, 'FAR')
    if (rec) applicable.set(key(rec.source, rec.code), rec)
  }

  // 2. Contract-type-driven
  for (const rec of c.byContractType.get(contractType) ?? []) {
    if (opp.isCommercialItem && rec.commercialItemException) continue
    applicable.set(key(rec.source, rec.code), rec)
  }

  // 3. Set-aside-driven
  if (setAside) {
    for (const rec of c.bySetAside.get(setAside) ?? []) {
      applicable.set(key(rec.source, rec.code), rec)
    }
  }

  // 4. Agency-driven (DoD → DFARS)
  if (isDoD) {
    for (const rec of c.byAgency.get('DOD') ?? []) {
      applicable.set(key(rec.source, rec.code), rec)
    }
  }

  const all = Array.from(applicable.values())
  const far = all.filter((r) => r.source === 'FAR')
  const dfars = all.filter((r) => r.source === 'DFARS')
  const blocking = all.filter((r) => r.isBlocking)
  const flowDownCandidates = all.filter((r) => r.flowDownRequired)

  return { far, dfars, blocking, flowDownCandidates }
}

// -------------------------------------------------------------
// Helpers
// -------------------------------------------------------------

function inferIsDoD(agency: string): boolean {
  const a = (agency || '').toUpperCase()
  return (
    a.includes('DEFENSE') ||
    a.includes('ARMY') ||
    a.includes('NAVY') ||
    a.includes('AIR FORCE') ||
    a.includes('MARINE') ||
    a.includes('SPACE FORCE') ||
    a.startsWith('DOD') ||
    a.includes('DEPARTMENT OF DEFENSE')
  )
}

function normalizeSetAside(raw: string | null | undefined): string | null {
  if (!raw) return null
  const v = raw.toUpperCase().replace(/[-\s]/g, '_')
  if (v === 'NONE' || v === '') return null
  if (v === '8A' || v === 'SBA_8A') return 'EIGHT_A'
  if (v === 'TOTAL_SMALL_BUSINESS') return 'SMALL_BUSINESS'
  return v
}

export function inferCmmcLevel(opp: OpportunityProfile, applicableDfarsCodes: string[]): number | null {
  if (!inferIsDoD(opp.agency)) return null
  if (applicableDfarsCodes.includes('252.204-7021')) return 2 // CMMC explicit
  if (applicableDfarsCodes.includes('252.204-7012')) return 2 // CDI ⇒ L2
  return 1 // FCI baseline for any DoD contract
}

export function inferSection508Required(opp: OpportunityProfile): boolean {
  const naics = opp.naicsCode ?? ''
  // 5415xx Computer Systems Design / 5182xx Data Processing / 5191xx Internet
  return naics.startsWith('5415') || naics.startsWith('5182') || naics.startsWith('5191')
}
