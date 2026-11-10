import { describe, it, expect } from 'vitest'
import { describeRejection } from './describeRejection'

describe('describeRejection', () => {
  it('keeps an Error\'s message, name, code and stack', () => {
    const err = Object.assign(new Error('Connection is closed.'), { code: 'ECONNRESET' })
    const out = describeRejection(err)
    expect(out).toMatchObject({ reason: 'Connection is closed.', name: 'Error', code: 'ECONNRESET' })
    expect(out.stack).toContain('describeRejection.test')
  })
  it('handles strings, objects, undefined and circular values', () => {
    expect(describeRejection('boom')).toEqual({ reason: 'boom' })
    expect(describeRejection({ a: 1 })).toEqual({ reason: '{"a":1}' })
    expect(describeRejection(undefined)).toEqual({ reason: 'undefined' })
    const circular: Record<string, unknown> = {}
    circular.self = circular
    expect(describeRejection(circular).reason).toBe('[object Object]')
  })
})
