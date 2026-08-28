// =============================================================
// Past Performance Service
// -------------------------------------------------------------
// Owns all reads/writes for the *structured* past-performance subsystem
// (FAR 15.305(a)(2) contract references + CPARS), distinct from the
// submission-discipline win/loss aggregate in PerformanceStats.
//
// Shared by: routes/pastPerformance.ts (CRUD), routes/submissions.ts
// (auto-capture on WON), engines/fitScoring.ts via decisionEngine
// (relevance-aware scoring, flag-gated), and the opportunity-mcp tools.
// =============================================================
import { prisma } from '../config/database';
import { logger } from '../utils/logger';
import { NotFoundError, ValidationError } from '../utils/errors';

export const CPARS_RATINGS = [
  'EXCEPTIONAL',
  'VERY_GOOD',
  'SATISFACTORY',
  'MARGINAL',
  'UNSATISFACTORY',
] as const;
export type CparsRating = (typeof CPARS_RATINGS)[number];

export const CONTRACT_TYPES = ['FFP', 'T_AND_M', 'IDIQ', 'COST_REIMB', 'BPA'] as const;
export type ContractType = (typeof CONTRACT_TYPES)[number];

export interface PastPerformanceInput {
  clientCompanyId?: string | null;
  contractNumber: string;
  customerName: string;
  customerAgency?: string | null;
  customerPocName?: string | null;
  customerPocEmail?: string | null;
  customerPocPhone?: string | null;
  contractType?: string | null;
  totalValue?: number | null;
  periodOfPerformanceStart?: Date | null;
  periodOfPerformanceEnd?: Date | null;
  cparsRating?: string | null;
  cparsLink?: string | null;
  scopeSummary?: string;
  relevanceTags?: string[];
  isCurrent?: boolean;
}

export interface ListFilters {
  clientCompanyId?: string;
  isCurrent?: boolean;
}

// CPARS rating → 0-100 quality score. SATISFACTORY (the contractual baseline)
// maps to the 50 midpoint so a relevance blend penalises sub-par ratings and
// rewards above-baseline ones symmetrically. Null/unknown → null (no signal).
export function cparsRatingToScore(rating: string | null | undefined): number | null {
  switch (rating) {
    case 'EXCEPTIONAL':
      return 100;
    case 'VERY_GOOD':
      return 80;
    case 'SATISFACTORY':
      return 50;
    case 'MARGINAL':
      return 30;
    case 'UNSATISFACTORY':
      return 10;
    default:
      return null;
  }
}

// Assert a clientCompanyId (when supplied) belongs to this tenant. Returns the
// normalized value (undefined → null) so callers can write it straight through.
async function assertClientInFirm(
  consultingFirmId: string,
  clientCompanyId: string | null | undefined
): Promise<string | null> {
  if (!clientCompanyId) return null;
  const client = await prisma.clientCompany.findFirst({
    where: { id: clientCompanyId, consultingFirmId },
    select: { id: true },
  });
  if (!client) throw new NotFoundError('ClientCompany');
  return client.id;
}

function validateEnums(input: Partial<PastPerformanceInput>): void {
  if (
    input.cparsRating != null &&
    input.cparsRating !== '' &&
    !CPARS_RATINGS.includes(input.cparsRating as CparsRating)
  ) {
    throw new ValidationError(`Invalid cparsRating; expected one of ${CPARS_RATINGS.join(', ')}`);
  }
  if (
    input.contractType != null &&
    input.contractType !== '' &&
    !CONTRACT_TYPES.includes(input.contractType as ContractType)
  ) {
    throw new ValidationError(`Invalid contractType; expected one of ${CONTRACT_TYPES.join(', ')}`);
  }
}

export async function listPastPerformance(consultingFirmId: string, filters: ListFilters = {}) {
  const where: Record<string, unknown> = { consultingFirmId };
  if (filters.clientCompanyId) where.clientCompanyId = filters.clientCompanyId;
  if (filters.isCurrent !== undefined) where.isCurrent = filters.isCurrent;

  return prisma.pastPerformanceRecord.findMany({
    where,
    include: { clientCompany: { select: { id: true, name: true } } },
    orderBy: [{ periodOfPerformanceEnd: 'desc' }, { createdAt: 'desc' }],
  });
}

export async function getPastPerformanceById(consultingFirmId: string, id: string) {
  return prisma.pastPerformanceRecord.findFirst({
    where: { id, consultingFirmId },
    include: { clientCompany: { select: { id: true, name: true } } },
  });
}

export async function createPastPerformance(
  consultingFirmId: string,
  input: PastPerformanceInput
) {
  validateEnums(input);
  const clientCompanyId = await assertClientInFirm(consultingFirmId, input.clientCompanyId);

  return prisma.pastPerformanceRecord.create({
    data: {
      consultingFirmId,
      clientCompanyId,
      contractNumber: input.contractNumber,
      customerName: input.customerName,
      customerAgency: input.customerAgency ?? null,
      customerPocName: input.customerPocName ?? null,
      customerPocEmail: input.customerPocEmail ?? null,
      customerPocPhone: input.customerPocPhone ?? null,
      contractType: input.contractType ?? null,
      totalValue: input.totalValue ?? null,
      periodOfPerformanceStart: input.periodOfPerformanceStart ?? null,
      periodOfPerformanceEnd: input.periodOfPerformanceEnd ?? null,
      cparsRating: input.cparsRating ?? null,
      cparsLink: input.cparsLink ?? null,
      scopeSummary: input.scopeSummary ?? '',
      relevanceTags: input.relevanceTags ?? [],
      isCurrent: input.isCurrent ?? true,
    },
  });
}

export async function updatePastPerformance(
  consultingFirmId: string,
  id: string,
  input: Partial<PastPerformanceInput>
) {
  validateEnums(input);

  const existing = await prisma.pastPerformanceRecord.findFirst({
    where: { id, consultingFirmId },
    select: { id: true },
  });
  if (!existing) throw new NotFoundError('Past performance record');

  // Only re-validate client ownership when the caller is changing it.
  const data: Record<string, unknown> = {};
  if ('clientCompanyId' in input) {
    data.clientCompanyId = await assertClientInFirm(consultingFirmId, input.clientCompanyId);
  }
  const passthrough: (keyof PastPerformanceInput)[] = [
    'contractNumber',
    'customerName',
    'customerAgency',
    'customerPocName',
    'customerPocEmail',
    'customerPocPhone',
    'contractType',
    'totalValue',
    'periodOfPerformanceStart',
    'periodOfPerformanceEnd',
    'cparsRating',
    'cparsLink',
    'scopeSummary',
    'relevanceTags',
    'isCurrent',
  ];
  for (const key of passthrough) {
    if (key in input) data[key] = input[key];
  }

  return prisma.pastPerformanceRecord.update({ where: { id }, data });
}

export async function deletePastPerformance(consultingFirmId: string, id: string): Promise<void> {
  const existing = await prisma.pastPerformanceRecord.findFirst({
    where: { id, consultingFirmId },
    select: { id: true },
  });
  if (!existing) throw new NotFoundError('Past performance record');
  await prisma.pastPerformanceRecord.delete({ where: { id } });
}

// ──────────────────────────────────────────────────────────────
// Relevance signal for scoring (Unit 4 — consumed only when the
// RELEVANT_PAST_PERFORMANCE_ENABLED flag is on; see decisionEngine).
// ──────────────────────────────────────────────────────────────
export interface RelevantPastPerformance {
  matchedCount: number; // # of current records relevant to this opportunity
  avgCparsScore: number | null; // 0-100 mean over matched records that carry a CPARS rating
}

interface OppRelevanceKey {
  naicsCode?: string | null;
  agency?: string | null;
}

// Strip non-digits and keep only valid 6-digit NAICS codes, so PSC codes or
// other numeric free-text tags sharing leading digits can't false-match
// (e.g. PSC "5410" must not match the NAICS-54 sector).
function normalizeNaicsTags(tags: string[]): string[] {
  return tags.map((t) => t.replace(/\D/g, '')).filter((t) => t.length === 6);
}

// Pure matcher over ALREADY-normalized inputs (6-digit NAICS tags + lowercased
// agency, on both record and opportunity). Shared by isRecordRelevant (which
// normalizes per call) and the batch path (which normalizes once per client at
// fetch + once per opportunity), so the relevance rule lives in one place.
function naicsAgencyMatches(
  naicsTags: string[],
  agencyLc: string,
  oppNaics: string,
  oppAgencyLc: string
): boolean {
  if (oppNaics) {
    if (naicsTags.some((t) => t === oppNaics)) return true;
    if (oppNaics.length >= 4 && naicsTags.some((t) => t.slice(0, 4) === oppNaics.slice(0, 4))) return true;
    if (oppNaics.length >= 2 && naicsTags.some((t) => t.slice(0, 2) === oppNaics.slice(0, 2))) return true;
  }
  if (oppAgencyLc && agencyLc === oppAgencyLc) return true;
  return false;
}

// A record is "relevant" to an opportunity if any relevanceTag shares the
// opportunity's NAICS (exact, 4-digit group, or 2-digit sector) OR the record's
// customerAgency matches the opportunity's agency. Normalizes per call — used by
// the single-opportunity proposal/records path. The batch scoring path uses the
// pre-normalized PpRelevanceRow instead (see computeRelevanceSignal).
export function isRecordRelevant(
  record: { relevanceTags: string[]; customerAgency: string | null },
  opp: OppRelevanceKey
): boolean {
  return naicsAgencyMatches(
    normalizeNaicsTags(record.relevanceTags),
    (record.customerAgency ?? '').trim().toLowerCase(),
    (opp.naicsCode ?? '').replace(/\D/g, ''),
    (opp.agency ?? '').trim().toLowerCase()
  );
}

// Retract (deactivate) an auto-captured record when its source submission's
// WON outcome is corrected to a non-win. Deactivates rather than deletes so a
// later re-WON can restore visibility (see autoCaptureFromWonSubmission) and a
// user's manual edits are preserved. Only touches auto-captured rows (those
// carrying a sourceSubmissionRecordId). Best-effort; tenant-scoped.
export async function retractAutoCapturedRecord(
  submissionRecordId: string,
  consultingFirmId: string
): Promise<void> {
  const res = await prisma.pastPerformanceRecord.updateMany({
    where: { sourceSubmissionRecordId: submissionRecordId, consultingFirmId, isCurrent: true },
    data: { isCurrent: false },
  });
  if (res.count > 0) {
    logger.info('Retracted auto-captured past-performance record after non-WON outcome', {
      submissionRecordId,
    });
  }
}

// The minimal per-record shape the relevance signal needs, PRE-NORMALIZED at
// fetch (NAICS tags reduced to 6-digit codes, agency lowercased) so the per-
// opportunity match is pure string comparison. Fetched once per client and
// reused across every opportunity for that client (see the cached variant) —
// the row set is opportunity-INDEPENDENT, and now so is the normalization.
export interface PpRelevanceRow {
  naicsTags: string[];
  agencyLc: string;
  cparsRating: string | null;
}

// The opportunity-independent DB read + normalization. clientCompanyId string =
// that client; null/undefined = all of the firm's current records. Internal
// helper — callers use getRelevantPastPerformance / getRelevantPastPerformanceCached.
async function fetchCurrentPpForRelevance(
  consultingFirmId: string,
  clientCompanyId: string | null | undefined
): Promise<PpRelevanceRow[]> {
  const rows = await prisma.pastPerformanceRecord.findMany({
    where: {
      consultingFirmId,
      isCurrent: true,
      ...(clientCompanyId ? { clientCompanyId } : {}),
    },
    select: { relevanceTags: true, customerAgency: true, cparsRating: true },
  });
  // Normalize once per client; the per-opportunity match then does no regex.
  return rows.map((r) => ({
    naicsTags: normalizeNaicsTags(r.relevanceTags),
    agencyLc: (r.customerAgency ?? '').trim().toLowerCase(),
    cparsRating: r.cparsRating,
  }));
}

// Pure: derive the relevance signal for one opportunity from a pre-normalized
// set. Normalizes the opportunity once, then matches via plain comparison.
// Internal helper (see fetchCurrentPpForRelevance).
function computeRelevanceSignal(
  rows: PpRelevanceRow[],
  opp: OppRelevanceKey
): RelevantPastPerformance {
  const oppNaics = (opp.naicsCode ?? '').replace(/\D/g, '');
  const oppAgencyLc = (opp.agency ?? '').trim().toLowerCase();
  const matched = rows.filter((r) =>
    naicsAgencyMatches(r.naicsTags, r.agencyLc, oppNaics, oppAgencyLc)
  );
  const cparsScores = matched
    .map((r) => cparsRatingToScore(r.cparsRating))
    .filter((s): s is number => s !== null);
  const avgCparsScore =
    cparsScores.length > 0
      ? cparsScores.reduce((sum, s) => sum + s, 0) / cparsScores.length
      : null;
  return { matchedCount: matched.length, avgCparsScore };
}

export async function getRelevantPastPerformance(
  consultingFirmId: string,
  clientCompanyId: string | null | undefined,
  opp: OppRelevanceKey
): Promise<RelevantPastPerformance> {
  return computeRelevanceSignal(
    await fetchCurrentPpForRelevance(consultingFirmId, clientCompanyId),
    opp
  );
}

// Cache-aware variant for batch scoring (portfolio engine): the per-client row
// set is fetched at most ONCE per run, even under concurrency. The cache stores
// the in-flight Promise (not the resolved value) keyed by client, so many
// opportunity×client pairs starting at once for the same client share a single
// query instead of issuing N×M identical reads.
export type PpRelevanceCache = Map<string, Promise<PpRelevanceRow[]>>;

export async function getRelevantPastPerformanceCached(
  consultingFirmId: string,
  clientCompanyId: string | null | undefined,
  opp: OppRelevanceKey,
  cache: PpRelevanceCache
): Promise<RelevantPastPerformance> {
  // Tenant-scoped key: the cache can never serve one firm's rows to another,
  // even if a caller ever reuses a cache instance across firms.
  const key = `${consultingFirmId}:${clientCompanyId ?? '__firm__'}`;
  let pending = cache.get(key);
  if (!pending) {
    pending = fetchCurrentPpForRelevance(consultingFirmId, clientCompanyId);
    // Evict on rejection so a transient DB error doesn't poison this client's
    // entry for the rest of the run — the next pair re-fetches instead of
    // re-awaiting a cached rejection. Attached before storing; the stored
    // promise still rejects for any in-flight awaiters of this read.
    pending.catch(() => cache.delete(key));
    cache.set(key, pending);
  }
  return computeRelevanceSignal(await pending, opp);
}

// The offeror's current past-performance records most worth citing in a
// proposal for `opp`: relevant ones first (NAICS/agency overlap), then by
// CPARS quality, then recency, capped at `limit`. `clientCompanyId` as a string
// scopes to that client's records; `null` scopes to firm-level records
// (clientCompanyId IS NULL) — used when the consulting firm itself is the
// offeror, so one client's contracts are never cited as the firm's own.
export interface PastPerformanceForProposal {
  contractNumber: string;
  customerName: string;
  customerAgency: string | null;
  contractType: string | null;
  totalValue: string | null;
  periodOfPerformanceStart: Date | null;
  periodOfPerformanceEnd: Date | null;
  cparsRating: string | null;
  scopeSummary: string;
  relevant: boolean;
}

export async function getRelevantPastPerformanceRecords(
  consultingFirmId: string,
  clientCompanyId: string | null,
  opp: OppRelevanceKey,
  limit = 5
): Promise<PastPerformanceForProposal[]> {
  const records = await prisma.pastPerformanceRecord.findMany({
    where: { consultingFirmId, isCurrent: true, clientCompanyId },
    select: {
      contractNumber: true,
      customerName: true,
      customerAgency: true,
      contractType: true,
      totalValue: true,
      periodOfPerformanceStart: true,
      periodOfPerformanceEnd: true,
      cparsRating: true,
      scopeSummary: true,
      relevanceTags: true,
    },
  });

  const scored = records.map((r) => ({
    record: r,
    relevant: isRecordRelevant(r, opp),
    cpars: cparsRatingToScore(r.cparsRating) ?? -1,
    recency: r.periodOfPerformanceEnd ? r.periodOfPerformanceEnd.getTime() : 0,
  }));

  // Relevant first, then higher CPARS, then more recent.
  scored.sort(
    (a, b) =>
      Number(b.relevant) - Number(a.relevant) || b.cpars - a.cpars || b.recency - a.recency
  );

  return scored.slice(0, limit).map(({ record, relevant }) => ({
    contractNumber: record.contractNumber,
    customerName: record.customerName,
    customerAgency: record.customerAgency,
    contractType: record.contractType,
    totalValue: record.totalValue != null ? record.totalValue.toString() : null,
    periodOfPerformanceStart: record.periodOfPerformanceStart,
    periodOfPerformanceEnd: record.periodOfPerformanceEnd,
    cparsRating: record.cparsRating,
    scopeSummary: record.scopeSummary,
    relevant,
  }));
}

// ──────────────────────────────────────────────────────────────
// Auto-capture (Unit 2). Best-effort, idempotent, create-only:
// when a submission outcome is marked WON, materialise a structured
// past-performance record from the opportunity so records accrue with
// zero manual entry. Never overwrites a record a user has since edited
// (keyed by sourceSubmissionRecordId @unique). Going-forward only — no
// backfill of already-WON submissions.
// ──────────────────────────────────────────────────────────────
interface WonOpportunity {
  id: string;
  samNoticeId: string | null;
  title: string;
  agency: string;
  subagency?: string | null;
  naicsCode: string;
  estimatedValue: { toString(): string } | number | null;
  description?: string | null;
}

export async function autoCaptureFromWonSubmission(params: {
  submissionRecordId: string;
  consultingFirmId: string;
  clientCompanyId: string;
  opportunity: WonOpportunity;
}): Promise<void> {
  const { submissionRecordId, consultingFirmId, clientCompanyId, opportunity: opp } = params;

  // Idempotent: never create a duplicate for the same submission. If a prior
  // non-WON correction had retracted the record, reactivate it (WON→LOST→WON
  // cycle); otherwise leave the (possibly user-edited) record untouched.
  const existing = await prisma.pastPerformanceRecord.findUnique({
    where: { sourceSubmissionRecordId: submissionRecordId },
    select: { id: true, isCurrent: true },
  });
  if (existing) {
    if (!existing.isCurrent) {
      await prisma.pastPerformanceRecord.update({
        where: { id: existing.id },
        data: { isCurrent: true },
      });
      logger.info('Reactivated retracted past-performance record after re-WON', {
        submissionRecordId,
      });
    }
    return;
  }

  // Only the NAICS code seeds relevanceTags. PSC lives in a separate coding
  // namespace and would cause false relevance matches if digit-compared.
  const relevanceTags =
    opp.naicsCode && opp.naicsCode.trim() !== '' ? [opp.naicsCode.trim()] : [];
  const scopeSummary = [opp.title, opp.description?.slice(0, 800)]
    .filter(Boolean)
    .join('\n\n')
    .slice(0, 2000);

  await prisma.pastPerformanceRecord.create({
    data: {
      consultingFirmId,
      clientCompanyId,
      sourceSubmissionRecordId: submissionRecordId,
      // No true contract number until award docs exist; seed with the SAM notice
      // id as a traceable placeholder the user can correct in the UI.
      contractNumber: opp.samNoticeId ? `SAM-${opp.samNoticeId}` : `WON-${opp.id.slice(0, 8)}`,
      customerName: opp.agency,
      customerAgency: opp.subagency || opp.agency,
      contractType: null,
      totalValue: opp.estimatedValue != null ? opp.estimatedValue.toString() : null,
      scopeSummary,
      relevanceTags,
      isCurrent: true,
    },
  });

  logger.info('Auto-captured past-performance record from WON submission', {
    submissionRecordId,
    clientCompanyId,
    opportunityId: opp.id,
  });
}
