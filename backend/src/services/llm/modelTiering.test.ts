import { describe, it, expect, afterEach } from 'vitest'
import { claudeModelForTask, CLAUDE_MODEL_COSTS, CLAUDE_DEFAULT_MODEL } from './modelTiering'

const ORIGINAL_CHEAP = process.env.CLAUDE_MODEL_CHEAP
const ORIGINAL_PREMIUM = process.env.CLAUDE_MODEL_PREMIUM

afterEach(() => {
  if (ORIGINAL_CHEAP === undefined) delete process.env.CLAUDE_MODEL_CHEAP
  else process.env.CLAUDE_MODEL_CHEAP = ORIGINAL_CHEAP
  if (ORIGINAL_PREMIUM === undefined) delete process.env.CLAUDE_MODEL_PREMIUM
  else process.env.CLAUDE_MODEL_PREMIUM = ORIGINAL_PREMIUM
})

describe('claudeModelForTask', () => {
  it('routes high-volume extraction tasks to Haiku', () => {
    delete process.env.CLAUDE_MODEL_CHEAP
    expect(claudeModelForTask('DOCUMENT_ANALYSIS')).toBe('claude-haiku-4-5')
    expect(claudeModelForTask('REQUIREMENT_EXTRACTION')).toBe('claude-haiku-4-5')
    expect(claudeModelForTask('COMPLIANCE_MATRIX')).toBe('claude-haiku-4-5')
  })

  it('keeps generation tasks on the premium model', () => {
    delete process.env.CLAUDE_MODEL_PREMIUM
    expect(claudeModelForTask('BID_GUIDANCE')).toBe(CLAUDE_DEFAULT_MODEL)
    expect(claudeModelForTask('PROPOSAL_DRAFT')).toBe(CLAUDE_DEFAULT_MODEL)
    expect(claudeModelForTask('TEAMING_OUTREACH')).toBe(CLAUDE_DEFAULT_MODEL)
    expect(claudeModelForTask('AI_ASSISTANT')).toBe(CLAUDE_DEFAULT_MODEL)
    expect(claudeModelForTask('PROPOSAL_OUTLINE')).toBe(CLAUDE_DEFAULT_MODEL)
    expect(claudeModelForTask('CONTRACT_ANALYSIS')).toBe(CLAUDE_DEFAULT_MODEL)
  })

  it('honors env overrides for both tiers', () => {
    process.env.CLAUDE_MODEL_CHEAP = 'claude-custom-cheap'
    process.env.CLAUDE_MODEL_PREMIUM = 'claude-custom-premium'
    expect(claudeModelForTask('COMPLIANCE_MATRIX')).toBe('claude-custom-cheap')
    expect(claudeModelForTask('PROPOSAL_DRAFT')).toBe('claude-custom-premium')
  })

  it('has pricing entries for both default tiers', () => {
    expect(CLAUDE_MODEL_COSTS['claude-haiku-4-5']).toEqual({ input: 1.0, output: 5.0 })
    expect(CLAUDE_MODEL_COSTS[CLAUDE_DEFAULT_MODEL]).toEqual({ input: 3.0, output: 15.0 })
  })
})
