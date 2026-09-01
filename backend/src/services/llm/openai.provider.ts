import OpenAI from 'openai'
import { LLMProvider, LLMRequest, LLMResponse } from './provider.interface'
import { logger } from '../../utils/logger'
import { OPENAI_DEFAULT_MODEL, OPENAI_MODEL_COSTS } from './modelTiering'

/**
 * GPT-5-family and o-series models are reasoning models with different
 * parameter rules than the gpt-4o generation:
 *   - `max_tokens` is rejected; they take `max_completion_tokens`
 *   - custom `temperature` is rejected (only the default is allowed)
 * Detect by model id so both families work from the same call sites.
 */
function isReasoningModel(model: string): boolean {
  return /^(gpt-5|o\d)/.test(model)
}

export class OpenAIProvider implements LLMProvider {
  private client: OpenAI
  private model: string

  constructor(apiKey: string, model: string = OPENAI_DEFAULT_MODEL) {
    this.client = new OpenAI({ apiKey })
    this.model = model
  }

  async generate(req: LLMRequest): Promise<LLMResponse> {
    try {
      const maxTokens = req.maxTokens ?? 4000
      const params: Record<string, unknown> = {
        model: this.model,
        messages: [
          { role: 'system', content: req.systemPrompt },
          { role: 'user', content: req.userPrompt },
        ],
      }
      if (isReasoningModel(this.model)) {
        params.max_completion_tokens = maxTokens
        // temperature intentionally omitted — reasoning models 400 on it.
      } else {
        params.max_tokens = maxTokens
        params.temperature = req.temperature ?? 0
      }

      const completion = await this.client.chat.completions.create(
        params as unknown as OpenAI.Chat.Completions.ChatCompletionCreateParamsNonStreaming,
        { timeout: req.timeoutMs ?? 180_000 }
      )

      const text = completion.choices[0]?.message?.content ?? ''
      const inputTokens = completion.usage?.prompt_tokens ?? 0
      const outputTokens = completion.usage?.completion_tokens ?? 0
      const cost = OPENAI_MODEL_COSTS[this.model] ?? OPENAI_MODEL_COSTS[OPENAI_DEFAULT_MODEL]
      const estimatedCostUsd =
        (inputTokens / 1_000_000) * cost.input +
        (outputTokens / 1_000_000) * cost.output

      return { text, inputTokens, outputTokens, estimatedCostUsd, provider: 'openai', model: this.model }
    } catch (err) {
      logger.error('OpenAI API error', { error: (err as Error).message, model: this.model })
      throw err
    }
  }
}
