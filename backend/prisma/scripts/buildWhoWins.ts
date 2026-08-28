// =============================================================
// Who-Wins v1 — end-to-end build: ingest → priors → train → evaluate.
//
// Run on the droplet (inside the backend container, which has network +
// prod DB), or locally against a dev DB:
//
//   docker exec bytescon_backend npx ts-node prisma/scripts/buildWhoWins.ts
//
// Flags (env vars — container-exec-friendly):
//   WHO_WINS_SKIP_INGEST=true     reuse the existing training table
//   WHO_WINS_INGEST_ONLY=true     stage data, skip priors/training (lets the
//                                 memory-heavy training run on a bigger box)
//   WHO_WINS_FY_START / FY_END    fiscal-year span (default 2022..2026)
//   WHO_WINS_NAICS=541512,236220  explicit NAICS list (default: resolved
//                                 from clients + opportunities)
//   WHO_WINS_MAX_GROUPS=30000     training-group cap (memory lever)
//   WHO_WINS_ACTIVATE=false       train + report but do NOT activate
//
// Activating a model does NOT change any customer-visible number — the
// scoring blend is separately gated by WHO_WINS_PRIOR_ENABLED (default
// OFF). Review the eval report before flipping that flag.
// =============================================================
import { prisma } from '../../src/config/database'
import { resolveNaicsUniverse, runTrainingIngest } from '../../src/services/whoWins/trainingIngest'
import { buildPriors } from '../../src/services/whoWins/priorBuilder'
import { trainAndEvaluate, activateModel, DEFAULT_TRAINING_CONFIG } from '../../src/services/whoWins/whoWinsTrainer'

async function main() {
  const skipIngest = process.env.WHO_WINS_SKIP_INGEST === 'true'
  const fyStart = Number(process.env.WHO_WINS_FY_START || 2022)
  const fyEnd = Number(process.env.WHO_WINS_FY_END || 2026)
  const activate = process.env.WHO_WINS_ACTIVATE !== 'false'
  // Minute-resolution version so same-day rebuilds never collide on the
  // unique version key; ARCHIVED history keeps every run comparable.
  const version = `v1-${new Date().toISOString().slice(0, 16).replace(/[T:]/g, '-')}`

  console.log(`Who-Wins build ${version} — FY${fyStart}..FY${fyEnd}${skipIngest ? ' (ingest skipped)' : ''}`)

  if (!skipIngest) {
    const naics = process.env.WHO_WINS_NAICS
      ? process.env.WHO_WINS_NAICS.split(',').map((s) => s.trim()).filter((s) => /^\d{6}$/.test(s))
      : await resolveNaicsUniverse()
    console.log(`NAICS universe: ${naics.length} codes`)
    if (naics.length === 0) throw new Error('empty NAICS universe')

    const ingest = await runTrainingIngest({ naicsCodes: naics, fyStart, fyEnd })
    console.log(
      `Ingest ${ingest.ingestBatchId}: ${ingest.requests} requests, ` +
      `${ingest.rowsSeen} rows seen → ${ingest.rowsKept} kept → ${ingest.rowsInserted} new`,
    )
    if (ingest.failedChunks.length) {
      console.log(`FAILED CHUNKS (${ingest.failedChunks.length}):`)
      for (const f of ingest.failedChunks) console.log(`  FY${f.fy} [${f.naics.slice(0, 3).join(',')}…]: ${f.error}`)
    }
  }

  const total = await prisma.publicAwardTraining.count()
  console.log(`Training table: ${total} competed awards`)

  if (process.env.WHO_WINS_INGEST_ONLY === 'true') {
    console.log('WHO_WINS_INGEST_ONLY — stopping before priors/training.')
    return
  }

  const priors = await buildPriors(version)
  console.log(`Priors: ${priors.segments} segments over ${priors.awards} awards`)

  const maxGroups = Number(process.env.WHO_WINS_MAX_GROUPS || DEFAULT_TRAINING_CONFIG.maxGroups)
  const { eval: report, coefficients } = await trainAndEvaluate(version, { ...DEFAULT_TRAINING_CONFIG, maxGroups })
  console.log('\n=== OUT-OF-TIME EVALUATION (the number that matters) ===')
  console.log(`Test groups (FY>${report.trainMaxFy}): ${report.testGroups}`)
  console.log(`Top-1 accuracy:  model ${(report.topOneAccuracy * 100).toFixed(1)}%  vs random ${(report.baselines.randomTopOne * 100).toFixed(1)}%  vs experience-only ${(report.baselines.experienceOnlyTopOne * 100).toFixed(1)}%`)
  console.log(`MRR:             model ${report.meanReciprocalRank.toFixed(3)}  vs experience-only ${report.baselines.experienceOnlyMrr.toFixed(3)}`)
  console.log(`Pairwise AUC:    ${report.pairwiseAuc.toFixed(3)}`)
  console.log(`Prior stability: ${report.priorStability.segmentsEvaluated} segments, skill vs climatology = ${report.priorStability.skillScore?.toFixed(3) ?? 'n/a'}`)
  console.log('Coefficients (standardized):', JSON.stringify(coefficients, null, 2))

  if (activate) {
    await activateModel(version)
    console.log(`\nModel ${version} ACTIVATED (scoring blend remains gated by WHO_WINS_PRIOR_ENABLED).`)
  } else {
    console.log(`\nModel ${version} left as CANDIDATE.`)
  }
}

main()
  .catch((err) => {
    console.error('Who-Wins build failed:', err)
    process.exit(1)
  })
  .finally(() => prisma.$disconnect())
