// B18 — score explanations read what the scoring worker actually records.
import { describe, it, expect } from 'vitest'
import { deriveFactors } from './scoreExplanation'

const inputs = (factorContributions: unknown) => ({
  rawProbability: 0.4,
  naicsCode: '541512', agency: 'GSA', setAsideType: 'NONE', estimatedValue: 1000,
  responseDeadline: new Date(), competitionCount: 3, incumbentProbability: 0.5, historicalAwardCount: 4,
  scoreBreakdown: { factorContributions },
}) as never

const row = (factor: string, score: number, weight: number) => ({ factor, score, weight, contribution: score * weight, pct: Math.round(score * 100), label: factor })

describe('deriveFactors', () => {
  it('reports each factor from the recorded engine rows', () => {
    const { factors } = deriveFactors(inputs([row('naicsOverlapScore', 1, 0.35), row('incumbentWeaknessScore', 0.1, 0.1), row('awardSizeFitScore', 0.5, 0.09)]))
    const byKey = Object.fromEntries(factors.map((f) => [f.key, f]))

    expect(byKey.naicsCode).toMatchObject({ direction: 'POSITIVE', contribution: 17.5 })
    expect(byKey.naicsCode.explanation).toMatch(/scored 100% at 35% weight, raising/)
    expect(byKey.incumbentProbability).toMatchObject({ direction: 'NEGATIVE', contribution: -4 })
    expect(byKey.estimatedValue).toMatchObject({ direction: 'NEUTRAL', contribution: 0 })
  })

  it('stays honest when a run recorded nothing for a factor', () => {
    const { factors } = deriveFactors(inputs([row('naicsOverlapScore', 1, 0.35)]))
    expect(factors.find((f) => f.key === 'agency')).toMatchObject({ contribution: null, direction: 'NEUTRAL' })
  })

  it('still reports a missing input as absent, whatever was recorded', () => {
    const { factors, missingInputs } = deriveFactors({ ...(inputs([row('naicsOverlapScore', 1, 0.35)]) as object), naicsCode: null } as never)
    expect(factors.find((f) => f.key === 'naicsCode')?.direction).toBe('ABSENT')
    expect(missingInputs.length).toBe(1)
  })
})
