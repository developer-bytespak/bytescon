// LLM Provider interface — all AI providers implement this contract

export interface LLMRequest {
  systemPrompt: string
  userPrompt: string
  maxTokens?: number
  temperature?: number
  /** Per-request hard timeout in ms. Defaults to 180_000 (3 min). Long
   *  generations (16K-token drafts) should pass 600_000 (10 min). */
  timeoutMs?: number
}

export interface LLMResponse {
  text: string
  inputTokens: number
  outputTokens: number
  estimatedCostUsd: number
  provider: string
  model: string
}

export interface LLMProvider {
  generate(req: LLMRequest): Promise<LLMResponse>
}
