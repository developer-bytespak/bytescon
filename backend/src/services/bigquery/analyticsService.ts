// =============================================================
// BigQuery Analytics Service
// Decision-intelligence queries on award_history table
// =============================================================
import { getBigQuery, GCP_PROJECT_ID, BQ_DATASET, BQ_TABLES } from '../../config/bigquery'
import { logger } from '../../utils/logger'

const FULL_TABLE = (t: string) =>
  `\`${GCP_PROJECT_ID}.${BQ_DATASET}.${t}\``

// ── Types ─────────────────────────────────────────────────────

export interface CompetitionProfile {
  naicsCode: string
  agency?: string
  totalAwards: number
  totalAmount: number
  avgAwardAmount: number
  medianAwardAmount: number
  uniqueWinners: number
  avgOffersReceived: number | null
  winnerConcentrationHHI: number   // 0-1, higher = more concentrated
  topWinners: {
    name: string
    wins: number
    totalAmount: number
    shareOfWins: number
  }[]
  setAsideBreakdown: { type: string; count: number; pct: number }[]
  yearlySummary: { year: number; awards: number; totalAmount: number }[]
  dataPoints: number
}

export interface AgencyProfile {
  agency: string
  totalAwards: number
  totalAmount: number
  avgAwardAmount: number
  smallBizRate: number
  sdvosbRate: number
  wosbRate: number
  hubzoneRate: number
  topNaicsCodes: { naics: string; count: number }[]
  competitiveness: 'HIGH' | 'MEDIUM' | 'LOW'   // derived from avg offers
  dataPoints: number
}

export interface ContractorProfile {
  name: string
  totalWins: number
  totalAmount: number
  avgAwardAmount: number
  agencies: { agency: string; wins: number }[]
  naicsCodes: { naics: string; wins: number }[]
  recentWin: string | null
}

export interface MarketSnapshot {
  naicsCodes: string[]
  totalOpportunityVolume: number
  avgContractSize: number
  competitorCount: number
  yearsBack: number
  topAgencies: { agency: string; awards: number; amount: number }[]
  heatmap: {
    naicsCode: string
    awards: number
    avgAmount: number
    concentration: number  // HHI 0-1
    uniqueWinners: number
    avgOffers: number | null
    /** Award counts per quarter, oldest → newest. Length = 4 × yearsBack. */
    trendBuckets: number[]
    /** Set-aside mix for this NAICS — counts + share, sorted by count desc. */
    setAsideBreakdown: { type: string; count: number; pct: number }[]
  }[]
}

// ── Queries ───────────────────────────────────────────────────

// #29: award_history is append-only — the weekly refresh re-inserts the same
// awards, which inflates COUNT/AVG/SUM aggregates. Until an ingest-time
// MERGE/staging upsert is added, dedup at query time: keep only the latest row
// per natural key (contractNumber, or a recipient+date+amount composite when
// contractNumber is null). Changes only SELECTs (no data mutation). NOTE:
// VALIDATE against the live BigQuery dataset before relying on these numbers —
// see CODE_REVIEW_2026-06-27.md (#29).
function dedupedAwards(): string {
  return `(
    SELECT * EXCEPT(_dedup_rn) FROM (
      SELECT *, ROW_NUMBER() OVER (
        PARTITION BY COALESCE(
          contractNumber,
          CONCAT(IFNULL(naicsCode, ''), '|', IFNULL(recipientName, ''), '|', IFNULL(CAST(awardDate AS STRING), ''), '|', IFNULL(CAST(awardAmount AS STRING), ''))
        )
        -- Keep ONE row per physical award, preferring the row that carries a real
        -- awarding agency over a generic 'ALL' row: the bulk weekly refresh writes
        -- agency='ALL' while the admin per-agency ingest writes the real name for
        -- the same contractNumber. Without the agency-preference tiebreaker an
        -- 'ALL' refresh would win on recency and erase agency-attributed rows from
        -- agency-scoped queries (getAgencyProfile, top_agencies).
        ORDER BY (CASE WHEN UPPER(TRIM(IFNULL(agency, ''))) = 'ALL' THEN 1 ELSE 0 END), ingestedAt DESC
      ) AS _dedup_rn
      FROM ${FULL_TABLE(BQ_TABLES.AWARD_HISTORY)}
    ) WHERE _dedup_rn = 1
  )`
}

/**
 * Full competition profile for a NAICS code.
 * Core input for Market Score and decision intelligence.
 */
export async function getCompetitionProfile(
  naicsCode: string,
  agency?: string
): Promise<CompetitionProfile | null> {
  const bq = getBigQuery()

  const agencyFilter = agency ? `AND agency = @agency` : ''

  const query = `
    WITH base AS (
      SELECT
        recipientName,
        awardAmount,
        awardDate,
        offersReceived,
        setAsideType,
        EXTRACT(YEAR FROM SAFE.PARSE_DATE('%Y-%m-%d', SUBSTR(CAST(awardDate AS STRING), 1, 10))) AS awardYear
      FROM ${dedupedAwards()}
      WHERE naicsCode = @naicsCode
        ${agencyFilter}
        AND awardAmount > 0
    ),
    summary AS (
      SELECT
        COUNT(*) AS totalAwards,
        SUM(awardAmount) AS totalAmount,
        AVG(awardAmount) AS avgAwardAmount,
        COUNT(DISTINCT recipientName) AS uniqueWinners,
        AVG(offersReceived) AS avgOffersReceived
      FROM base
    ),
    winner_counts AS (
      SELECT
        recipientName,
        COUNT(*) AS wins,
        SUM(awardAmount) AS totalAmount
      FROM base
      GROUP BY recipientName
      ORDER BY wins DESC
      LIMIT 10
    ),
    hhi AS (
      SELECT
        SUM(POWER(winShare, 2)) AS hhi
      FROM (
        SELECT
          COUNT(*) / (SELECT COUNT(*) FROM base) AS winShare
        FROM base
        GROUP BY recipientName
      )
    ),
    setaside AS (
      SELECT
        COALESCE(setAsideType, 'UNKNOWN') AS setAsideType,
        COUNT(*) AS cnt
      FROM base
      GROUP BY setAsideType
    ),
    yearly AS (
      SELECT
        awardYear AS year,
        COUNT(*) AS awards,
        SUM(awardAmount) AS totalAmount
      FROM base
      WHERE awardYear IS NOT NULL
      GROUP BY awardYear
      ORDER BY awardYear DESC
      LIMIT 6
    )
    SELECT
      s.totalAwards,
      s.totalAmount,
      s.avgAwardAmount,
      s.uniqueWinners,
      s.avgOffersReceived,
      h.hhi AS winnerConcentrationHHI,
      TO_JSON_STRING(ARRAY(SELECT AS STRUCT recipientName, wins, totalAmount FROM winner_counts)) AS topWinnersJson,
      TO_JSON_STRING(ARRAY(SELECT AS STRUCT setAsideType, cnt FROM setaside)) AS setAsideJson,
      TO_JSON_STRING(ARRAY(SELECT AS STRUCT year, awards, totalAmount FROM yearly)) AS yearlyJson
    FROM summary s, hhi h
  `

  try {
    const [rows] = await bq.query({
      query,
      params: { naicsCode, ...(agency ? { agency } : {}) },
      location: 'US',
    })

    if (!rows || rows.length === 0) return null
    const r = rows[0]

    const totalAwards = Number(r.totalAwards ?? 0)
    const topWinners = JSON.parse(r.topWinnersJson ?? '[]').map((w: Record<string, unknown>) => ({
      name: w.recipientName as string,
      wins: Number(w.wins),
      totalAmount: Number(w.totalAmount),
      shareOfWins: totalAwards > 0 ? Number(w.wins) / totalAwards : 0,
    }))

    const setAsideRaw = JSON.parse(r.setAsideJson ?? '[]')
    const setTotal = setAsideRaw.reduce((s: number, x: { cnt: number }) => s + Number(x.cnt), 0)
    const setAsideBreakdown = setAsideRaw.map((x: { setAsideType: string; cnt: number }) => ({
      type: x.setAsideType,
      count: Number(x.cnt),
      pct: setTotal > 0 ? Number(x.cnt) / setTotal : 0,
    }))

    const yearlySummary = JSON.parse(r.yearlyJson ?? '[]').map((y: Record<string, unknown>) => ({
      year: Number(y.year),
      awards: Number(y.awards),
      totalAmount: Number(y.totalAmount),
    }))

    return {
      naicsCode,
      agency,
      totalAwards,
      totalAmount: Number(r.totalAmount ?? 0),
      avgAwardAmount: Number(r.avgAwardAmount ?? 0),
      medianAwardAmount: 0, // BigQuery median requires APPROX_QUANTILES; skipped for cost
      uniqueWinners: Number(r.uniqueWinners ?? 0),
      avgOffersReceived: r.avgOffersReceived != null ? Number(r.avgOffersReceived) : null,
      winnerConcentrationHHI: Number(r.winnerConcentrationHHI ?? 0),
      topWinners,
      setAsideBreakdown,
      yearlySummary,
      dataPoints: totalAwards,
    }
  } catch (err) {
    logger.error('BQ getCompetitionProfile failed', { naicsCode, error: (err as Error).message })
    return null
  }
}

/**
 * Agency buying profile — set-aside rates, avg award, top NAICS codes.
 * Used to enhance compliance gate context and agency alignment scoring.
 */
export async function getAgencyProfile(agency: string): Promise<AgencyProfile | null> {
  const bq = getBigQuery()

  const query = `
    WITH base AS (
      SELECT
        recipientName,
        awardAmount,
        setAsideType,
        naicsCode
      FROM ${dedupedAwards()}
      WHERE agency = @agency
        AND awardAmount > 0
    ),
    totals AS (
      SELECT
        COUNT(*) AS totalAwards,
        SUM(awardAmount) AS totalAmount,
        AVG(awardAmount) AS avgAward,
        COUNTIF(UPPER(COALESCE(setAsideType,'')) LIKE '%SMALL%') AS smallBizCount,
        COUNTIF(UPPER(COALESCE(setAsideType,'')) LIKE '%SDVOSB%'
             OR UPPER(COALESCE(setAsideType,'')) LIKE '%SERVICE-DISABLED%') AS sdvosbCount,
        COUNTIF(UPPER(COALESCE(setAsideType,'')) LIKE '%WOSB%'
             OR UPPER(COALESCE(setAsideType,'')) LIKE '%WOMEN%') AS wosbCount,
        COUNTIF(UPPER(COALESCE(setAsideType,'')) LIKE '%HUBZONE%') AS hubzoneCount
      FROM base
    ),
    top_naics AS (
      SELECT naicsCode, COUNT(*) AS cnt
      FROM base
      GROUP BY naicsCode
      ORDER BY cnt DESC
      LIMIT 8
    )
    SELECT
      t.totalAwards,
      t.totalAmount,
      t.avgAward,
      t.smallBizCount,
      t.sdvosbCount,
      t.wosbCount,
      t.hubzoneCount,
      TO_JSON_STRING(ARRAY(SELECT AS STRUCT naicsCode, cnt FROM top_naics)) AS topNaicsJson
    FROM totals t
  `

  try {
    const [rows] = await bq.query({ query, params: { agency }, location: 'US' })
    if (!rows || rows.length === 0) return null
    const r = rows[0]

    const totalAwards = Number(r.totalAwards ?? 0)
    const smallBizRate = totalAwards > 0 ? Number(r.smallBizCount) / totalAwards : 0
    const sdvosbRate   = totalAwards > 0 ? Number(r.sdvosbCount)   / totalAwards : 0
    const wosbRate     = totalAwards > 0 ? Number(r.wosbCount)      / totalAwards : 0
    const hubzoneRate  = totalAwards > 0 ? Number(r.hubzoneCount)   / totalAwards : 0

    // Competitiveness proxy: we don't have offers at agency level easily, use SB rate
    const competitiveness: 'HIGH' | 'MEDIUM' | 'LOW' =
      smallBizRate > 0.6 ? 'HIGH' : smallBizRate > 0.3 ? 'MEDIUM' : 'LOW'

    const topNaicsCodes = JSON.parse(r.topNaicsJson ?? '[]').map(
      (x: { naicsCode: string; cnt: number }) => ({ naics: x.naicsCode, count: Number(x.cnt) })
    )

    return {
      agency,
      totalAwards,
      totalAmount: Number(r.totalAmount ?? 0),
      avgAwardAmount: Number(r.avgAward ?? 0),
      smallBizRate,
      sdvosbRate,
      wosbRate,
      hubzoneRate,
      topNaicsCodes,
      competitiveness,
      dataPoints: totalAwards,
    }
  } catch (err) {
    logger.error('BQ getAgencyProfile failed', { agency, error: (err as Error).message })
    return null
  }
}

/**
 * Contractor win history — used for incumbent analysis and competitor intelligence.
 */
export async function getContractorProfile(recipientName: string): Promise<ContractorProfile | null> {
  const bq = getBigQuery()

  const query = `
    WITH base AS (
      SELECT agency, naicsCode, awardAmount, awardDate
      FROM ${dedupedAwards()}
      WHERE UPPER(recipientName) = UPPER(@recipientName)
        AND awardAmount > 0
    )
    SELECT
      COUNT(*) AS totalWins,
      SUM(awardAmount) AS totalAmount,
      AVG(awardAmount) AS avgAward,
      MAX(awardDate) AS recentWin,
      TO_JSON_STRING(ARRAY(
        SELECT AS STRUCT agency, COUNT(*) AS wins
        FROM base GROUP BY agency ORDER BY wins DESC LIMIT 6
      )) AS agenciesJson,
      TO_JSON_STRING(ARRAY(
        SELECT AS STRUCT naicsCode, COUNT(*) AS wins
        FROM base GROUP BY naicsCode ORDER BY wins DESC LIMIT 6
      )) AS naicsJson
    FROM base
  `

  try {
    const [rows] = await bq.query({ query, params: { recipientName }, location: 'US' })
    if (!rows || rows.length === 0 || !rows[0].totalWins) return null
    const r = rows[0]

    return {
      name: recipientName,
      totalWins: Number(r.totalWins),
      totalAmount: Number(r.totalAmount),
      avgAwardAmount: Number(r.avgAward),
      recentWin: r.recentWin ?? null,
      agencies: JSON.parse(r.agenciesJson ?? '[]').map(
        (x: { agency: string; wins: number }) => ({ agency: x.agency, wins: Number(x.wins) })
      ),
      naicsCodes: JSON.parse(r.naicsJson ?? '[]').map(
        (x: { naicsCode: string; wins: number }) => ({ naics: x.naicsCode, wins: Number(x.wins) })
      ),
    }
  } catch (err) {
    logger.error('BQ getContractorProfile failed', { recipientName, error: (err as Error).message })
    return null
  }
}

/**
 * Multi-NAICS market snapshot — firm-wide competitive landscape.
 * Returns the overall market context for a firm's NAICS portfolio.
 */
export async function getMarketSnapshot(
  naicsCodes: string[],
  opts: { yearsBack?: number } = {},
): Promise<MarketSnapshot | null> {
  if (naicsCodes.length === 0) return null
  const bq = getBigQuery()

  const yearsBack = Math.min(10, Math.max(1, opts.yearsBack ?? 5))
  const startDate = new Date(Date.now() - yearsBack * 365 * 24 * 60 * 60 * 1000)
    .toISOString()
    .split('T')[0]

  // BigQuery doesn't support IN with @param arrays directly; build a literal list.
  // NAICS codes are strictly numeric — sanitize to digits only so user-controlled
  // values can never break out of the string literal (SQL-injection hardening).
  const safeNaics = naicsCodes
    .map((c) => String(c).replace(/[^0-9]/g, ''))
    .filter((c) => c.length > 0)
  if (safeNaics.length === 0) return null
  const naicsLiteral = safeNaics.map((c) => `'${c}'`).join(',')

  const query = `
    WITH base AS (
      SELECT naicsCode, agency, awardAmount, recipientName, offersReceived, setAsideType,
             SAFE.PARSE_DATE('%Y-%m-%d', SUBSTR(CAST(awardDate AS STRING), 1, 10)) AS dt
      FROM ${dedupedAwards()}
      WHERE naicsCode IN (${naicsLiteral})
        AND awardAmount > 0
        AND SAFE.PARSE_DATE('%Y-%m-%d', SUBSTR(CAST(awardDate AS STRING), 1, 10)) >= DATE('${startDate}')
    ),
    heatmap AS (
      SELECT
        naicsCode,
        COUNT(*) AS awards,
        AVG(awardAmount) AS avgAmount,
        COUNT(DISTINCT recipientName) AS uniqueWinners,
        AVG(offersReceived) AS avgOffers
      FROM base
      GROUP BY naicsCode
    ),
    quarterly AS (
      SELECT
        naicsCode,
        DATE_TRUNC(dt, QUARTER) AS qtr,
        COUNT(*) AS cnt
      FROM base
      WHERE dt IS NOT NULL
      GROUP BY naicsCode, qtr
    ),
    quarterly_json AS (
      SELECT
        naicsCode,
        TO_JSON_STRING(ARRAY_AGG(STRUCT(qtr AS quarter, cnt) ORDER BY qtr ASC)) AS bucketsJson
      FROM quarterly
      GROUP BY naicsCode
    ),
    setaside AS (
      SELECT
        naicsCode,
        COALESCE(setAsideType, 'UNKNOWN') AS setAsideType,
        COUNT(*) AS cnt
      FROM base
      GROUP BY naicsCode, setAsideType
    ),
    setaside_json AS (
      SELECT
        naicsCode,
        TO_JSON_STRING(ARRAY_AGG(STRUCT(setAsideType, cnt) ORDER BY cnt DESC)) AS setAsideJson
      FROM setaside
      GROUP BY naicsCode
    ),
    heatmap_with_trend AS (
      SELECT h.naicsCode, h.awards, h.avgAmount, h.uniqueWinners, h.avgOffers, q.bucketsJson, sa.setAsideJson
      FROM heatmap h
      LEFT JOIN quarterly_json q USING (naicsCode)
      LEFT JOIN setaside_json sa USING (naicsCode)
    ),
    top_agencies AS (
      SELECT agency, COUNT(*) AS awards, SUM(awardAmount) AS amount
      FROM base
      WHERE agency IS NOT NULL
        AND TRIM(agency) != ''
        AND UPPER(TRIM(agency)) != 'ALL'
      GROUP BY agency
      ORDER BY awards DESC
      LIMIT 12
    )
    SELECT
      COUNT(*) AS totalAwards,
      SUM(awardAmount) AS totalAmount,
      AVG(awardAmount) AS avgAwardAmount,
      COUNT(DISTINCT recipientName) AS competitorCount,
      TO_JSON_STRING(ARRAY(SELECT AS STRUCT agency, awards, amount FROM top_agencies)) AS agenciesJson,
      TO_JSON_STRING(ARRAY(SELECT AS STRUCT naicsCode, awards, avgAmount, uniqueWinners, avgOffers, bucketsJson, setAsideJson FROM heatmap_with_trend)) AS heatmapJson
    FROM base
  `

  try {
    const [rows] = await bq.query({ query, location: 'US' })
    if (!rows || rows.length === 0) return null
    const r = rows[0]

    const topAgencies = JSON.parse(r.agenciesJson ?? '[]').map(
      (x: { agency: string; awards: number; amount: number }) => ({
        agency: x.agency,
        awards: Number(x.awards),
        amount: Number(x.amount),
      })
    )

    // Build the quarter timeline for the requested window so all NAICS rows
    // align on the same x-axis even when some quarters had zero awards.
    const totalQuarters = yearsBack * 4
    const now = new Date()
    const quarterStarts: string[] = []
    for (let q = totalQuarters - 1; q >= 0; q--) {
      const d = new Date(now.getFullYear(), now.getMonth() - 3 * q, 1)
      // Snap to quarter start month (0, 3, 6, 9)
      const qMonth = Math.floor(d.getMonth() / 3) * 3
      const qStart = new Date(d.getFullYear(), qMonth, 1).toISOString().split('T')[0]
      quarterStarts.push(qStart)
    }

    const heatmap = JSON.parse(r.heatmapJson ?? '[]').map(
      (x: { naicsCode: string; awards: number; avgAmount: number; uniqueWinners: number; avgOffers: number | null; bucketsJson: string | null; setAsideJson: string | null }) => {
        const n = Number(x.uniqueWinners ?? 1)
        const awards = Number(x.awards ?? 0)
        // Simple HHI proxy: if 1 winner takes everything, HHI = 1; many winners → low
        const concentration = awards > 0 ? Math.min(1 / Math.max(n, 1), 1) : 0

        // Set-aside mix for this NAICS (counts + share), sorted by count desc.
        let setAsideBreakdown: { type: string; count: number; pct: number }[] = []
        if (x.setAsideJson) {
          try {
            const raw: Array<{ setAsideType: string; cnt: number }> = JSON.parse(x.setAsideJson)
            const tot = raw.reduce((s, b) => s + Number(b.cnt || 0), 0)
            setAsideBreakdown = raw.map((b) => ({
              type: b.setAsideType,
              count: Number(b.cnt || 0),
              pct: tot > 0 ? Number(b.cnt || 0) / tot : 0,
            }))
          } catch { /* leave [] */ }
        }

        // Map quarterly buckets to fixed timeline (zero-fill missing quarters)
        let trendBuckets: number[] = new Array(totalQuarters).fill(0)
        if (x.bucketsJson) {
          try {
            const parsed: Array<{ quarter: { value: string } | string; cnt: number }> = JSON.parse(x.bucketsJson)
            const indexByDate: Record<string, number> = {}
            quarterStarts.forEach((d, i) => { indexByDate[d] = i })
            for (const b of parsed) {
              const qStr = typeof b.quarter === 'string' ? b.quarter : b.quarter?.value
              if (!qStr) continue
              const idx = indexByDate[qStr]
              if (idx != null) trendBuckets[idx] = Number(b.cnt) || 0
            }
          } catch { /* leave zeros */ }
        }

        return {
          naicsCode: x.naicsCode,
          awards,
          avgAmount: Number(x.avgAmount ?? 0),
          concentration,
          uniqueWinners: n,
          avgOffers: x.avgOffers != null ? Number(x.avgOffers) : null,
          trendBuckets,
          setAsideBreakdown,
        }
      }
    )

    return {
      naicsCodes,
      totalOpportunityVolume: Number(r.totalAmount ?? 0),
      avgContractSize: Number(r.avgAwardAmount ?? 0),
      competitorCount: Number(r.competitorCount ?? 0),
      yearsBack,
      topAgencies,
      heatmap,
    }
  } catch (err) {
    logger.error('BQ getMarketSnapshot failed', { naicsCodes, error: (err as Error).message })
    return null
  }
}

/**
 * Count of rows in award_history — used to determine if data has been ingested.
 */
export async function getAwardHistoryCount(): Promise<number> {
  const bq = getBigQuery()
  try {
    const [rows] = await bq.query({
      query: `SELECT COUNT(*) AS cnt FROM ${FULL_TABLE(BQ_TABLES.AWARD_HISTORY)}`,
      location: 'US',
    })
    return Number(rows?.[0]?.cnt ?? 0)
  } catch {
    return -1  // -1 = table not yet accessible (not yet ingested or BQ not connected)
  }
}
