// =============================================================
// §6.1A — Source-adapter contract.
//
// ONE reusable contract every ingestion source implements. The orchestrator
// (sourceSync.ts) owns idempotency, retry, timeout, rate limiting, cursor
// persistence and run bookkeeping, so an adapter only has to know how to talk
// to its provider and how to normalize one page of results.
//
// Adapters normalize into the EXISTING Opportunity domain (NormalizedOpportunity)
// or, for procurement forecasts — which are explicitly not solicitations — into
// the AgencyForecast source-record model (NormalizedForecast). There is no
// second opportunity list.
//
// Honesty rules encoded here:
//  - `configure()` reports NOT_CONFIGURED when an optional provider credential
//    or base URL is absent. The platform still runs; the adapter simply does
//    not sync. No adapter is ever reported LIVE_VERIFIED unless a real run
//    against the live provider succeeded (sourceSync sets that, never the
//    adapter itself).
//  - Every normalized record must carry externalId + sourceUrl (where the
//    provider exposes one) + the provider's own last-updated timestamp.
// =============================================================
import { SourceCategory, SourceDataQuality } from '@prisma/client'

export interface AdapterEnv {
  /** Reads an OPTIONAL environment variable. Never throws on absence. */
  getEnv(key: string): string | undefined
  /** Per-firm stored configuration (baseUrl, adapter-specific options). */
  config: Record<string, unknown>
  baseUrl?: string | null
  /** Firm-scoped API key resolved by the caller (e.g. ConsultingFirm.samApiKey). */
  firmApiKey?: string | null
}

export type ConfigureState = 'READY' | 'NOT_CONFIGURED'

export interface ConfigureResult {
  state: ConfigureState
  /** Human-readable reason shown in the UI when NOT_CONFIGURED. */
  reason?: string
  /** Name of the optional env var that would enable this adapter. */
  requiredEnvKey?: string
}

export interface FetchPageArgs {
  /** Watermark from the previous successful run; undefined on a FULL sync. */
  cursor?: string | null
  mode: 'FULL' | 'INCREMENTAL'
  /** Page token/offset returned by the previous fetchPage call. */
  pageToken?: string | null
  /** Abort budget in ms for this single page request. */
  timeoutMs: number
  now: Date
}

/** An opportunity normalized into the existing Opportunity domain. */
export interface NormalizedOpportunity {
  kind: 'OPPORTUNITY'
  externalId: string
  title: string
  agency: string
  subagency?: string | null
  office?: string | null
  description?: string | null
  naicsCode?: string | null
  psc?: string | null
  setAsideType?: string | null
  noticeType?: string | null
  solicitationNumber?: string | null
  postedDate?: Date | null
  responseDeadline?: Date | null
  archiveDate?: Date | null
  placeOfPerformance?: string | null
  estimatedValue?: number | null
  estimatedValueMin?: number | null
  estimatedValueMax?: number | null
  sourceUrl?: string | null
  /** Provider-side last-modified. Drives amendment/version detection. */
  sourceUpdatedAt?: Date | null
  /** Raw/normalized provider payload retained for traceability. */
  sourceMetadata?: Record<string, unknown> | null
  /** PARTIAL when required normalization fields were absent at the source. */
  dataQuality: SourceDataQuality
}

/** A procurement forecast — explicitly NOT a released solicitation. */
export interface NormalizedForecast {
  kind: 'FORECAST'
  externalId: string
  agency: string
  subAgency?: string | null
  contractingOffice?: string | null
  title: string
  description?: string | null
  anticipatedSolicitationDate?: Date | null
  anticipatedAwardDate?: Date | null
  fiscalYear?: number | null
  naicsCode?: string | null
  psc?: string | null
  setAsideExpectation?: string | null
  contractVehicle?: string | null
  estimatedValue?: number | null
  estimatedValueMin?: number | null
  estimatedValueMax?: number | null
  /** Only when the source explicitly supplies an incumbent. Never inferred. */
  incumbentName?: string | null
  placeOfPerformance?: string | null
  contactName?: string | null
  contactEmail?: string | null
  contactPhone?: string | null
  sourceUrl?: string | null
  sourceReference?: string | null
  sourceUpdatedAt?: Date | null
  sourceMetadata?: Record<string, unknown> | null
  dataQuality: SourceDataQuality
}

export type NormalizedRecord = NormalizedOpportunity | NormalizedForecast

export interface FetchPageResult {
  records: NormalizedRecord[]
  /** Token for the next page, or null when the feed is exhausted. */
  nextPageToken: string | null
  /** New watermark to persist after the whole run succeeds. */
  nextCursor?: string | null
  /** True when the provider signalled a rate limit; orchestrator backs off. */
  rateLimited?: boolean
}

export interface SourceAdapter {
  /** Stable key persisted on OpportunitySourceConfig.adapterKey. */
  readonly key: string
  readonly displayName: string
  readonly category: SourceCategory
  /** What this adapter produces. Used to route normalization. */
  readonly produces: 'OPPORTUNITY' | 'FORECAST'
  /** Whether the provider supports an incremental watermark at all. */
  readonly supportsIncremental: boolean
  /** Default page size, honoured by the adapter's own paging. */
  readonly pageSize: number
  /**
   * Human-facing note about coverage. Rendered verbatim in the UI so we never
   * imply universal state/local or subcontracting-board coverage.
   */
  readonly coverageNote: string

  configure(env: AdapterEnv): ConfigureResult
  fetchPage(env: AdapterEnv, args: FetchPageArgs): Promise<FetchPageResult>

  /**
   * Some sources maintain their own existing records rather than normalizing
   * into Opportunity/AgencyForecast — award history is the case in point: it is
   * already ingested by the enrichment pathway and hangs off AwardHistory, not
   * Opportunity. Those adapters implement this instead of fetchPage, so the
   * source keeps a real, observable sync run (status, counters, timings,
   * last-successful-sync) without duplicating the working system.
   */
  runDelegatedSync?(ctx: DelegatedSyncContext): Promise<DelegatedSyncResult>
}

export interface DelegatedSyncContext {
  consultingFirmId: string
  timeoutMs: number
  now: Date
}

export interface DelegatedSyncResult {
  recordsFetched: number
  recordsCreated: number
  recordsUpdated: number
  recordsSkipped: number
  errorCount: number
  note?: string
}

// -------------------------------------------------------------
// Registry
// -------------------------------------------------------------

const registry = new Map<string, SourceAdapter>()

export function registerAdapter(adapter: SourceAdapter): void {
  registry.set(adapter.key, adapter)
}

export function getAdapter(key: string): SourceAdapter | undefined {
  return registry.get(key)
}

export function listAdapters(): SourceAdapter[] {
  return [...registry.values()].sort((a, b) => a.key.localeCompare(b.key))
}

/** Test-only: clears the registry so a suite can register fixtures. */
export function resetRegistryForTests(): void {
  registry.clear()
}

// -------------------------------------------------------------
// Shared normalization helpers (used by every adapter, and unit-tested once)
// -------------------------------------------------------------

export function parseSourceDate(value: unknown): Date | null {
  if (value instanceof Date) return Number.isNaN(value.getTime()) ? null : value
  if (typeof value !== 'string' && typeof value !== 'number') return null
  const raw = String(value).trim()
  if (!raw) return null
  // Bare YYYY-MM-DD is anchored to UTC midnight so a forecast date does not
  // shift a day depending on server timezone.
  const bare = /^(\d{4})-(\d{2})-(\d{2})$/.exec(raw)
  if (bare) return new Date(Date.UTC(Number(bare[1]), Number(bare[2]) - 1, Number(bare[3])))
  const d = new Date(raw)
  return Number.isNaN(d.getTime()) ? null : d
}

/** Parses a currency-ish string/number. Returns null rather than guessing 0. */
export function parseSourceAmount(value: unknown): number | null {
  if (typeof value === 'number') return Number.isFinite(value) ? value : null
  if (typeof value !== 'string') return null
  const cleaned = value.replace(/[$,\s]/g, '')
  if (!cleaned || !/^-?\d*\.?\d+$/.test(cleaned)) return null
  const n = Number(cleaned)
  return Number.isFinite(n) ? n : null
}

export function trimOrNull(value: unknown, max = 2000): string | null {
  if (value === null || value === undefined) return null
  const s = String(value).trim()
  if (!s) return null
  return s.length > max ? s.slice(0, max) : s
}

/**
 * Data quality for a normalized record: OK when every field the caller listed
 * as required is present, PARTIAL otherwise. Never optimistic.
 */
export function deriveDataQuality(requiredPresent: boolean[]): SourceDataQuality {
  return requiredPresent.every(Boolean) ? SourceDataQuality.OK : SourceDataQuality.PARTIAL
}

/**
 * Fraction of the listed fields the source actually populated (0..1). This is a
 * completeness measure of the SUPPLIED RECORD, never a confidence in accuracy.
 */
export function completenessOf(values: unknown[]): number {
  if (values.length === 0) return 0
  const present = values.filter((v) => v !== null && v !== undefined && String(v).trim() !== '').length
  return Number((present / values.length).toFixed(4))
}
