// Ollama — Self-hosted LLM engine with OpenAI-compatible API.
// Runs at http://ollama:11434/v1 inside Docker, http://localhost:11434/v1 from host.
// Pull a model: docker exec bytescon_ollama ollama pull mistral:7b-instruct
import OpenAI from 'openai'
import { LLMProvider, LLMRequest, LLMResponse } from './provider.interface'
import { logger } from '../../utils/logger'

const DEFAULT_BASE_URL = 'http://ollama:11434/v1'
// mistral:7b-instruct — best overall quality for business analysis + proposal writing at this size.
// Alternatives: llama3.1:8b (128k context), phi4:14b (exceptional reasoning), qwen2.5:14b
const DEFAULT_MODEL = process.env.LOCALAI_MODEL || 'mistral:7b-instruct'

export class LocalAIProvider implements LLMProvider {
  private client: OpenAI
  private model: string

  constructor(baseUrl?: string | null, model?: string | null, apiKey?: string | null) {
    this.model = model || DEFAULT_MODEL
    this.client = new OpenAI({
      apiKey: apiKey || 'none',
      baseURL: baseUrl || DEFAULT_BASE_URL,
    })
  }

  async generate(req: LLMRequest): Promise<LLMResponse> {
    try {
      const completion = await this.client.chat.completions.create({
        model: this.model,
        max_tokens: req.maxTokens ?? 4000,
        temperature: req.temperature ?? 0,
        messages: [
          { role: 'system', content: req.systemPrompt },
          { role: 'user', content: req.userPrompt },
        ],
        // Ollama-specific: expand context window beyond the default 4096
        // Without this, large prompts (documents, compliance matrices) get truncated
        // @ts-expect-error — Ollama extension field not in OpenAI types
        num_ctx: 32768,
      })

      const text = completion.choices[0]?.message?.content ?? ''
      const inputTokens = completion.usage?.prompt_tokens ?? 0
      const outputTokens = completion.usage?.completion_tokens ?? 0

      return {
        text,
        inputTokens,
        outputTokens,
        estimatedCostUsd: 0,
        provider: 'localai',
        model: this.model,
      }
    } catch (err) {
      const msg = (err as Error).message
      logger.error('LocalAI API error', { error: msg, baseUrl: this.client.baseURL, model: this.model })
      if (msg.includes('ECONNREFUSED') || msg.includes('ENOTFOUND') || msg.includes('fetch failed')) {
        throw new Error(`Local AI (Ollama) is not reachable at ${this.client.baseURL}. Ensure the Ollama container is running: docker compose up -d ollama`)
      }
      if (msg.includes('model') && msg.includes('not found')) {
        throw new Error(`Ollama model "${this.model}" not found. Pull it first: docker exec bytescon_ollama ollama pull ${this.model}`)
      }
      throw err
    }
  }
}
