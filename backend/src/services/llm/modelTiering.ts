// =============================================================
// Per-task Claude model tiering
//
// High-volume extraction tasks (GB-107 description enrichment runs
// COMPLIANCE_MATRIX on up to 800 opportunities/day) run on Haiku at
// $1/$5 per MTok; customer-facing generation stays on the premium
// model at $3/$15. Both tiers are env-overridable without a rebuild:
//   CLAUDE_MODEL_CHEAP    (default claude-haiku-4-5)
//   CLAUDE_MODEL_PREMIUM  (default claude-sonnet-4-6)
//
// NOTE: do not point either tier at claude-sonnet-5 / opus-4-7+ —
// those models reject the `temperature` parameter that every call
// site in this codebase passes, and would 400 on all requests.
// =============================================================
import type { LLMTask } from './llmRouter'

export const CLAUDE_DEFAULT_MODEL = 'claude-sonnet-4-6'

// Cost per million tokens (USD), keyed by model ID. Used for the
// estimatedCostUsd written to ApiUsageLog. Unknown models fall back
// to premium pricing so costs are never underestimated.
export const CLAUDE_MODEL_COSTS: Record<string, { input: number; output: number }> = {
  'claude-sonnet-4-6': { input: 3.0, output: 15.0 },
  'claude-haiku-4-5': { input: 1.0, output: 5.0 },
}

// Extraction/classification tasks where Haiku's quality is sufficient
// and volume makes the 3-5x price difference material. Generation tasks
// (proposals, outreach, assistant) stay premium — output quality is the
// product there, and the SCW fact-check pass rejects weak drafts.
const CHEAP_CLAUDE_TASKS: ReadonlySet<string> = new Set([
  'DOCUMENT_ANALYSIS',
  'REQUIREMENT_EXTRACTION',
  'COMPLIANCE_MATRIX',
])

export function claudeModelForTask(task: LLMTask): string {
  return CHEAP_CLAUDE_TASKS.has(task)
    ? process.env.CLAUDE_MODEL_CHEAP || 'claude-haiku-4-5'
    : process.env.CLAUDE_MODEL_PREMIUM || CLAUDE_DEFAULT_MODEL
}

// =============================================================
// Per-task OpenAI model tiering — same shape as the Claude tiers.
// Env-overridable without a rebuild:
//   OPENAI_MODEL_CHEAP    (default gpt-5-mini)
//   OPENAI_MODEL_PREMIUM  (default gpt-5)
// The provider handles the GPT-5-family parameter rules
// (max_completion_tokens, no custom temperature) automatically.
// =============================================================
export const OPENAI_DEFAULT_MODEL = 'gpt-5'

// Cost per million tokens (USD). Unknown models fall back to premium
// pricing so costs are never underestimated.
export const OPENAI_MODEL_COSTS: Record<string, { input: number; output: number }> = {
  'gpt-5': { input: 1.25, output: 10.0 },
  'gpt-5-mini': { input: 0.25, output: 2.0 },
  'gpt-5-nano': { input: 0.05, output: 0.4 },
  'gpt-4o-mini': { input: 0.15, output: 0.6 },
  'gpt-4o': { input: 2.5, output: 10.0 },
}

export function openaiModelForTask(task: LLMTask): string {
  return CHEAP_CLAUDE_TASKS.has(task)
    ? process.env.OPENAI_MODEL_CHEAP || 'gpt-5-mini'
    : process.env.OPENAI_MODEL_PREMIUM || OPENAI_DEFAULT_MODEL
}
