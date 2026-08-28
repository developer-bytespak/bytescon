import { describe, it, expect } from 'vitest'
import {
  logLoss,
  rocAuc,
  expectedCalibrationError,
  brierDecomposition,
  type LabeledPrediction,
} from './metrics'

const perfect: LabeledPrediction[] = [
  { predicted: 1.0, observed: 1 },
  { predicted: 0.0, observed: 0 },
  { predicted: 1.0, observed: 1 },
  { predicted: 0.0, observed: 0 },
]

const random: LabeledPrediction[] = [
  { predicted: 0.5, observed: 1 },
  { predicted: 0.5, observed: 0 },
  { predicted: 0.5, observed: 1 },
  { predicted: 0.5, observed: 0 },
]

describe('logLoss', () => {
  it('is ~0 for perfect predictions (clamped at 1e-15)', () => {
    expect(logLoss(perfect)).toBeLessThan(1e-10)
  })

  it('is ~ln(2) for random predictions at 0.5', () => {
    expect(logLoss(random)).toBeCloseTo(Math.log(2), 4)
  })

  it('returns 0 for empty input', () => {
    expect(logLoss([])).toBe(0)
  })

  it('clamps predictions at 0/1 to avoid -Infinity', () => {
    const adversarial: LabeledPrediction[] = [
      { predicted: 0.0, observed: 1 }, // worst case
      { predicted: 1.0, observed: 0 }, // worst case
    ]
    const result = logLoss(adversarial)
    expect(Number.isFinite(result)).toBe(true)
    expect(result).toBeGreaterThan(30) // very high but finite
  })
})

describe('rocAuc', () => {
  it('returns 1.0 for perfectly ranked predictions', () => {
    expect(rocAuc(perfect)).toBe(1.0)
  })

  it('returns 0.5 when all predictions are tied', () => {
    expect(rocAuc(random)).toBe(0.5)
  })

  it('returns 0 for perfectly inverted predictions', () => {
    const inverted: LabeledPrediction[] = [
      { predicted: 0.0, observed: 1 },
      { predicted: 0.1, observed: 1 },
      { predicted: 0.9, observed: 0 },
      { predicted: 1.0, observed: 0 },
    ]
    expect(rocAuc(inverted)).toBe(0)
  })

  it('returns null when only one class is present', () => {
    expect(rocAuc([{ predicted: 0.5, observed: 1 }])).toBeNull()
    expect(rocAuc([{ predicted: 0.5, observed: 0 }])).toBeNull()
  })

  it('handles ties via average-rank correctly', () => {
    // 4 predictions all at 0.5, 2 pos + 2 neg: AUC = 0.5 exactly
    const ties: LabeledPrediction[] = [
      { predicted: 0.5, observed: 1 },
      { predicted: 0.5, observed: 0 },
      { predicted: 0.5, observed: 1 },
      { predicted: 0.5, observed: 0 },
    ]
    expect(rocAuc(ties)).toBe(0.5)
  })

  it('returns ~0.83 for a partial-rank case (3 pos, 3 neg with one misorder)', () => {
    const partial: LabeledPrediction[] = [
      { predicted: 0.1, observed: 0 },
      { predicted: 0.2, observed: 0 },
      { predicted: 0.3, observed: 1 }, // out of order
      { predicted: 0.4, observed: 0 },
      { predicted: 0.7, observed: 1 },
      { predicted: 0.9, observed: 1 },
    ]
    // pairs (pos, neg): (0.3 v 0.1, 0.2, 0.4=miss) (0.7 v all) (0.9 v all) -> 2+3+3 = 8 wins of 9
    expect(rocAuc(partial)).toBeCloseTo(8 / 9, 4)
  })
})

describe('expectedCalibrationError', () => {
  it('is 0 for perfect predictions', () => {
    expect(expectedCalibrationError(perfect)).toBe(0)
  })

  it('is 0.5 when all predictions=0.5 and outcomes are 0/0 (overconfident-up)', () => {
    const allHalfNoWin: LabeledPrediction[] = [
      { predicted: 0.5, observed: 0 },
      { predicted: 0.5, observed: 0 },
    ]
    expect(expectedCalibrationError(allHalfNoWin)).toBe(0.5)
  })

  it('is 0 for predictions that match observed rate per bin', () => {
    // 10 predictions at 0.3, 3 wins. Mean obs in bin = 0.3 = mean pred. ECE = 0.
    const matched: LabeledPrediction[] = [
      ...Array(7).fill(null).map(() => ({ predicted: 0.3, observed: 0 })),
      ...Array(3).fill(null).map(() => ({ predicted: 0.3, observed: 1 })),
    ]
    expect(expectedCalibrationError(matched)).toBeCloseTo(0, 6)
  })

  it('handles edge bin at predicted=1.0', () => {
    const edge: LabeledPrediction[] = [{ predicted: 1.0, observed: 1 }]
    expect(expectedCalibrationError(edge)).toBe(0)
  })
})

describe('expectedCalibrationError — equal-mass binning (PROMPT.md §6.3 default)', () => {
  it('is ~0 when each predicted-value group matches its observed rate', () => {
    const data: LabeledPrediction[] = [
      ...Array(8).fill(null).map(() => ({ predicted: 0.2, observed: 0 })),
      ...Array(2).fill(null).map(() => ({ predicted: 0.2, observed: 1 })), // 0.2 group: obs rate 0.2
      ...Array(2).fill(null).map(() => ({ predicted: 0.8, observed: 0 })),
      ...Array(8).fill(null).map(() => ({ predicted: 0.8, observed: 1 })), // 0.8 group: obs rate 0.8
    ]
    expect(expectedCalibrationError(data)).toBeCloseTo(0, 6)
  })

  it('equals the hand-computed error for a miscalibrated tied group (|0.9 - 0.5| = 0.4)', () => {
    const data: LabeledPrediction[] = [
      ...Array(5).fill(null).map(() => ({ predicted: 0.9, observed: 1 })),
      ...Array(5).fill(null).map(() => ({ predicted: 0.9, observed: 0 })),
    ]
    expect(expectedCalibrationError(data)).toBeCloseTo(0.4, 6)
  })

  it('keeps tied predictions in one bin even at numBins=N (no per-point over-split)', () => {
    // 10 identical 0.3 preds, 3 wins -> calibrated -> ECE 0 (a naive equal-mass
    // split would wrongly report ~0.42 by isolating each point).
    const data: LabeledPrediction[] = [
      ...Array(7).fill(null).map(() => ({ predicted: 0.3, observed: 0 })),
      ...Array(3).fill(null).map(() => ({ predicted: 0.3, observed: 1 })),
    ]
    expect(expectedCalibrationError(data, 10)).toBeCloseTo(0, 6)
  })

  it('still supports legacy equal-width binning via the option', () => {
    const data: LabeledPrediction[] = [
      { predicted: 0.9, observed: 0 },
      { predicted: 0.9, observed: 0 },
    ]
    expect(expectedCalibrationError(data, 10, 'equal-width')).toBeCloseTo(0.9, 6)
  })

  it('differs from equal-width when nearby tied groups share one width bin (default is equal-mass)', () => {
    // Both groups land in the same [0.6, 0.7) width bin, where their
    // opposite-signed errors partially cancel: equal-width reports
    // |0.65 - 0.8| = 0.15. Equal-mass keeps the tied groups in separate bins:
    // 0.5*|0.61 - 0.6| + 0.5*|0.69 - 1.0| = 0.16. A silent fallback of the
    // default to equal-width would report 0.15 here and fail this test.
    const data: LabeledPrediction[] = [
      ...Array(3).fill(null).map(() => ({ predicted: 0.61, observed: 1 })),
      ...Array(2).fill(null).map(() => ({ predicted: 0.61, observed: 0 })), // obs rate 0.6: near-calibrated
      ...Array(5).fill(null).map(() => ({ predicted: 0.69, observed: 1 })), // obs rate 1.0: miscalibrated
    ]
    expect(expectedCalibrationError(data, 10, 'equal-width')).toBeCloseTo(0.15, 6)
    expect(expectedCalibrationError(data, 10)).toBeCloseTo(0.16, 6)
    expect(expectedCalibrationError(data)).toBeCloseTo(0.16, 6) // default binning
  })

  it('does not collapse post-tie bins to singletons (boundary-lag regression)', () => {
    // 50 perfectly calibrated ties at 0.5 followed by 5 near-distinct levels
    // of 10 lightly jittered points each. The pre-fix fixed-grid boundary
    // computation degraded the bins after the tie run to size 1, yielding bin
    // sizes [50,1,1,1,1,6,10,10,10,10] and an inflated ECE of ~0.0294 on this
    // data; redistributing remaining points across remaining bins yields sizes
    // [50,6,6,5,6,5,6,5,6,5] and ~0.0237 (equal-width truth here is ~0.0102).
    const data: LabeledPrediction[] = []
    for (let j = 0; j < 50; j++) {
      data.push({ predicted: 0.5, observed: j % 2 === 0 ? 1 : 0 })
    }
    const levels = [0.52, 0.62, 0.72, 0.82, 0.92]
    const wins = [5, 6, 7, 8, 9]
    levels.forEach((base, li) => {
      for (let j = 0; j < 10; j++) {
        // Evenly interleaved wins so each level is calibrated to wins/10.
        const observed =
          Math.floor(((j + 1) * wins[li]) / 10) - Math.floor((j * wins[li]) / 10)
        data.push({ predicted: base + j * 1e-4, observed })
      }
    })
    const ece = expectedCalibrationError(data, 10)
    expect(ece).toBeLessThan(0.029) // singleton collapse reported ~0.0294
    expect(ece).toBeCloseTo(0.0237, 4)
  })
})

describe('brierDecomposition', () => {
  it('satisfies Brier = Reliability - Resolution + Uncertainty', () => {
    const sample: LabeledPrediction[] = [
      { predicted: 0.1, observed: 0 },
      { predicted: 0.2, observed: 0 },
      { predicted: 0.3, observed: 1 },
      { predicted: 0.4, observed: 0 },
      { predicted: 0.7, observed: 1 },
      { predicted: 0.9, observed: 1 },
    ]
    const d = brierDecomposition(sample)
    expect(d.brier).toBeCloseTo(d.reliability - d.resolution + d.uncertainty, 6)
  })

  it('reliability=0 when predictions match bin win rates', () => {
    const matched: LabeledPrediction[] = [
      ...Array(7).fill(null).map(() => ({ predicted: 0.3, observed: 0 })),
      ...Array(3).fill(null).map(() => ({ predicted: 0.3, observed: 1 })),
    ]
    const d = brierDecomposition(matched)
    expect(d.reliability).toBeCloseTo(0, 6)
  })

  it('uncertainty = p̄(1-p̄) = 0.25 when half the labels are positive', () => {
    const balanced: LabeledPrediction[] = [
      { predicted: 0.1, observed: 1 },
      { predicted: 0.9, observed: 0 },
    ]
    const d = brierDecomposition(balanced)
    expect(d.uncertainty).toBe(0.25)
  })

  it('returns zeros for empty input', () => {
    const d = brierDecomposition([])
    expect(d).toEqual({ brier: 0, reliability: 0, resolution: 0, uncertainty: 0 })
  })
})
