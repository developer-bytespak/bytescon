import { describe, it, expect } from 'vitest'
import {
  buildSyntheticNegatives,
  pickPermutationPartners,
  mapCorpusRowToAwardSample,
} from './historicalBacktest'

const sdvosbWinner = {
  naics: ['541330'],
  sdvosb: true,
  wosb: false,
  hubzone: false,
  smallBiz: true,
}

const largeBizWinner = {
  naics: ['336411'],
  sdvosb: false,
  wosb: false,
  hubzone: false,
  smallBiz: false,
}

describe('buildSyntheticNegatives', () => {
  it('returns 0 negatives when count <= 0', () => {
    expect(buildSyntheticNegatives('541330', sdvosbWinner, 0)).toEqual([])
    expect(buildSyntheticNegatives('541330', sdvosbWinner, -1)).toEqual([])
  })

  it('produces 3 distinct mismatch variants by default', () => {
    const negs = buildSyntheticNegatives('541330', sdvosbWinner, 3)
    expect(negs).toHaveLength(3)
  })

  it('caps at 3 even when more requested (only 3 variants exist)', () => {
    const negs = buildSyntheticNegatives('541330', sdvosbWinner, 10)
    expect(negs).toHaveLength(3)
  })

  it('variant 1 has a different NAICS sector', () => {
    const negs = buildSyntheticNegatives('541330', sdvosbWinner, 1)
    expect(negs).toHaveLength(1)
    const sector = negs[0].naics[0].slice(0, 2)
    expect(sector).not.toBe('54')
  })

  it('variant 2 inverts the size-class flag', () => {
    const negs = buildSyntheticNegatives('541330', sdvosbWinner, 2)
    const v2 = negs[1]
    expect(v2.naics).toEqual(['541330']) // same NAICS as winner
    expect(v2.smallBiz).toBe(false) // flipped from winner
    // set-aside flags zeroed since they require small-biz
    expect(v2.sdvosb).toBe(false)
    expect(v2.wosb).toBe(false)
    expect(v2.hubzone).toBe(false)
  })

  it('variant 3 inverts set-aside flags but keeps NAICS + size', () => {
    const negs = buildSyntheticNegatives('541330', sdvosbWinner, 3)
    const v3 = negs[2]
    expect(v3.naics).toEqual(['541330'])
    expect(v3.smallBiz).toBe(true) // same as winner
    expect(v3.sdvosb).toBe(false) // flipped
    expect(v3.wosb).toBe(true) // flipped
    expect(v3.hubzone).toBe(true) // flipped
  })

  it('flips smallBiz correctly when winner is large-biz', () => {
    const negs = buildSyntheticNegatives('336411', largeBizWinner, 2)
    const v2 = negs[1]
    expect(v2.smallBiz).toBe(true) // flipped from large to small
  })

  it('handles missing/empty award NAICS without crashing', () => {
    const negs = buildSyntheticNegatives('', sdvosbWinner, 3)
    expect(negs).toHaveLength(3)
    // Variant 1 picks SOME distant sector even when current sector is missing
    expect(negs[0].naics[0]).not.toBe('')
  })
})

describe('mapCorpusRowToAwardSample', () => {
  const fullRow = {
    awardKey: 'PIID123_9700',
    naicsCode: '541330',
    agencyName: 'DEPT OF DEFENSE',
    setAsideCode: 'SDVOSBC',
    recipientUei: 'ABC123DEF456',
    recipientName: 'ACME ENGINEERING LLC',
    obligatedAmount: '150000.50', // Prisma Decimal arrives Number()-coercible
    actionDate: new Date('2025-03-15T00:00:00Z'),
  }

  it('maps a fully-populated corpus row', () => {
    expect(mapCorpusRowToAwardSample(fullRow)).toEqual({
      contractId: 'PIID123_9700',
      naicsCode: '541330',
      agency: 'DEPT OF DEFENSE',
      awardAmount: 150000.5,
      awardDate: '2025-03-15',
      recipientName: 'ACME ENGINEERING LLC',
      recipientUei: 'ABC123DEF456',
      setAside: 'SDVOSBC',
    })
  })

  it('fills safe defaults for nullable fields', () => {
    const mapped = mapCorpusRowToAwardSample({
      ...fullRow,
      agencyName: null,
      setAsideCode: null,
      recipientUei: null,
      recipientName: null,
    })
    expect(mapped.agency).toBe('Unknown')
    expect(mapped.setAside).toBeNull()
    expect(mapped.recipientUei).toBeNull()
    expect(mapped.recipientName).toBe('Unknown')
  })

  it('coerces a non-numeric amount to 0 instead of NaN', () => {
    const mapped = mapCorpusRowToAwardSample({ ...fullRow, obligatedAmount: 'not-a-number' })
    expect(mapped.awardAmount).toBe(0)
  })

  it('formats Date actionDate as YYYY-MM-DD and passes strings through', () => {
    expect(mapCorpusRowToAwardSample(fullRow).awardDate).toBe('2025-03-15')
    const mapped = mapCorpusRowToAwardSample({ ...fullRow, actionDate: '2024-11-02' })
    expect(mapped.awardDate).toBe('2024-11-02')
  })
})

describe('pickPermutationPartners', () => {
  // Deterministic RNG for repeatable tests
  function seededRng(seed: number) {
    let s = seed >>> 0
    return () => {
      s = (s * 1664525 + 1013904223) >>> 0
      return s / 0x100000000
    }
  }

  it('returns empty when sampleSize <= 1', () => {
    expect(pickPermutationPartners(1, 0, 3)).toEqual([])
    expect(pickPermutationPartners(0, 0, 3)).toEqual([])
  })

  it('returns empty when k <= 0', () => {
    expect(pickPermutationPartners(10, 0, 0)).toEqual([])
    expect(pickPermutationPartners(10, 0, -2)).toEqual([])
  })

  it('never includes the self index', () => {
    const rng = seededRng(42)
    for (let trial = 0; trial < 20; trial++) {
      const partners = pickPermutationPartners(20, 7, 5, rng)
      expect(partners).not.toContain(7)
    }
  })

  it('returns k distinct indices when sample is large enough', () => {
    const partners = pickPermutationPartners(50, 10, 8, seededRng(1))
    expect(partners).toHaveLength(8)
    expect(new Set(partners).size).toBe(8)
  })

  it('caps at sample-size-1 when k exceeds pool', () => {
    // sample=4, self=2 → pool is [0,1,3], can't pick 10
    const partners = pickPermutationPartners(4, 2, 10, seededRng(3))
    expect(partners).toHaveLength(3)
    expect(partners.sort()).toEqual([0, 1, 3])
  })
})
