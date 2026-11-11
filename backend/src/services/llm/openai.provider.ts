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

/**
 * Reasoning models count their hidden reasoning toward `max_completion_tokens`.
 * At the default (medium) effort gpt-5 can spend a caller's whole budget
 * reasoning and return an empty answer with finish_reason "length" — measured
 * locally: a 4,000-token bid-guidance call came back with 4,000 reasoning
 * tokens and no text. So reasoning gets its own allowance on top of the answer
 * budget the caller set, and runs at low effort unless OPENAI_REASONING_EFFORT
 * says otherwise. Unused tokens aren't billed.
 */
export const REASONING_TOKEN_ALLOWANCE = 8000
const REASONING_EFFORTS = ['minimal', 'low', 'medium', 'high'] as const
type ReasoningEffort = (typeof REASONING_EFFORTS)[number]

export function reasoningEffort(): ReasoningEffort {
  const v = (process.env.OPENAI_REASONING_EFFORT || '').trim().toLowerCase()
  return (REASONING_EFFORTS as readonly string[]).includes(v) ? (v as ReasoningEffort) : 'low'
}

/** Thrown when the model returns no text, so it is never shown, saved or cached as an answer. */
export class EmptyAiReplyError extends Error {
  constructor(model: string, finishReason: string | null | undefined) {
    super(`EMPTY_LLM_REPLY: ${model} returned no text (finish_reason ${finishReason ?? 'unknown'})`)
  }
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
      const reasoning = isReasoningModel(this.model)
      if (reasoning) {
        params.max_completion_tokens = maxTokens + REASONING_TOKEN_ALLOWANCE
        params.reasoning_effort = reasoningEffort()
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
      if (!text.trim()) {
        const finishReason = completion.choices[0]?.finish_reason
        logger.warn('OpenAI returned an empty reply', {
          model: this.model,
          finishReason,
          outputTokens,
          reasoningTokens: (completion.usage as { completion_tokens_details?: { reasoning_tokens?: number } } | undefined)
            ?.completion_tokens_details?.reasoning_tokens,
          reasoningEffort: reasoning ? params.reasoning_effort : undefined,
        })
        throw new EmptyAiReplyError(this.model, finishReason)
      }
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
