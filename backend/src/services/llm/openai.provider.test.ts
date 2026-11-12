// =============================================================
// OpenAI provider — reasoning models (gpt-5, o-series) count hidden reasoning
// toward max_completion_tokens. At the default effort gpt-5 spent a whole
// 4,000-token bid-guidance budget reasoning and returned no text, which the
// features then showed as blank answers. These pin the fix: low effort, a
// reasoning allowance on top of the answer budget, and an error, not a blank
// "success", when a reply is still empty.
// =============================================================
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

const create = vi.fn()
vi.mock('openai', () => ({
  default: class {
    chat = { completions: { create } }
  },
}))
vi.mock('../../utils/logger', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}))

import { OpenAIProvider, REASONING_TOKEN_ALLOWANCE, EmptyAiReplyError, reasoningEffort } from './openai.provider'

const reply = (content: string, finish = 'stop') => ({
  choices: [{ message: { content }, finish_reason: finish }],
  usage: { prompt_tokens: 100, completion_tokens: 700, completion_tokens_details: { reasoning_tokens: 600 } },
})

beforeEach(() => {
  create.mockReset()
  delete process.env.OPENAI_REASONING_EFFORT
})
afterEach(() => {
  delete process.env.OPENAI_REASONING_EFFORT
})

describe('OpenAIProvider — reasoning models', () => {
  it('adds a reasoning allowance to the answer budget and asks for low effort', async () => {
    create.mockResolvedValue(reply('{"ok":true}'))
    const r = await new OpenAIProvider('k', 'gpt-5').generate({ systemPrompt: 's', userPrompt: 'u', maxTokens: 4000 })
    const params = create.mock.calls[0][0]
    expect(params.max_completion_tokens).toBe(4000 + REASONING_TOKEN_ALLOWANCE)
    expect(params.reasoning_effort).toBe('low')
    expect(params).not.toHaveProperty('max_tokens')
    expect(params).not.toHaveProperty('temperature')
    expect(r).toMatchObject({ text: '{"ok":true}', provider: 'openai', model: 'gpt-5' })
  })

  it('takes the effort from OPENAI_REASONING_EFFORT, ignoring an invalid value', () => {
    process.env.OPENAI_REASONING_EFFORT = 'Medium'
    expect(reasoningEffort()).toBe('medium')
    process.env.OPENAI_REASONING_EFFORT = 'extreme'
    expect(reasoningEffort()).toBe('low')
  })

  it('throws instead of returning a blank answer when reasoning used the budget', async () => {
    create.mockResolvedValue(reply('', 'length'))
    await expect(new OpenAIProvider('k', 'gpt-5-mini').generate({ systemPrompt: 's', userPrompt: 'u', maxTokens: 800 }))
      .rejects.toBeInstanceOf(EmptyAiReplyError)
  })

  it('treats a whitespace-only reply as empty', async () => {
    create.mockResolvedValue(reply('  \n '))
    await expect(new OpenAIProvider('k', 'gpt-5').generate({ systemPrompt: 's', userPrompt: 'u' }))
      .rejects.toThrow(/EMPTY_LLM_REPLY/)
  })
})

describe('OpenAIProvider — older models', () => {
  it('keeps max_tokens and temperature, with no reasoning settings', async () => {
    create.mockResolvedValue(reply('hi'))
    await new OpenAIProvider('k', 'gpt-4o-mini').generate({ systemPrompt: 's', userPrompt: 'u', maxTokens: 500, temperature: 0.3 })
    const params = create.mock.calls[0][0]
    expect(params).toMatchObject({ max_tokens: 500, temperature: 0.3 })
    expect(params).not.toHaveProperty('max_completion_tokens')
    expect(params).not.toHaveProperty('reasoning_effort')
  })
})
