// =============================================================
// The router caches AI replies for 7 days. A reply with no text must not be
// cached: otherwise one blank answer is served again on every retry for a week.
// =============================================================
import { describe, it, expect, vi, beforeEach } from 'vitest'

const redisSet = vi.fn()
const generate = vi.fn()
vi.mock('../../config/database', () => ({ prisma: {} }))
vi.mock('../../config/redis', () => ({ redis: { get: vi.fn().mockResolvedValue(null), set: (...a: unknown[]) => redisSet(...a) } }))
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
  redisSet.mockReset(); generate.mockReset()
  process.env.DEFAULT_LLM_PROVIDER = 'openai'
  process.env.OPENAI_API_KEY = 'test-key'
})

describe('generateWithRouter — cache', () => {
  it('caches a reply with text', async () => {
    generate.mockResolvedValue(answer('{"a":1}'))
    await generateWithRouter({ systemPrompt: 's', userPrompt: 'with text' }, undefined, { task: 'BID_GUIDANCE', useCache: true })
    expect(redisSet).toHaveBeenCalledTimes(1)
  })

  it('never caches a reply with no text', async () => {
    generate.mockResolvedValue(answer('   '))
    await generateWithRouter({ systemPrompt: 's', userPrompt: 'blank' }, undefined, { task: 'BID_GUIDANCE', useCache: true })
    expect(redisSet).not.toHaveBeenCalled()
  })
})
