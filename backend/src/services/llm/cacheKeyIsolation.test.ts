// =============================================================
// LLM response cache key — tenant isolation + full-prompt fidelity.
//
// The key previously hashed `provider|systemPrompt.slice(0,100)|
// userPrompt.slice(0,200)` with no tenant. Both halves were exploitable:
//   - no tenant  -> firm B could be served firm A's generated output
//   - truncation -> two different uploaded documents that share an opening
//                   produced the same key, so the second got the first's answer
//
// These assert against the REAL exported cacheKey. An earlier version of this
// file re-implemented the function locally, which meant reverting llmRouter.ts
// left every test green — it tested a copy of the fix, not the fix.
// =============================================================
import { describe, it, expect, vi } from 'vitest'
import * as crypto from 'crypto'

// llmRouter pulls in prisma/redis/providers at import time; stub the I/O edges
// so importing it in a unit test does not open connections.
vi.mock('../../config/database', () => ({ prisma: {} }))
vi.mock('../../config/redis', () => ({ redis: { get: vi.fn(), set: vi.fn() } }))
vi.mock('../../utils/logger', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}))

import { cacheKey } from './llmRouter'

type Req = { systemPrompt: string; userPrompt: string }

/** Thin adapter so the existing assertions read the same. */
function buildKey(task: string, req: Req, provider: string, firmId: string | undefined): string {
  return cacheKey(task as any, req as any, provider, firmId)
}

const SYSTEM = 'You are a federal contracting compliance expert. Return ONLY valid JSON.'
/** Realistic shape: a long fixed preamble, then the document body. */
const preamble = 'SOLICITATION DOCUMENT — SECTION L INSTRUCTIONS TO OFFERORS. '.repeat(6)

describe('cache key — tenant isolation', () => {
  it('gives two firms different keys for an identical prompt', () => {
    const req = { systemPrompt: SYSTEM, userPrompt: 'identical text' }
    const a = buildKey('COMPLIANCE_MATRIX', req, 'claude', 'firm-A')
        expect(a).not.toBe(buildKey('COMPLIANCE_MATRIX', req, 'claude', 'firm-B'))
  })

  it('does not let a tenant collide with the platform bucket', () => {
    const req = { systemPrompt: SYSTEM, userPrompt: 'x' }
    expect(buildKey('BID_GUIDANCE', req, 'claude', undefined))
      .not.toBe(buildKey('BID_GUIDANCE', req, 'claude', 'firm-A'))
  })

  it('is stable for the same firm + prompt (caching still works)', () => {
    const req = { systemPrompt: SYSTEM, userPrompt: 'stable' }
    expect(buildKey('BID_GUIDANCE', req, 'claude', 'firm-A'))
      .toBe(buildKey('BID_GUIDANCE', req, 'claude', 'firm-A'))
  })

  it('names the tenant in the key so keys are auditable by eye', () => {
    expect(buildKey('AI_ASSISTANT', { systemPrompt: 's', userPrompt: 'u' }, 'openai', 'firm-XYZ'))
      .toContain(':firm-XYZ:')
  })
})

describe('cache key — full prompt is hashed', () => {
  it('distinguishes documents that differ only AFTER the old 200-char cutoff', () => {
    const docA = { systemPrompt: SYSTEM, userPrompt: preamble + 'Requirement: provide 5 years past performance.' }
    const docB = { systemPrompt: SYSTEM, userPrompt: preamble + 'Requirement: provide a HUBZone certification.' }

    // Precondition: these WOULD have collided under the old truncation.
    expect(docA.userPrompt.slice(0, 200)).toBe(docB.userPrompt.slice(0, 200))

    expect(buildKey('COMPLIANCE_MATRIX', docA, 'claude', 'firm-A'))
      .not.toBe(buildKey('COMPLIANCE_MATRIX', docB, 'claude', 'firm-A'))
  })

  it('distinguishes system prompts that differ only after the old 100-char cutoff', () => {
    const long = 'You are a federal contracting expert with deep knowledge of the FAR and DFARS supplements. '
    const a = { systemPrompt: long + 'Focus on Section L.', userPrompt: 'same' }
    const b = { systemPrompt: long + 'Focus on Section M.', userPrompt: 'same' }
    expect(a.systemPrompt.slice(0, 100)).toBe(b.systemPrompt.slice(0, 100))
    expect(buildKey('COMPLIANCE_MATRIX', a, 'claude', 'firm-A'))
      .not.toBe(buildKey('COMPLIANCE_MATRIX', b, 'claude', 'firm-A'))
  })

  it('cannot be fooled by shifting content across the prompt boundary', () => {
    // Length-prefixing defeats "ab"+"c" vs "a"+"bc" concatenation collisions.
    const a = { systemPrompt: 'ab', userPrompt: 'c' }
    const b = { systemPrompt: 'a', userPrompt: 'bc' }
    expect(buildKey('DOCUMENT_ANALYSIS', a, 'claude', 'firm-A'))
      .not.toBe(buildKey('DOCUMENT_ANALYSIS', b, 'claude', 'firm-A'))
  })

  it('still separates task and provider', () => {
    const req = { systemPrompt: 's', userPrompt: 'u' }
    expect(buildKey('COMPLIANCE_MATRIX', req, 'claude', 'f')).not.toBe(buildKey('BID_GUIDANCE', req, 'claude', 'f'))
    expect(buildKey('COMPLIANCE_MATRIX', req, 'claude', 'f')).not.toBe(buildKey('COMPLIANCE_MATRIX', req, 'openai', 'f'))
  })

  it('uses the full sha256, not a truncated hex slice', () => {
    const key = buildKey('COMPLIANCE_MATRIX', { systemPrompt: 's', userPrompt: 'u' }, 'claude', 'firm-A')
    expect(key.split(':').pop()).toHaveLength(64)
  })

  it('contract fingerprint — pins the exact key format of the real function', () => {
    // Independently recomputed against the documented format, so a change to
    // llmRouter's cacheKey cannot pass unnoticed.
    const fp = ['claude', `1:s`, `1:u`].join('|')
    const expected = `llm:COMPLIANCE_MATRIX:firm-A:${crypto.createHash('sha256').update(fp).digest('hex')}`
    expect(buildKey('COMPLIANCE_MATRIX', { systemPrompt: 's', userPrompt: 'u' }, 'claude', 'firm-A')).toBe(expected)
  })
})
