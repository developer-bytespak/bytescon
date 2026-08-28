import { LLMProvider, LLMRequest, LLMResponse } from './provider.interface'
import { logger } from '../../utils/logger'
import { CLAUDE_DEFAULT_MODEL, CLAUDE_MODEL_COSTS } from './modelTiering'

const ANTHROPIC_API_URL = 'https://api.anthropic.com/v1/messages'

export class ClaudeProvider implements LLMProvider {
  private readonly model: string

  constructor(
    private readonly apiKey: string,
    model?: string | null,
  ) {
    this.model = model || CLAUDE_DEFAULT_MODEL
  }

  async generate(req: LLMRequest): Promise<LLMResponse> {
    const controller = new AbortController()
    const timeoutMs = req.timeoutMs ?? 180_000
    const timeout = setTimeout(() => controller.abort(), timeoutMs)

    let response: Response
    try {
      response = await fetch(ANTHROPIC_API_URL, {
        method: 'POST',
        signal: controller.signal,
        headers: {
          'Content-Type': 'application/json',
          'x-api-key': this.apiKey,
          'anthropic-version': '2023-06-01',
        },
        body: JSON.stringify({
          model: this.model,
          max_tokens: req.maxTokens ?? 4000,
          temperature: req.temperature ?? 0,
          // System prompt as a block with cache_control: calls sharing the
          // same system prompt within 5 minutes (e.g. a user generating
          // several outreach drafts in a row) read it from Anthropic's
          // prompt cache at ~0.1x input price. Prompts below the model's
          // minimum cacheable prefix (2048 tokens on Sonnet 4.6, 4096 on
          // Haiku 4.5) silently skip caching — no error, no write premium.
          system: [
            {
              type: 'text',
              text: req.systemPrompt,
              cache_control: { type: 'ephemeral' },
            },
          ],
          messages: [{ role: 'user', content: req.userPrompt }],
        }),
      })
    } finally {
      clearTimeout(timeout)
    }

    if (!response.ok) {
      const errText = await response.text()
      logger.error('Claude API error', { status: response.status, model: this.model, body: errText })
      throw new Error(`Claude API error ${response.status}: ${errText}`)
    }

    const data = (await response.json()) as any
    const text: string =
      data.content
        ?.filter((b: any) => b.type === 'text')
        ?.map((b: any) => b.text as string)
        ?.join('') || ''

    // usage.input_tokens is only the UNCACHED remainder — total prompt size
    // is input + cache_creation + cache_read. Writes bill at 1.25x input
    // price, reads at 0.1x.
    const uncachedInput: number = data.usage?.input_tokens ?? 0
    const cacheWriteTokens: number = data.usage?.cache_creation_input_tokens ?? 0
    const cacheReadTokens: number = data.usage?.cache_read_input_tokens ?? 0
    const outputTokens: number = data.usage?.output_tokens ?? 0

    const costs = CLAUDE_MODEL_COSTS[this.model] ?? CLAUDE_MODEL_COSTS[CLAUDE_DEFAULT_MODEL]
    const estimatedCostUsd =
      ((uncachedInput + cacheWriteTokens * 1.25 + cacheReadTokens * 0.1) / 1_000_000) * costs.input +
      (outputTokens / 1_000_000) * costs.output

    return {
      text,
      inputTokens: uncachedInput + cacheWriteTokens + cacheReadTokens,
      outputTokens,
      estimatedCostUsd,
      provider: 'claude',
      model: this.model,
    }
  }
}
