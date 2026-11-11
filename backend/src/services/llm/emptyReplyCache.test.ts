// =============================================================
// The router caches AI replies for 7 days. A reply with no text must not be
// cached: otherwise one blank answer is served again on every retry for a week.
// =============================================================
import { describe, it, expect, vi, beforeEach } from 'vitest'

const redisSet = vi.fn()
const generate = vi.fn()
vi.mock('../../config/database', () => ({ prisma: {} }))
const redisGet = vi.fn()
vi.mock('../../config/redis', () => ({ redis: { get: (...a: unknown[]) => redisGet(...a), set: (...a: unknown[]) => redisSet(...a) } }))
vi.mock('../../utils/logger', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}))
vi.mock('./openai.provider', () => ({
  OpenAIProvider: class {
    generate = generate
  },
}))

import { generateWithRouter } from './llmRouter'

const answer = (text: string) => ({ text, inputTokens: 1, outputTokens: 1, estimatedCostUsd: 0, provider: 'openai', model: 'gpt-5' })

beforeEach(() => {
  redisSet.mockReset(); generate.mockReset(); redisGet.mockReset()
  redisGet.mockResolvedValue(null)
  process.env.DEFAULT_LLM_PROVIDER = 'openai'
  process.env.OPENAI_API_KEY = 'test-key'
})

describe('generateWithRouter — cache', () => {
  it('caches a reply with text', async () => {
    generate.mockResolvedValue(answer('{"a":1}'))
    await generateWithRouter({ systemPrompt: 's', userPrompt: 'with text' }, undefined, { task: 'BID_GUIDANCE', useCache: true })
    expect(redisSet).toHaveBeenCalledTimes(1)
  })

  it('serves a cached reply with text without calling the provider', async () => {
    redisGet.mockResolvedValue(JSON.stringify(answer('{"cached":true}')))
    const r = await generateWithRouter({ systemPrompt: 's', userPrompt: 'hit' }, undefined, { task: 'BID_GUIDANCE', useCache: true })
    expect(r.text).toBe('{"cached":true}')
    expect(generate).not.toHaveBeenCalled()
  })

  it('ignores a blank reply cached before the fix and asks the provider again', async () => {
    redisGet.mockResolvedValue(JSON.stringify(answer('')))
    generate.mockResolvedValue(answer('{"fresh":true}'))
    const r = await generateWithRouter({ systemPrompt: 's', userPrompt: 'stale blank' }, undefined, { task: 'BID_GUIDANCE', useCache: true })
    expect(r.text).toBe('{"fresh":true}')
    expect(generate).toHaveBeenCalledTimes(1)
  })

  it('never caches a reply with no text', async () => {
    generate.mockResolvedValue(answer('   '))
    await generateWithRouter({ systemPrompt: 's', userPrompt: 'blank' }, undefined, { task: 'BID_GUIDANCE', useCache: true })
    expect(redisSet).not.toHaveBeenCalled()
  })
})
