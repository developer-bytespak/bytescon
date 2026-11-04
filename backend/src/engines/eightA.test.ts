// B24 — 8(a) set-asides follow the client's own 8(a) status.
import { describe, it, expect } from 'vitest'
import { runComplianceGate } from './complianceGate'
import { scoreNaicsDimension, scoreSetAsideAlignmentDimension } from './matchingV2'

const client = (eightA: boolean) => ({
  sdvosb: false, wosb: false, hubzone: false, smallBusiness: true, eightA, naicsCodes: ['541512'],
})

describe('the compliance gate on an 8(a) set-aside', () => {
  it.each(['SBA_8A', '8A'])('passes an 8(a) participant on %s', (setAsideType) => {
    const res = runComplianceGate(client(true), { setAsideType, naicsCode: '541512' })
    expect(res.blockers.join(' ')).not.toMatch(/8\(a\)/)
  })

  it.each(['SBA_8A', '8A'])('blocks everyone else on %s, even a small business', (setAsideType) => {
    const res = runComplianceGate(client(false), { setAsideType, naicsCode: '541512' })
    expect(res.blockers.join(' ')).toMatch(/8\(a\)/)
  })

  it('does not change other set-asides', () => {
    const res = runComplianceGate(client(true), { setAsideType: 'SDVOSB', naicsCode: '541512' })
    expect(res.blockers.join(' ')).toMatch(/SDVOSB/)
  })
})

describe('match scoring on an 8(a) set-aside', () => {
  const certs = (eightA: boolean) => ({ sdvosb: false, wosb: false, hubzone: false, smallBusiness: true, eightA })

  it('credits only an 8(a) participant', () => {
    expect(scoreSetAsideAlignmentDimension('SBA_8A', certs(true))).toBe(1)
    expect(scoreSetAsideAlignmentDimension('SBA_8A', certs(false))).toBe(0.2)
  })

  it('still credits a small business on a small-business set-aside', () => {
    expect(scoreSetAsideAlignmentDimension('TOTAL_SMALL_BUSINESS', certs(false))).toBe(1)
  })
})

describe('the compliance gate on a VOSB set-aside', () => {
  const profile = (sdvosb: boolean) => ({ sdvosb, wosb: false, hubzone: false, smallBusiness: true, eightA: false, naicsCodes: ['541512'] })

  it.each(['VOSB', 'VSA'])('asks a person to confirm on %s when the client has no SDVOSB status', (setAsideType) => {
    const res = runComplianceGate(profile(false), { setAsideType, naicsCode: '541512' })
    expect(res.blockers).toEqual([])
    expect(res.conditions.join(' ')).toMatch(/VOSB/)
  })

  it('accepts an SDVOSB, since every SDVOSB is a VOSB', () => {
    const res = runComplianceGate(profile(true), { setAsideType: 'VOSB', naicsCode: '541512' })
    expect(res.conditions.join(' ')).not.toMatch(/VOSB/)
  })
})

describe('placeholder NAICS codes', () => {
  it('are unusable to matching v2 and the probability engine alike', async () => {
    const { hasUsableNaics } = await import('./probabilityEngine')
    for (const code of ['000000', '0000', '00', '5', '']) expect(hasUsableNaics(code), code).toBe(false)
    expect(scoreNaicsDimension(['000'], '000')).toBe(0)
    expect(scoreNaicsDimension(['000000'], '000000')).toBe(0)
  })
})
