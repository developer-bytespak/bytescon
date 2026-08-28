import OpenAI from 'openai'
import { LLMProvider, LLMRequest, LLMResponse } from './provider.interface'
import { logger } from '../../utils/logger'

// DeepSeek V3: best price/performance for business analysis and writing
// OpenAI-compatible API at api.deepseek.com
const DEEPSEEK_MODEL = 'deepseek-chat'
const DEEPSEEK_BASE_URL = 'https://api.deepseek.com/v1'

// Cost per million tokens (USD) — DeepSeek V3 pricing
const COST_INPUT_PER_M  = 0.27
const COST_OUTPUT_PER_M = 1.10

export class DeepSeekProvider implements LLMProvider {
  private client: OpenAI

  constructor(apiKey: string) {
    this.client = new OpenAI({ apiKey, baseURL: DEEPSEEK_BASE_URL })
  }

  async generate(req: LLMRequest): Promise<LLMResponse> {
    try {
      const completion = await this.client.chat.completions.create({
        model: DEEPSEEK_MODEL,
        max_tokens: req.maxTokens ?? 4000,
        temperature: req.temperature ?? 0,
        messages: [
          { role: 'system', content: req.systemPrompt },
          { role: 'user', content: req.userPrompt },
        ],
      })

      const text = completion.choices[0]?.message?.content ?? ''
      const inputTokens  = completion.usage?.prompt_tokens ?? 0
      const outputTokens = completion.usage?.completion_tokens ?? 0
      const estimatedCostUsd =
        (inputTokens  / 1_000_000) * COST_INPUT_PER_M +
        (outputTokens / 1_000_000) * COST_OUTPUT_PER_M

      return { text, inputTokens, outputTokens, estimatedCostUsd, provider: 'deepseek', model: DEEPSEEK_MODEL }
    } catch (err) {
      logger.error('DeepSeek API error', { error: (err as Error).message })
      throw err
    }
  }
}
