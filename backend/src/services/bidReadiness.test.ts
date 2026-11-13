import { describe, it, expect } from 'vitest'
import { Prisma } from '@prisma/client'
import { evaluateBidReadiness, BOND_THRESHOLD, type BidReadinessInput } from './bidReadiness'

const NOW = new Date('2026-11-11T12:00:00Z')
const inDays = (d: number) => new Date(NOW.getTime() + d * 86_400_000)

function input(overrides: Partial<BidReadinessInput> = {}): BidReadinessInput {
  return {
    opportunity: {
      setAsideType: 'NONE',
      naicsCode: '541511',
      responseDeadline: inDays(30),
      estimatedValue: null,
    },
    registration: { samStatus: 'ACTIVE', samExpiryDate: inDays(200), setAsideCerts: [], naicsCodes: ['541511'] },
    certifications: [],
    partnerCertifications: [],
    bonding: null,
    now: NOW,
    ...overrides,
  }
}

const item = (r: ReturnType<typeof evaluateBidReadiness>, key: string) => r.items.find((i) => i.key === key)

describe('evaluateBidReadiness', () => {
  it('is READY when SAM is active, the NAICS matches and the notice is open to all', () => {
    const r = evaluateBidReadiness(input())
    expect(r.verdict).toBe('READY')
    expect(r.items.every((i) => i.status === 'PASS')).toBe(true)
    expect(r.items.map((i) => i.key)).toEqual(['DEADLINE', 'SAM', 'NAICS', 'SET_ASIDE'])
  })

  it('is NOT_ELIGIBLE once the response deadline has passed', () => {
    const r = evaluateBidReadiness(input({ opportunity: { ...input().opportunity, responseDeadline: inDays(-1) } }))
    expect(r.verdict).toBe('NOT_ELIGIBLE')
    expect(item(r, 'DEADLINE')?.status).toBe('FAIL')
  })

  it('warns when the deadline is under 3 days away', () => {
    const r = evaluateBidReadiness(input({ opportunity: { ...input().opportunity, responseDeadline: inDays(2) } }))
    expect(item(r, 'DEADLINE')?.status).toBe('WARN')
    // Only a warning: ready, but worth a look — not "fix these first".
    expect(r.verdict).toBe('CHECK')
  })

  it('fails SAM with the 2–4 week lead time when no registration is recorded', () => {
    const r = evaluateBidReadiness(input({ registration: null }))
    const sam = item(r, 'SAM')
    expect(sam?.status).toBe('FAIL')
    expect(sam?.fix).toMatch(/2 to 4 weeks/)
    expect(r.verdict).toBe('FIX_FIRST')
  })

  it('says a new registration may not be ready in time when the deadline is close', () => {
    const r = evaluateBidReadiness(input({
      registration: null,
      opportunity: { ...input().opportunity, responseDeadline: inDays(10) },
    }))
    expect(item(r, 'SAM')?.fix).toMatch(/may not be active before the deadline/)
  })

  it('fails SAM when the registration is inactive', () => {
    const r = evaluateBidReadiness(input({ registration: { ...input().registration!, samStatus: 'INACTIVE' } }))
    expect(item(r, 'SAM')?.status).toBe('FAIL')
  })

  it('warns when SAM expires before the response deadline', () => {
    const r = evaluateBidReadiness(input({ registration: { ...input().registration!, samExpiryDate: inDays(5) } }))
    expect(item(r, 'SAM')?.status).toBe('WARN')
    expect(item(r, 'SAM')?.fix).toMatch(/Renew/)
  })

  it('passes NAICS on an exact match, warns on a same-industry-group match', () => {
    expect(item(evaluateBidReadiness(input()), 'NAICS')?.status).toBe('PASS')
    const r = evaluateBidReadiness(input({ registration: { ...input().registration!, naicsCodes: ['541512'] } }))
    expect(item(r, 'NAICS')?.status).toBe('WARN')
    expect(item(r, 'NAICS')?.detail).toMatch(/5415/)
  })

  it('only warns about a NAICS outside the firm\'s codes on a notice open to all (size doesn\'t matter)', () => {
    const r = evaluateBidReadiness(input({ registration: { ...input().registration!, naicsCodes: ['236220'] } }))
    expect(item(r, 'NAICS')?.status).toBe('WARN')
    expect(item(r, 'NAICS')?.detail).toMatch(/open to all/)
    expect(r.verdict).toBe('CHECK')
  })

  it('fails (fixable) a NAICS outside the firm\'s codes on a set-aside, where its size standard applies', () => {
    const base = input()
    const r = evaluateBidReadiness(input({ opportunity: { ...base.opportunity, setAsideType: 'SBA' }, registration: { ...base.registration!, naicsCodes: ['236220'] } }))
    const naics = item(r, 'NAICS')
    expect(naics).toMatchObject({ status: 'FAIL', blocking: 'FIXABLE' })
    expect(naics?.detail).toMatch(/size standard/)
    expect(naics?.fix).toMatch(/SAM\.gov/)
    expect(r.verdict).not.toBe('READY')
  })

  it('warns when the notice lists no NAICS code', () => {
    const r = evaluateBidReadiness(input({ opportunity: { ...input().opportunity, naicsCode: '' } }))
    expect(item(r, 'NAICS')?.status).toBe('WARN')
  })

  it('is NOT_ELIGIBLE for a set-aside the firm holds no certification for', () => {
    const r = evaluateBidReadiness(input({ opportunity: { ...input().opportunity, setAsideType: 'SDVOSB' } }))
    expect(item(r, 'SET_ASIDE')?.status).toBe('FAIL')
    expect(r.verdict).toBe('NOT_ELIGIBLE')
  })

  it('passes a set-aside the firm holds an active certification for', () => {
    const r = evaluateBidReadiness(input({
      opportunity: { ...input().opportunity, setAsideType: 'SDVOSB' },
      certifications: [{ id: 'c1', name: 'SDVOSB', category: 'SET_ASIDE', expiryDate: inDays(300), isArchived: false }],
    }))
    expect(item(r, 'SET_ASIDE')?.status).toBe('PASS')
    expect(r.verdict).toBe('READY')
  })

  it('leaves bonding out for non-construction work', () => {
    const r = evaluateBidReadiness(input({ opportunity: { ...input().opportunity, estimatedValue: new Prisma.Decimal(5_000_000) } }))
    expect(item(r, 'BONDING')).toBeUndefined()
  })

  it('leaves bonding out for construction at or under the bond threshold', () => {
    const r = evaluateBidReadiness(input({
      opportunity: { ...input().opportunity, naicsCode: '238210', estimatedValue: new Prisma.Decimal(BOND_THRESHOLD) },
      registration: { ...input().registration!, naicsCodes: ['238210'] },
    }))
    expect(item(r, 'BONDING')).toBeUndefined()
  })

  const construction = (value: number | null, bonding: BidReadinessInput['bonding']) => input({
    opportunity: { ...input().opportunity, naicsCode: '238210', estimatedValue: value === null ? null : new Prisma.Decimal(value) },
    registration: { ...input().registration!, naicsCodes: ['238210'] },
    bonding,
  })
  const bond = (single: number | null, aggregate: number | null, committed: number | null) => ({
    singleProjectLimit: single === null ? null : new Prisma.Decimal(single),
    aggregateLimit: aggregate === null ? null : new Prisma.Decimal(aggregate),
    committedAmount: committed === null ? null : new Prisma.Decimal(committed),
    expiryDate: inDays(365),
    status: 'ACTIVE' as const,
  })

  it('warns on construction with no value, since bonds apply above $150,000', () => {
    const r = construction(null, null)
    const b = item(evaluateBidReadiness(r), 'BONDING')
    expect(b?.status).toBe('WARN')
    expect(b?.detail).toMatch(/\$150,000/)
  })

  it('fails construction over the threshold when no bonding is recorded (fixable)', () => {
    const r = evaluateBidReadiness(construction(400_000, null))
    expect(item(r, 'BONDING')?.status).toBe('FAIL')
    expect(r.verdict).toBe('FIX_FIRST')
  })

  it('is NOT_ELIGIBLE when the job is larger than the single-project bond limit', () => {
    const r = evaluateBidReadiness(construction(2_000_000, bond(1_000_000, 5_000_000, 0)))
    expect(item(r, 'BONDING')?.status).toBe('FAIL')
    expect(r.verdict).toBe('NOT_ELIGIBLE')
  })

  it('is NOT_ELIGIBLE when the job exceeds the remaining aggregate headroom', () => {
    const r = evaluateBidReadiness(construction(800_000, bond(1_000_000, 3_000_000, 2_500_000)))
    expect(item(r, 'BONDING')?.status).toBe('FAIL')
    expect(item(r, 'BONDING')?.detail).toMatch(/\$500,000/)
  })

  it('passes when the job fits both bond limits', () => {
    const r = evaluateBidReadiness(construction(800_000, bond(1_000_000, 3_000_000, 1_000_000)))
    expect(item(r, 'BONDING')?.status).toBe('PASS')
    expect(r.verdict).toBe('READY')
  })

  it('treats expired bonding as no bonding', () => {
    const r = evaluateBidReadiness(construction(400_000, { ...bond(1_000_000, 3_000_000, 0), expiryDate: inDays(-1) }))
    expect(item(r, 'BONDING')?.status).toBe('FAIL')
    expect(r.verdict).toBe('FIX_FIRST')
  })

  it('always carries the not-a-legal-determination disclaimer', () => {
    expect(evaluateBidReadiness(input()).disclaimer).toMatch(/contracting officer/)
  })
})
