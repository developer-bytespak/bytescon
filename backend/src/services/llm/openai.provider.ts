import OpenAI from 'openai'
import { LLMProvider, LLMRequest, LLMResponse } from './provider.interface'
import { logger } from '../../utils/logger'

const OPENAI_MODEL = 'gpt-4o-mini'

// Cost per million tokens (USD)
const COST_INPUT_PER_M = 0.15
const COST_OUTPUT_PER_M = 0.60

export class OpenAIProvider implements LLMProvider {
  private client: OpenAI

  constructor(apiKey: string) {
    this.client = new OpenAI({ apiKey })
  }

  async generate(req: LLMRequest): Promise<LLMResponse> {
    try {
      const completion = await this.client.chat.completions.create({
        model: OPENAI_MODEL,
        max_tokens: req.maxTokens ?? 4000,
        temperature: req.temperature ?? 0,
        messages: [
          { role: 'system', content: req.systemPrompt },
          { role: 'user', content: req.userPrompt },
        ],
      })

      const text = completion.choices[0]?.message?.content ?? ''
      const inputTokens = completion.usage?.prompt_tokens ?? 0
      const outputTokens = completion.usage?.completion_tokens ?? 0
      const estimatedCostUsd =
        (inputTokens / 1_000_000) * COST_INPUT_PER_M +
        (outputTokens / 1_000_000) * COST_OUTPUT_PER_M

      return { text, inputTokens, outputTokens, estimatedCostUsd, provider: 'openai', model: OPENAI_MODEL }
    } catch (err) {
      logger.error('OpenAI API error', { error: (err as Error).message })
      throw err
    }
  }
}
