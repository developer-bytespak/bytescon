// =============================================================
// Who-Wins — matchup-model training + out-of-time evaluation.
//
// Framing (docs/WHO_WINS_MODEL.md §1, §4, §5): conditional logit over
// candidate sets of {actual winner + N uniformly sampled other winners
// from the same NAICS-4}. Features are strictly time-filtered ("history
// BEFORE this award's action date") to prevent target leakage, and every
// feature is computable for a real ClientCompany at scoring time.
//
// Evaluation is TEMPORAL: train on FY ≤ trainMaxFy, evaluate ranking
// lift + prior stability on later FYs, against honest baselines
// (random = 1/candidates; experience-only ranking). Random splits leak
// recompete pairs — the exact failure that sank the old backtest.
// =============================================================

import { prisma } from '../../config/database'
import { logger } from '../../utils/logger'
import { fitConditionalLogit, mulberry32, standardize, utility } from './conditionalLogit'
import { bucketFromFpdsCode } from './setAside'
import { shrink, DEFAULT_PSEUDO_COUNT } from './priorBuilder'
import { loadAwardsChronologically } from './corpus'

export const FEATURE_NAMES = [
  'experienceSegment', // log1p(prior awards in this NAICS-4)
  'experienceAgency',  // log1p(prior awards at this awarding agency)
  'recency',           // exp(-months since last NAICS-4 award / 24)
  'sizeAlignment',     // -|log(median prior award $) - log(this award $)|, clamped [-3, 0]
  'setAsideFit',       // log1p(prior awards under this award's set-aside bucket)
] as const

export interface TrainingConfig {
  negativesPerAward: number
  seed: number
  trainMaxFy: number
  minSegmentWinners: number
  maxGroups: number
  l2: number
}


export const DEFAULT_TRAINING_CONFIG: TrainingConfig = {
  negativesPerAward: 9,
  seed: 20260702,
  trainMaxFy: 2024,
  minSegmentWinners: 10,
  maxGroups: 60_000,
  l2: 1e-3,
}

interface AwardRow {
  naicsCode: string
  agencyCode: string | null
  setAsideCode: string | null
  offersReceived: number | null
  recipientUei: string
  recipientParentUei: string | null
  obligatedAmount: number
  actionDate: Date
  fiscalYear: number
}

/** Per-recipient chronological history — sorted arrays enable O(log n)
 *  "how many before date d" lookups via binary search. */
export interface RecipientHistory {
  /** naics4 -> sorted [timestamp, amount][] */
  bySegment: Map<string, { dates: number[]; amounts: number[] }>
  /** agencyCode -> sorted timestamps */
  byAgency: Map<string, number[]>
  /** setAsideBucket -> sorted timestamps */
  byBucket: Map<string, number[]>
}

export function countBefore(sorted: number[], t: number): number {
  let lo = 0, hi = sorted.length
  while (lo < hi) {
    const mid = (lo + hi) >> 1
    if (sorted[mid] < t) lo = mid + 1
    else hi = mid
  }
  return lo
}

export function buildHistories(awards: AwardRow[]): Map<string, RecipientHistory> {
  const histories = new Map<string, RecipientHistory>()
  const get = (uei: string): RecipientHistory => {
    let h = histories.get(uei)
    if (!h) { h = { bySegment: new Map(), byAgency: new Map(), byBucket: new Map() }; histories.set(uei, h) }
    return h
  }
  // Awards arrive chronologically sorted, so pushes keep arrays sorted.
  for (const a of awards) {
    const t = a.actionDate.getTime()
    const n4 = a.naicsCode.slice(0, 4)
    const bucket = bucketFromFpdsCode(a.setAsideCode)
    for (const id of new Set([a.recipientUei, a.recipientParentUei].filter(Boolean) as string[])) {
      const h = get(id)
      let seg = h.bySegment.get(n4)
      if (!seg) { seg = { dates: [], amounts: [] }; h.bySegment.set(n4, seg) }
      seg.dates.push(t)
      seg.amounts.push(a.obligatedAmount)
      if (a.agencyCode) {
        let ag = h.byAgency.get(a.agencyCode)
        if (!ag) { ag = []; h.byAgency.set(a.agencyCode, ag) }
        ag.push(t)
      }
      let bk = h.byBucket.get(bucket)
      if (!bk) { bk = []; h.byBucket.set(bucket, bk) }
      bk.push(t)
    }
  }
  return histories
}

const MONTH_MS = 30.44 * 24 * 3600 * 1000

/** Raw (unstandardized) features for candidate `uei` against an award. */
export function candidateFeatures(
  histories: Map<string, RecipientHistory>,
  uei: string,
  award: { naics4: string; agencyCode: string | null; bucket: string; amount: number; time: number },
): number[] {
  const h = histories.get(uei)
  if (!h) return [0, 0, 0, -3, 0]

  const seg = h.bySegment.get(award.naics4)
  const nSeg = seg ? countBefore(seg.dates, award.time) : 0

  const ag = award.agencyCode ? h.byAgency.get(award.agencyCode) : undefined
  const nAgency = ag ? countBefore(ag, award.time) : 0

  let recency = 0
  if (seg && nSeg > 0) {
    const lastT = seg.dates[nSeg - 1]
    recency = Math.exp(-((award.time - lastT) / MONTH_MS) / 24)
  }

  let sizeAlign = -3
  if (seg && nSeg > 0) {
    // Median of the RECENT window (last 25 prior awards), not the full
    // history: (a) firms drift in contract size, so recency is the better
    // scale signal; (b) sorting a prolific vendor's full history on every
    // feature call was quadratic — the hot loop at corpus scale.
    const start = Math.max(0, nSeg - 25)
    const recent: number[] = []
    for (let i = start; i < nSeg; i++) if (seg.amounts[i] > 0) recent.push(seg.amounts[i])
    if (recent.length > 0) {
      recent.sort((a, b) => a - b)
      const med = recent[Math.floor(recent.length / 2)]
      sizeAlign = Math.max(-3, -Math.abs(Math.log(Math.max(1, med)) - Math.log(Math.max(1, award.amount))))
    }
  }

  const bk = h.byBucket.get(award.bucket)
  const nBucket = bk ? countBefore(bk, award.time) : 0

  return [Math.log1p(nSeg), Math.log1p(nAgency), recency, sizeAlign, Math.log1p(nBucket)]
}

interface Group {
  /** candidate raw feature vectors; index 0 = winner */
  features: number[][]
  naics4: string
}

function buildGroups(
  awards: AwardRow[],
  histories: Map<string, RecipientHistory>,
  poolByNaics4: Map<string, string[]>,
  fyFilter: (fy: number) => boolean,
  cfg: TrainingConfig,
  rand: () => number,
): Group[] {
  // Select the award SET first, features second. Feature construction is the
  // expensive part (10 candidates × 5 time-filtered features per group) —
  // computing it for every eligible award and then discarding all but
  // maxGroups was a 25× compute waste at corpus scale.
  const eligibleIdx: number[] = []
  for (let i = 0; i < awards.length; i++) {
    const a = awards[i]
    if (!fyFilter(a.fiscalYear)) continue
    const pool = poolByNaics4.get(a.naicsCode.slice(0, 4))
    if (!pool || pool.length < cfg.minSegmentWinners) continue
    eligibleIdx.push(i)
  }
  // Deterministic stride down-sample over the chronologically-ordered
  // eligible set — statistically identical to sampling after construction.
  let chosen = eligibleIdx
  if (eligibleIdx.length > cfg.maxGroups) {
    chosen = []
    const stride = eligibleIdx.length / cfg.maxGroups
    for (let i = 0; i < cfg.maxGroups; i++) chosen.push(eligibleIdx[Math.floor(i * stride)])
  }

  const groups: Group[] = []
  for (const idx of chosen) {
    const a = awards[idx]
    const n4 = a.naicsCode.slice(0, 4)
    const pool = poolByNaics4.get(n4)!

    const award = {
      naics4: n4,
      agencyCode: a.agencyCode,
      bucket: bucketFromFpdsCode(a.setAsideCode),
      amount: a.obligatedAmount,
      time: a.actionDate.getTime(),
    }
    const exclude = new Set([a.recipientUei, a.recipientParentUei].filter(Boolean) as string[])
    const negatives: string[] = []
    let guard = 0
    while (negatives.length < cfg.negativesPerAward && guard++ < 200) {
      const pick = pool[Math.floor(rand() * pool.length)]
      if (!exclude.has(pick) && !negatives.includes(pick)) negatives.push(pick)
    }
    if (negatives.length < cfg.negativesPerAward) continue

    groups.push({
      naics4: n4,
      features: [
        candidateFeatures(histories, a.recipientUei, award),
        ...negatives.map((u) => candidateFeatures(histories, u, award)),
      ],
    })
  }
  return groups
}

export interface EvalReport {
  testGroups: number
  topOneAccuracy: number
  meanReciprocalRank: number
  pairwiseAuc: number
  baselines: {
    randomTopOne: number
    experienceOnlyTopOne: number
    experienceOnlyMrr: number
  }
  priorStability: {
    segmentsEvaluated: number
    /** Mean squared error of the train-fit shrunk E[1/K] vs realized test mean 1/K. */
    priorMse: number
    /** Same MSE for the GLOBAL climatology — the skill reference. */
    climatologyMse: number
    /** 1 - priorMse/climatologyMse: > 0 means the segment prior beats climatology. */
    skillScore: number | null
  }
  trainMaxFy: number
  testFySpan: [number, number] | null
}

/** Train on FY ≤ trainMaxFy, evaluate out-of-time, persist a CANDIDATE model. */
export async function trainAndEvaluate(
  version: string,
  cfg: TrainingConfig = DEFAULT_TRAINING_CONFIG,
): Promise<{ modelId: string; eval: EvalReport; coefficients: Record<string, number> }> {
  const awards: AwardRow[] = (await loadAwardsChronologically<AwardRow & { obligatedAmount: unknown }>({
    naicsCode: true, agencyCode: true, setAsideCode: true, offersReceived: true,
    recipientUei: true, recipientParentUei: true, obligatedAmount: true, actionDate: true, fiscalYear: true,
  })).map((r) => ({ ...r, obligatedAmount: Number(r.obligatedAmount) }))
  if (awards.length < 500) throw new Error(`training table too small (${awards.length} awards) — ingest more data`)

  const histories = buildHistories(awards)

  // Candidate pools: distinct winners per NAICS-4, TRAIN window only — the
  // pool must not leak test-period entrants into training-time sampling.
  const poolByNaics4 = new Map<string, string[]>()
  {
    const seen = new Map<string, Set<string>>()
    for (const a of awards) {
      if (a.fiscalYear > cfg.trainMaxFy) continue
      const n4 = a.naicsCode.slice(0, 4)
      let s = seen.get(n4)
      if (!s) { s = new Set(); seen.set(n4, s) }
      s.add(a.recipientUei)
    }
    for (const [n4, s] of seen) poolByNaics4.set(n4, [...s])
  }

  const rand = mulberry32(cfg.seed)
  const trainGroups = buildGroups(awards, histories, poolByNaics4, (fy) => fy <= cfg.trainMaxFy, cfg, rand)
  if (trainGroups.length < 200) throw new Error(`too few training groups (${trainGroups.length})`)

  const featureMatrix = trainGroups.map((g) => g.features)
  const { means, sds } = standardize(featureMatrix)
  // Sign-constrained: all FEATURE_NAMES are domain-monotone-positive, and the
  // runtime explains per-feature contributions to clients — collinear
  // +/− splits would read as "experience hurts you".
  const fit = fitConditionalLogit(featureMatrix, { l2: cfg.l2, nonNegative: true })

  // Per-NAICS-4 mean winner utility on the TRAIN window — the runtime
  // "typical winner" reference the client's utility is compared against.
  const segUtilSum = new Map<string, { sum: number; n: number }>()
  for (const g of trainGroups) {
    const u = g.features[0].reduce((s, v, k) => s + v * fit.beta[k], 0) // already standardized
    let e = segUtilSum.get(g.naics4)
    if (!e) { e = { sum: 0, n: 0 }; segUtilSum.set(g.naics4, e) }
    e.sum += u
    e.n++
  }
  const segmentMeanUtility: Record<string, number> = {}
  let globalUtilSum = 0, globalUtilN = 0
  for (const [n4, e] of segUtilSum) {
    segmentMeanUtility[n4] = e.sum / e.n
    globalUtilSum += e.sum
    globalUtilN += e.n
  }
  const globalMeanUtility = globalUtilN > 0 ? globalUtilSum / globalUtilN : 0

  // ---- Out-of-time evaluation ----
  const evalRand = mulberry32(cfg.seed + 1)
  const testGroups = buildGroups(awards, histories, poolByNaics4, (fy) => fy > cfg.trainMaxFy, cfg, evalRand)

  let top1 = 0, mrr = 0, aucWins = 0, aucPairs = 0
  let expTop1 = 0, expMrr = 0
  for (const g of testGroups) {
    // NOTE: g.features are RAW here (standardize() only ran on train matrix).
    const utils = g.features.map((x) => utility(x, fit.beta, means, sds))
    const winnerU = utils[0]
    let rank = 1
    for (let j = 1; j < utils.length; j++) {
      if (utils[j] > winnerU) rank++
      if (utils[j] !== winnerU) { aucPairs++; if (winnerU > utils[j]) aucWins++ }
      else { aucPairs++; aucWins += 0.5 }
    }
    if (rank === 1) top1++
    mrr += 1 / rank

    // Experience-only baseline: rank purely by raw experienceSegment.
    const exps = g.features.map((x) => x[0])
    let expRank = 1
    for (let j = 1; j < exps.length; j++) if (exps[j] > exps[0]) expRank++
    if (expRank === 1) expTop1++
    expMrr += 1 / expRank
  }
  const nTest = Math.max(1, testGroups.length)

  // ---- Prior stability: train-window shrunk E[1/K] vs realized test E[1/K] ----
  // Computed in-memory on the train split only (the persisted priors use ALL
  // data and would leak). Segments: NAICS-4 × bucket with enough test data.
  const trainSeg = new Map<string, { sum: number; n: number }>()
  const testSeg = new Map<string, { sum: number; n: number }>()
  let trainGlobalSum = 0, trainGlobalN = 0
  for (const a of awards) {
    if (a.offersReceived === null) continue
    const k = `${a.naicsCode.slice(0, 4)}|${bucketFromFpdsCode(a.setAsideCode)}`
    const target = a.fiscalYear <= cfg.trainMaxFy ? trainSeg : testSeg
    let e = target.get(k)
    if (!e) { e = { sum: 0, n: 0 }; target.set(k, e) }
    e.sum += 1 / a.offersReceived
    e.n++
    if (a.fiscalYear <= cfg.trainMaxFy) { trainGlobalSum += 1 / a.offersReceived; trainGlobalN++ }
  }
  const climatology = trainGlobalN > 0 ? trainGlobalSum / trainGlobalN : 0.33
  let priorSe = 0, climSe = 0, segEvaluated = 0
  for (const [k, test] of testSeg) {
    if (test.n < 30) continue
    const train = trainSeg.get(k)
    const obs = train && train.n > 0 ? train.sum / train.n : climatology
    const predicted = shrink(obs, train?.n ?? 0, climatology, DEFAULT_PSEUDO_COUNT)
    const realized = test.sum / test.n
    priorSe += (predicted - realized) ** 2
    climSe += (climatology - realized) ** 2
    segEvaluated++
  }

  // Reduce, not Math.min(...arr) — spreading a million-element array as
  // call arguments overflows the stack.
  let testFyMin = Infinity, testFyMax = -Infinity
  for (const a of awards) {
    if (a.fiscalYear > cfg.trainMaxFy) {
      if (a.fiscalYear < testFyMin) testFyMin = a.fiscalYear
      if (a.fiscalYear > testFyMax) testFyMax = a.fiscalYear
    }
  }
  const evalReport: EvalReport = {
    testGroups: testGroups.length,
    topOneAccuracy: top1 / nTest,
    meanReciprocalRank: mrr / nTest,
    pairwiseAuc: aucPairs > 0 ? aucWins / aucPairs : 0.5,
    baselines: {
      randomTopOne: 1 / (cfg.negativesPerAward + 1),
      experienceOnlyTopOne: expTop1 / nTest,
      experienceOnlyMrr: expMrr / nTest,
    },
    priorStability: {
      segmentsEvaluated: segEvaluated,
      priorMse: segEvaluated > 0 ? priorSe / segEvaluated : 0,
      climatologyMse: segEvaluated > 0 ? climSe / segEvaluated : 0,
      skillScore: segEvaluated > 0 && climSe > 0 ? 1 - priorSe / climSe : null,
    },
    trainMaxFy: cfg.trainMaxFy,
    testFySpan: Number.isFinite(testFyMin) ? [testFyMin, testFyMax] : null,
  }

  const coefficients: Record<string, number> = {}
  FEATURE_NAMES.forEach((name, k) => { coefficients[name] = fit.beta[k] })
  const featureStats: Record<string, { mean: number; sd: number }> = {}
  FEATURE_NAMES.forEach((name, k) => { featureStats[name] = { mean: means[k], sd: sds[k] } })

  const model = await prisma.whoWinsModel.create({
    data: {
      version,
      status: 'CANDIDATE',
      coefficients,
      featureStats,
      trainingGroups: trainGroups.length,
      trainingConfig: { ...cfg, segmentMeanUtility, globalMeanUtility } as object,
      evalReport: evalReport as object,
    },
  })

  logger.info('WhoWins model trained', {
    version, trainGroups: trainGroups.length, testGroups: testGroups.length,
    top1: evalReport.topOneAccuracy, mrr: evalReport.meanReciprocalRank,
  })
  return { modelId: model.id, eval: evalReport, coefficients }
}

/** Promote a model version to ACTIVE (archives any previous ACTIVE). */
export async function activateModel(version: string): Promise<void> {
  await prisma.$transaction([
    prisma.whoWinsModel.updateMany({ where: { status: 'ACTIVE' }, data: { status: 'ARCHIVED' } }),
    prisma.whoWinsModel.update({ where: { version }, data: { status: 'ACTIVE' } }),
  ])
}
