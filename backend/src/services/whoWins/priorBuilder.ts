// =============================================================
// Who-Wins — segment priors with empirical-Bayes shrinkage.
//
// The calibrated LEVEL of the model: for each (NAICS level × set-aside
// bucket) segment, E[1/K] over awards with known offers K is the win
// rate of a random qualified entrant — calibrated by construction
// (every award has exactly one winner). Two deliberate choices from
// docs/WHO_WINS_MODEL.md:
//   • E[1/K] (mean of reciprocals), NOT 1/E[K] — Jensen's inequality;
//     the latter understates the entrant win rate whenever K varies.
//   • Top-down pseudo-count shrinkage GLOBAL → NAICS2 → NAICS4 → NAICS6,
//     each level shrinking toward the ALREADY-SHRUNK parent:
//     shrunk = (n·obs + m·parent) / (n + m). Sparse cells follow their
//     parent; dense cells follow themselves.
// =============================================================

import { prisma } from '../../config/database'
import { logger } from '../../utils/logger'
import { bucketFromFpdsCode, SetAsideBucket } from './setAside'
import { loadAwardsChronologically } from './corpus'

/** Prior equivalent sample size for shrinkage. n ≪ m ⇒ parent dominates. */
export const DEFAULT_PSEUDO_COUNT = 25

export type SegmentLevel = 'GLOBAL' | 'NAICS2' | 'NAICS4' | 'NAICS6'
const LEVELS: { level: SegmentLevel; prefixLen: number }[] = [
  { level: 'GLOBAL', prefixLen: 0 },
  { level: 'NAICS2', prefixLen: 2 },
  { level: 'NAICS4', prefixLen: 4 },
  { level: 'NAICS6', prefixLen: 6 },
]

interface RawAward {
  naicsCode: string
  setAsideCode: string | null
  offersReceived: number | null
  recipientUei: string
  recipientParentUei: string | null
  actionDate: Date
}

interface SegmentAccumulator {
  awardCount: number
  offersKnownCount: number
  sumInvOffers: number
  sumOffers: number
  offersValues: number[]
  singleOfferCount: number
  incumbentWins: number
}

function newAcc(): SegmentAccumulator {
  return { awardCount: 0, offersKnownCount: 0, sumInvOffers: 0, sumOffers: 0, offersValues: [], singleOfferCount: 0, incumbentWins: 0 }
}

/** Pseudo-count blend of an observed rate toward the parent estimate. */
export function shrink(obs: number, n: number, parent: number, m: number): number {
  if (n <= 0) return parent
  return (n * obs + m * parent) / (n + m)
}

function median(xs: number[]): number | null {
  if (!xs.length) return null
  const s = [...xs].sort((a, b) => a - b)
  const mid = Math.floor(s.length / 2)
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2
}

/**
 * Build and persist the full prior table for a model version.
 *
 * Incumbency: an award counts as an "incumbent win" when its recipient (UEI
 * or parent UEI) already won an earlier award in the same NAICS-4. Computed
 * in one chronological pass per NAICS-4 with a seen-set — O(N) total.
 */
export async function buildPriors(modelVersion: string, pseudoCount: number = DEFAULT_PSEUDO_COUNT): Promise<{ segments: number; awards: number }> {
  // Cursor-batched — a single findMany over the multi-million-row corpus
  // exceeds Prisma's single-result string limit (see corpus.ts).
  const awards: RawAward[] = await loadAwardsChronologically<RawAward>({
    naicsCode: true, setAsideCode: true, offersReceived: true,
    recipientUei: true, recipientParentUei: true, actionDate: true,
  })
  if (awards.length === 0) throw new Error('public_award_training is empty — run the ingest first')

  // First pass: incumbency flags (chronological, per NAICS-4).
  const seenByNaics4 = new Map<string, Set<string>>()
  const incumbentFlags: boolean[] = new Array(awards.length)
  for (let i = 0; i < awards.length; i++) {
    const a = awards[i]
    const n4 = a.naicsCode.slice(0, 4)
    let seen = seenByNaics4.get(n4)
    if (!seen) { seen = new Set(); seenByNaics4.set(n4, seen) }
    const ids = [a.recipientUei, a.recipientParentUei].filter(Boolean) as string[]
    incumbentFlags[i] = ids.some((id) => seen.has(id))
    for (const id of ids) seen.add(id)
  }

  // Second pass: accumulate every (level × prefix × bucket) cell, plus the
  // 'ANY' bucket per prefix (the set-aside-agnostic parent).
  const cells = new Map<string, SegmentAccumulator>()
  const key = (level: SegmentLevel, prefix: string, bucket: string) => `${level}|${prefix}|${bucket}`
  for (let i = 0; i < awards.length; i++) {
    const a = awards[i]
    const bucket = bucketFromFpdsCode(a.setAsideCode)
    for (const { level, prefixLen } of LEVELS) {
      const prefix = a.naicsCode.slice(0, prefixLen)
      for (const b of [bucket, 'ANY'] as const) {
        const k = key(level, prefix, b)
        let acc = cells.get(k)
        if (!acc) { acc = newAcc(); cells.set(k, acc) }
        acc.awardCount++
        if (incumbentFlags[i]) acc.incumbentWins++
        if (a.offersReceived !== null) {
          acc.offersKnownCount++
          // ENTRANT frame: the product's question is "if MY client bids, what
          // are OUR chances" — a prospective bidder JOINS the observed field,
          // making it K+1 offers. E[1/K] answers a different question (a
          // member of the observed field) and reads single-offer awards as
          // 100% — wildly optimistic for segments where sole bids are common
          // (services FPDS). E[1/(K+1)] treats an observed single-bid award
          // as ~50% for a joiner and caps the base rate at 0.5.
          acc.sumInvOffers += 1 / (a.offersReceived + 1)
          acc.sumOffers += a.offersReceived
          acc.offersValues.push(a.offersReceived)
          if (a.offersReceived === 1) acc.singleOfferCount++
        }
      }
    }
  }

  // Third pass: shrinkage, top-down. Parent chain: same bucket at the parent
  // NAICS level; the GLOBAL/ANY cell is the root climatology. Buckets with no
  // observations anywhere inherit the parent bucket estimate outright.
  interface ShrunkCell { meanInvOffers: number; incumbencyShare: number }
  const shrunk = new Map<string, ShrunkCell>()

  const globalAny = cells.get(key('GLOBAL', '', 'ANY'))!
  const rootInv = globalAny.offersKnownCount > 0 ? globalAny.sumInvOffers / globalAny.offersKnownCount : 0.33
  const rootInc = globalAny.awardCount > 0 ? globalAny.incumbentWins / globalAny.awardCount : 0.5
  shrunk.set(key('GLOBAL', '', 'ANY'), { meanInvOffers: rootInv, incumbencyShare: rootInc })

  const parentOf = (levelIdx: number, prefix: string, bucket: string): ShrunkCell => {
    if (levelIdx === 0) {
      // GLOBAL non-ANY buckets shrink toward GLOBAL/ANY.
      return shrunk.get(key('GLOBAL', '', 'ANY'))!
    }
    const parentLevel = LEVELS[levelIdx - 1]
    const parentPrefix = prefix.slice(0, parentLevel.prefixLen)
    return (
      shrunk.get(key(parentLevel.level, parentPrefix, bucket)) ??
      shrunk.get(key(parentLevel.level, parentPrefix, 'ANY')) ??
      shrunk.get(key('GLOBAL', '', 'ANY'))!
    )
  }

  const rows: {
    modelVersion: string; segmentLevel: string; naicsPrefix: string; setAsideBucket: string
    awardCount: number; offersKnownCount: number; meanInvOffers: number; shrunkMeanInvOffers: number
    meanOffers: number | null; medianOffers: number | null; singleOfferShare: number | null
    incumbencyShare: number | null; shrunkIncumbencyShare: number | null
  }[] = []

  for (let li = 0; li < LEVELS.length; li++) {
    const { level, prefixLen } = LEVELS[li]
    // Deterministic order: ANY first so child buckets can fall back to it.
    const cellKeys = [...cells.keys()]
      .filter((k) => k.startsWith(`${level}|`))
      .sort((a, b) => (a.endsWith('|ANY') === b.endsWith('|ANY') ? a.localeCompare(b) : a.endsWith('|ANY') ? -1 : 1))

    for (const k of cellKeys) {
      const [, prefix, bucket] = k.split('|')
      if (prefix.length !== prefixLen) continue
      const acc = cells.get(k)!
      const parent = parentOf(li, prefix, bucket)

      const obsInv = acc.offersKnownCount > 0 ? acc.sumInvOffers / acc.offersKnownCount : parent.meanInvOffers
      const obsInc = acc.awardCount > 0 ? acc.incumbentWins / acc.awardCount : parent.incumbencyShare
      const cell: ShrunkCell = {
        meanInvOffers: shrink(obsInv, acc.offersKnownCount, parent.meanInvOffers, pseudoCount),
        incumbencyShare: shrink(obsInc, acc.awardCount, parent.incumbencyShare, pseudoCount),
      }
      shrunk.set(k, cell)

      rows.push({
        modelVersion,
        segmentLevel: level,
        naicsPrefix: prefix,
        setAsideBucket: bucket,
        awardCount: acc.awardCount,
        offersKnownCount: acc.offersKnownCount,
        meanInvOffers: acc.offersKnownCount > 0 ? acc.sumInvOffers / acc.offersKnownCount : 0,
        shrunkMeanInvOffers: cell.meanInvOffers,
        meanOffers: acc.offersKnownCount > 0 ? acc.sumOffers / acc.offersKnownCount : null,
        medianOffers: median(acc.offersValues),
        singleOfferShare: acc.offersKnownCount > 0 ? acc.singleOfferCount / acc.offersKnownCount : null,
        incumbencyShare: acc.awardCount > 0 ? acc.incumbentWins / acc.awardCount : null,
        shrunkIncumbencyShare: cell.incumbencyShare,
      })
    }
  }

  await prisma.publicWinPrior.deleteMany({ where: { modelVersion } })
  for (let i = 0; i < rows.length; i += 1000) {
    await prisma.publicWinPrior.createMany({ data: rows.slice(i, i + 1000) })
  }

  logger.info('WhoWins priors built', { modelVersion, segments: rows.length, awards: awards.length })
  return { segments: rows.length, awards: awards.length }
}

/** Walk the ladder at read time: most specific persisted segment first. */
export async function lookupPrior(
  modelVersion: string,
  naicsCode: string,
  bucket: SetAsideBucket,
): Promise<{ segmentLevel: SegmentLevel; naicsPrefix: string; shrunkMeanInvOffers: number; shrunkIncumbencyShare: number | null; awardCount: number; meanOffers: number | null } | null> {
  const clean = naicsCode.replace(/\D/g, '')
  const candidates: { segmentLevel: SegmentLevel; naicsPrefix: string }[] = []
  if (clean.length >= 6) candidates.push({ segmentLevel: 'NAICS6', naicsPrefix: clean.slice(0, 6) })
  if (clean.length >= 4) candidates.push({ segmentLevel: 'NAICS4', naicsPrefix: clean.slice(0, 4) })
  if (clean.length >= 2) candidates.push({ segmentLevel: 'NAICS2', naicsPrefix: clean.slice(0, 2) })
  candidates.push({ segmentLevel: 'GLOBAL', naicsPrefix: '' })

  for (const c of candidates) {
    for (const b of [bucket, 'ANY'] as const) {
      const row = await prisma.publicWinPrior.findUnique({
        where: {
          modelVersion_segmentLevel_naicsPrefix_setAsideBucket: {
            modelVersion, segmentLevel: c.segmentLevel, naicsPrefix: c.naicsPrefix, setAsideBucket: b,
          },
        },
      })
      if (row) {
        return {
          segmentLevel: c.segmentLevel as SegmentLevel,
          naicsPrefix: c.naicsPrefix,
          shrunkMeanInvOffers: row.shrunkMeanInvOffers,
          shrunkIncumbencyShare: row.shrunkIncumbencyShare,
          awardCount: row.awardCount,
          meanOffers: row.meanOffers,
        }
      }
    }
  }
  return null
}
