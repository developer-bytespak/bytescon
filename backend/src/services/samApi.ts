import axios from "axios"
import { prisma } from "../config/database"
import { logger } from "../utils/logger"
import { decryptSecret } from "../utils/fieldCrypto"
import { detectVehicleFromOpportunity } from "./vehicleDetector"
import { isManualProtected, isCancellationNotice } from "./ingestClassification"

const SAM_BASE_URL = "https://api.sam.gov/opportunities/v2/search"

// SAM.gov's search endpoint is frequently slow — individual pages can take up
// to ~90s. The old 30s ceiling tripped `timeout of 30000ms exceeded` on ~40%
// of daily syncs (the whole run failed on the first slow page). Raise the
// ceiling and retry transient failures with exponential backoff.
const SAM_REQUEST_TIMEOUT_MS = 90_000
const SAM_MAX_ATTEMPTS = 3 // 1 initial try + 2 retries
const SAM_RETRY_BASE_MS = 2_000 // backoff: 2s, then 4s

/**
 * Transient SAM.gov failures worth retrying: request timeouts (axios
 * `ECONNABORTED`), dropped connections (no HTTP response at all), and 5xx.
 * NOT retried — retrying these wastes the tight daily quota or can't succeed:
 * 429 (quota reached — respect it and bail), 401/403 (bad key), other 4xx.
 */
export function isRetryableSamError(error: any): boolean {
  if (error?.code === "ECONNABORTED") return true // axios client timeout
  const status = error?.response?.status
  if (status == null) return true // network error — no response received
  return status >= 500 && status <= 599
}

/**
 * GET one SAM.gov search page with bounded retry/backoff. Non-retryable
 * errors (429/4xx) are rethrown immediately so the caller's status-specific
 * handling (quota/auth messaging) still fires. `baseDelayMs` is injectable so
 * tests can run without real waits.
 */
export async function requestSamPage(
  requestParams: Record<string, unknown>,
  opts: { maxAttempts?: number; baseDelayMs?: number; timeoutMs?: number } = {},
) {
  const maxAttempts = opts.maxAttempts ?? SAM_MAX_ATTEMPTS
  const baseDelayMs = opts.baseDelayMs ?? SAM_RETRY_BASE_MS
  const timeoutMs = opts.timeoutMs ?? SAM_REQUEST_TIMEOUT_MS

  let lastError: any
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      return await axios.get(SAM_BASE_URL, { params: requestParams, timeout: timeoutMs })
    } catch (error: any) {
      lastError = error
      if (attempt >= maxAttempts || !isRetryableSamError(error)) throw error
      const delay = baseDelayMs * 2 ** (attempt - 1)
      logger.warn("SAM page request failed — retrying", {
        attempt,
        maxAttempts,
        delayMs: delay,
        status: error?.response?.status,
        error: error?.message,
      })
      await new Promise((resolve) => setTimeout(resolve, delay))
    }
  }
  throw lastError // unreachable (loop either returns or throws), satisfies TS
}

function formatSamDate(date: Date): string {
  const mm = String(date.getMonth() + 1).padStart(2, "0")
  const dd = String(date.getDate()).padStart(2, "0")
  const yyyy = date.getFullYear()
  return `${mm}/${dd}/${yyyy}`
}

// SAM.gov `typeOfSetAside` returns either a short code (SBA, SDVOSBC, HZC,
// 8AN, etc.) or, less commonly, a descriptive label ("Total Small Business
// Set-Aside"). The previous matcher used substring lookups against label
// shapes only, so several codes silently fell through to "NONE" — most
// notably SBA (Total Small Business), HZC/HZS (HUBZone), VSA/VOSB
// (Veteran-Owned non-SDVOSB), and the sole-source variants. PROMPT §8.1 #8.
//
// Canonical downstream values consumed by SET_ASIDE_CAPABILITIES (in
// services/complianceGapAnalysis.ts) and the scoring/proposal pathways:
//   NONE | SMALL_BUSINESS | TOTAL_SMALL_BUSINESS | SDVOSB | VOSB
//   | WOSB | EDWOSB | HUBZONE | SBA_8A | INDIAN
export function mapSetAside(value?: string | null): string {
  if (!value) return "NONE"
  const v = value.toUpperCase().trim()

  // -- Short-code path (SAM.gov canonical codes) --------------------
  // Reference: https://open.gsa.gov/api/get-opportunities-public-api/
  switch (v) {
    case "SBA":            return "TOTAL_SMALL_BUSINESS"          // Total Small Business
    case "SBP":            return "SMALL_BUSINESS"                // Partial Small Business
    case "RSB":            return "SMALL_BUSINESS"                // Reserved for Small Business
    case "8A":
    case "8AN":            return "SBA_8A"                        // 8(a) Set-Aside / Sole Source
    case "SDVOSBC":
    case "SDVOSBS":        return "SDVOSB"
    case "VSA":
    case "VSS":
    case "VOSB":           return "VOSB"                          // Veteran-Owned (non-SDVOSB)
    case "WOSB":
    case "WOSBSS":         return "WOSB"
    case "EDWOSB":
    case "EDWOSBSS":       return "EDWOSB"
    case "HZC":
    case "HZS":            return "HUBZONE"
    case "IEE":
    case "BICIV":
    case "ISBEE":          return "INDIAN"                        // Buy Indian / Indian Economic Enterprise
  }

  // -- Label / partial-text fallback (defensive) -------------------
  // Order matters: more-specific patterns must match before generic ones.
  if (v.includes("SDVOSB") || v.includes("SERVICE-DISABLED")) return "SDVOSB"
  if (v.includes("EDWOSB") || v.includes("ECONOMICALLY DISADVANTAGED")) return "EDWOSB"
  if (v.includes("WOSB") || v.includes("WOMAN") || v.includes("WOMEN")) return "WOSB"
  if (v.includes("HUBZONE") || v.includes("HUB ZONE")) return "HUBZONE"
  if (v.includes("8(A)") || v.includes("8A") || v.includes("8 A")) return "SBA_8A"
  if (v.includes("VETERAN")) return "VOSB"
  if (v.includes("INDIAN") || v.includes("NATIVE AMERICAN")) return "INDIAN"
  if (v.includes("TOTAL SMALL")) return "TOTAL_SMALL_BUSINESS"
  if (v.includes("SMALL")) return "SMALL_BUSINESS"

  return "NONE"
}

/**
 * Resolve a non-null `responseDeadline` for an ingested SAM record.
 *
 * The SAM.gov v2 *search* feed frequently omits `responseDeadLine` (it lives
 * on the full notice). Previously an absent deadline defaulted to `now`,
 * which instantly marks the opportunity expired and — because search ranks by
 * `responseDeadline asc` — floats these placeholders to the top as junk,
 * burying genuinely-open work. `responseDeadline` is a non-null column used in
 * 60+ files, so rather than a wide nullable migration we prefer SAM's real
 * `archiveDate` (the date the notice leaves the active board — a legitimate
 * "open until" proxy that is in the future for live solicitations). `now`
 * remains only as a last resort when the feed carries neither date.
 */
export function resolveResponseDeadline(
  record: { responseDeadLine?: string | null; archiveDate?: string | null },
  now: Date,
): Date {
  if (record.responseDeadLine) return new Date(record.responseDeadLine)
  if (record.archiveDate) return new Date(record.archiveDate)
  return now
}

export const samApiService = {
  async searchAndIngest(
    params: {
      naicsCode?: string
      limit?: number
      // Stops pagination once this many records have been seen. Undefined =
      // unbounded (the original behavior used by the daily delta + manual sync).
      // Used by the signup "starter board" ingest to keep a brand-new firm from
      // triggering a full-year pull that would exhaust the shared SAM.gov rate
      // limit and bloat the DB.
      maxRecords?: number
      // Overrides the computed postedFrom (which is firm.lastIngestedAt or
      // Jan 1). Lets the starter ingest pull a recent window instead of the
      // whole year for a firm with no ingest history.
      sinceDate?: Date
    },
    consultingFirmId: string
  ) {
    try {
      const firm = await prisma.consultingFirm.findUnique({
        where: { id: consultingFirmId },
      })

      if (!firm) throw new Error("Consulting firm not found")

      // Prefer firm-level key (set via Settings), fall back to env
      const apiKey = decryptSecret(firm.samApiKey) || process.env.SAM_API_KEY
      if (!apiKey) {
        throw new Error(
          "SAM API key not configured. Add your key in Settings → SAM API Key or set SAM_API_KEY in backend/.env"
        )
      }

      const now = new Date()
      const postedFrom = params.sinceDate
        ? formatSamDate(params.sinceDate)
        : firm.lastIngestedAt
          ? formatSamDate(firm.lastIngestedAt)
          : `01/01/${now.getFullYear()}`
      const postedTo = formatSamDate(now)

      let offset = 0
      const pageSize = params.limit ?? 25
      let totalFound = 0
      let totalIngested = 0
      let totalErrors = 0

      while (true) {
        const response = await requestSamPage({
          api_key: apiKey,
          postedFrom,
          postedTo,
          // SAM.gov v2 search filters NAICS via `ncode`; `naicsCode` is
          // silently ignored and returns the entire date-window result set.
          ncode: params.naicsCode,
          limit: pageSize,
          offset,
        })

        const records = response.data.opportunitiesData ?? []
        if (records.length === 0) break
        totalFound += records.length

        for (const record of records) {
          try {
            const existing = await prisma.opportunity.findUnique({
              where: {
                consultingFirmId_samNoticeId: {
                  consultingFirmId,
                  samNoticeId: record.noticeId,
                },
              },
              include: { amendments: true },
            })

            const title = record.title ?? "Untitled Opportunity"
            const description = record.description ?? null
            const vehicleMatch = detectVehicleFromOpportunity({
              title,
              description,
              noticeType: record.type ?? null,
            })

            const mappedData = {
              title,
              description,
              agency:
                record.fullParentPathName ??
                record.organizationType ??
                "Unknown Agency",
              // Empty string (the column default) when SAM omits the code —
              // never a synthesized "000000". SAM leaves NAICS off whole notice
              // classes (sources-sought, intent-to-sole-source, many RFQs), and
              // the old placeholder was indistinguishable from a real code
              // downstream: it satisfied the MCP's ^\d{6}$ NAICS filter, counted
              // as its own sector in analytics groupBys, and made "no code
              // published" look like data. Absence is now representable.
              naicsCode: record.naicsCode ?? "",
              // Product/Service Code (SAM.gov `classificationCode`). Null when
              // the feed omits it — the matching-v2 scorer treats absent PSC as
              // a non-penalizing dimension. SAM opportunities carry no PSC title,
              // so pscDescription stays null until enriched from the PSC table.
              psc: record.classificationCode ?? null,
              pscDescription: null,
              noticeType: record.type ?? null,
              // Shared between a solicitation and its Award Notice — the join
              // key that routes awards to firms with SUBMITTED pursuits.
              solicitationNumber: record.solicitationNumber ?? null,
              setAsideType: mapSetAside(record.typeOfSetAside),
              // SAM states a dollar value only on award notices; capture it when
              // present so contractValueFit isn't stuck at neutral. Most active
              // solicitations carry no value (stays null -> historical proxy).
              estimatedValue: record.award?.amount != null ? Number(record.award.amount) : null,
              postedDate: record.postedDate ? new Date(record.postedDate) : null,
              responseDeadline: resolveResponseDeadline(record, now),
              archiveDate: record.archiveDate ? new Date(record.archiveDate) : null,
              contractVehicle: vehicleMatch?.vehicle ?? null,
              vehicleType: vehicleMatch?.type ?? null,
              vehicleConfidence: vehicleMatch?.confidence ?? null,
              sourceUrl: (() => {
                const ui = record.uiLink
                // SAM.gov sometimes returns an API URL (api.sam.gov/...) instead of
                // the web UI URL. Always normalise to the canonical web UI link.
                if (ui && ui.startsWith('https://sam.gov/')) return ui
                // Fall back to canonical web UI pattern using noticeId
                if (record.noticeId) return `https://sam.gov/opp/${record.noticeId}/view`
                return ui ?? null
              })(),
            }

            // A cancellation notice type marks the opportunity CANCELLED rather
            // than silently leaving it ACTIVE.
            const isCancellation = isCancellationNotice(record.type)

            if (!existing) {
              await prisma.opportunity.create({
                data: {
                  consultingFirmId,
                  samNoticeId: record.noticeId,
                  ...mappedData,
                  source: "SAM_GOV",
                  marketCategory: "SERVICES",
                  status: isCancellation ? "CANCELLED" : "ACTIVE",
                  probabilityScore: 0,
                  expectedValue: 0,
                  isScored: false,
                },
              })
              totalIngested++
            } else if (isManualProtected(existing.source)) {
              // Manual, firm-entered records are protected: ingestion never
              // overwrites them (nor touches their amendments below).
              continue
            } else {
              const changed =
                existing.responseDeadline.getTime() !==
                  (mappedData.responseDeadline?.getTime() ?? 0) ||
                existing.setAsideType !== mappedData.setAsideType ||
                existing.title !== mappedData.title ||
                (isCancellation && existing.status !== "CANCELLED")

              if (changed) {
                await prisma.opportunity.update({
                  where: { id: existing.id },
                  data: { ...mappedData, isScored: false, ...(isCancellation ? { status: "CANCELLED" as const } : {}) },
                })
              }
            }

            // Amendment persistence
            if (record.modifications?.length) {
              const opportunityId =
                existing?.id ??
                (
                  await prisma.opportunity.findUnique({
                    where: {
                      consultingFirmId_samNoticeId: {
                        consultingFirmId,
                        samNoticeId: record.noticeId,
                      },
                    },
                  })
                )?.id

              if (opportunityId) {
                for (const mod of record.modifications) {
                  await prisma.amendment.upsert({
                    where: { id: `${record.noticeId}_${mod.modNumber}` },
                    update: {
                      title: mod.modTitle ?? null,
                      description: mod.modDescription ?? null,
                      postedDate: mod.modDate ? new Date(mod.modDate) : null,
                    },
                    create: {
                      id: `${record.noticeId}_${mod.modNumber}`,
                      opportunityId,
                      amendmentNo: mod.modNumber,
                      amendmentNumber: mod.modNumber,
                      title: mod.modTitle ?? null,
                      description: mod.modDescription ?? null,
                      postedDate: mod.modDate ? new Date(mod.modDate) : null,
                    },
                  })
                }
              }
            }
          } catch (recordErr: any) {
            logger.warn("Failed to process SAM record", {
              noticeId: record.noticeId,
              error: recordErr.message,
            })
            totalErrors++
          }
        }

        offset += pageSize
        if (records.length < pageSize) break
        // Bounded ingest (e.g. signup starter board): stop once we've pulled
        // enough so we don't paginate the entire date window.
        if (params.maxRecords && totalFound >= params.maxRecords) break

        // Throttle between pages to respect SAM.gov rate limits (~10 req/sec)
        await new Promise((r) => setTimeout(r, 1200))
      }

      await prisma.consultingFirm.update({
        where: { id: consultingFirmId },
        data: { lastIngestedAt: now },
      })

      logger.info("SAM ingestion complete", {
        consultingFirmId,
        found: totalFound,
        ingested: totalIngested,
        errors: totalErrors,
      })

      return { success: true, found: totalFound, ingested: totalIngested, errors: totalErrors }
    } catch (error: any) {
      const status = error.response?.status
      const body   = error.response?.data
      const logContext: Record<string, any> = { error: error.message, status, body }
      if (status === 429) {
        logContext.endpoint = error.config?.url
        logContext.retryAfter = error.response?.headers?.["retry-after"]
      }
      logger.error("SAM ingestion failed", logContext)

      if (status === 429) {
        throw new Error(
          "Sync paused: Daily data refresh quota reached for the SAM.gov source feed. " +
          "The system will automatically resume ingestion during the next scheduled window. " +
          "No action is required."
        )
      }
      if (status === 401 || status === 403) {
        throw new Error(
          `SAM.gov API key rejected (HTTP ${status}). Verify SAM_API_KEY in backend/.env.`
        )
      }
      if (status) {
        const detail = typeof body === "object" ? JSON.stringify(body) : String(body ?? "")
        throw new Error(`SAM.gov returned HTTP ${status}: ${detail.slice(0, 200)}`)
      }
      throw new Error(`SAM.gov request failed: ${error.message}`)
    }
  },
}