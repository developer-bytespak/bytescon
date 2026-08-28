// =============================================================
// SCW-4 outreach generator — unit tests for the fact-check pass.
//
// The full draftScwOutreach pipeline hits Prisma + the LLM router, both
// of which require live infra. These tests instead drive the pure-function
// parts via __scwOutreachInternals — that's where the spec's correctness
// guarantee actually lives.
// =============================================================

import { describe, it, expect, vi } from 'vitest'

// outreachGenerator transitively imports the prisma client, the LLM
// router, and the redis config — those panic at import time without a
// live DATABASE_URL. Mock the leaves so the pure-function helpers we're
// exercising load cleanly in a unit-test environment.
vi.mock('../../config/database', () => ({
  prisma: {
    opportunity: { findFirst: vi.fn() },
    consultingFirm: { findUnique: vi.fn() },
    recipientProfile: { findUnique: vi.fn() },
    scwOutreachDraft: { create: vi.fn() },
    $queryRaw: vi.fn(),
  },
}))
vi.mock('../../config/redis', () => ({ redis: { get: vi.fn(), set: vi.fn() } }))
vi.mock('../llm/llmRouter', () => ({ generateWithRouter: vi.fn() }))
vi.mock('../auditService', () => ({ logAudit: vi.fn() }))
vi.mock('../../utils/logger', () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}))

import { __scwOutreachInternals } from './outreachGenerator'

const { parseLlmJson, factCheckOrThrow, buildReviewChecklist } = __scwOutreachInternals

// =============================================================
// JSON parsing
// =============================================================

describe('parseLlmJson', () => {
  it('parses well-formed JSON with all required fields', () => {
    const text = JSON.stringify({
      subject: 'Hi',
      salutation: 'Dear team,',
      body: 'Body here',
      closing: 'Best, Firm',
      factsCited: [{ claim: '3 past awards', source: 'primeStats.pastAwardsCount' }],
    })
    const r = parseLlmJson(text)
    expect(r.subject).toBe('Hi')
    expect(r.factsCited).toHaveLength(1)
  })

  it('strips ```json fences', () => {
    const inner = JSON.stringify({
      subject: 'a', salutation: 'b', body: 'c', closing: 'd', factsCited: [],
    })
    const r = parseLlmJson('```json\n' + inner + '\n```')
    expect(r.subject).toBe('a')
  })

  it('throws on invalid JSON', () => {
    expect(() => parseLlmJson('not json')).toThrow(/SCW-4 LLM response was not valid JSON/)
  })

  it('throws when a required field is missing', () => {
    const text = JSON.stringify({ subject: 'a', salutation: 'b', body: 'c' /* no closing */ })
    expect(() => parseLlmJson(text)).toThrow(/missing one of/)
  })
})

// =============================================================
// Fact-check pass — the load-bearing correctness gate
// =============================================================

const SAFE_FACTS = {
  tenant: { firmName: 'Bytes Platform' },
  opportunity: {
    title: 'Q702--New Orleans DOM IOT&A',
    solicitationNumber: 'SOL-12345',
    agency: 'Veterans Affairs',
    daysRemaining: 12,
  },
  primeStats: {
    primeName: 'ABC SERVICES INC',
    pastAwardsCount: 14,
    totalPastValueDisplay: '$42M',
  },
  sdvosbCompliance: { underPressure: false },
  contact: { primaryContactName: null },
}

describe('factCheckOrThrow', () => {
  it('passes when every numeric in body appears in FACTS', () => {
    const parsed = {
      subject: 'Partnership opportunity',
      salutation: 'Dear Business Development Team,',
      body: 'We noted your 14 past awards totaling $42M in this NAICS at Veterans Affairs.',
      closing: 'Best, Bytes Platform',
      factsCited: [
        { claim: '14 past awards', source: 'primeStats.pastAwardsCount' },
        { claim: '$42M', source: 'primeStats.totalPastValueDisplay' },
      ],
    }
    expect(() => factCheckOrThrow(parsed, SAFE_FACTS)).not.toThrow()
  })

  it('rejects a body containing a hallucinated dollar amount', () => {
    const parsed = {
      subject: 'x',
      salutation: 'Dear team,',
      body: 'Your firm has won $500M in similar contracts.',  // $500M not in FACTS
      closing: 'Best, Firm',
      factsCited: [],
    }
    expect(() => factCheckOrThrow(parsed, SAFE_FACTS)).toThrow(/\$500M/)
  })

  it('rejects a hallucinated integer count', () => {
    const parsed = {
      subject: 'x',
      salutation: 'Dear team,',
      body: 'We see 27 awards in this space.',  // 27 not in FACTS
      closing: 'Best, Firm',
      factsCited: [],
    }
    expect(() => factCheckOrThrow(parsed, SAFE_FACTS)).toThrow(/"27"/)
  })

  it('allows year tokens (1900-2099) without entries in FACTS', () => {
    const parsed = {
      subject: 'x',
      salutation: 'Dear team,',
      body: 'Over fiscal 2024, your firm has won 14 awards totaling $42M.',
      closing: 'Best, Firm',
      factsCited: [],
    }
    expect(() => factCheckOrThrow(parsed, SAFE_FACTS)).not.toThrow()
  })

  it('rejects a personal salutation when no contact name is on file', () => {
    const parsed = {
      subject: 'x',
      salutation: 'Dear Mr. Smith,',  // hallucinated personal name
      body: 'Body with 14 awards and $42M.',
      closing: 'Best, Firm',
      factsCited: [],
    }
    expect(() => factCheckOrThrow(parsed, SAFE_FACTS)).toThrow(/personal name/i)
  })

  it('allows a personal salutation when the contact name IS on file', () => {
    const factsWithContact = {
      ...SAFE_FACTS,
      contact: { primaryContactName: 'Jane Smith' },
    }
    const parsed = {
      subject: 'x',
      salutation: 'Dear Ms. Smith,',
      body: 'Body with 14 awards and $42M.',
      closing: 'Best, Firm',
      factsCited: [],
    }
    expect(() => factCheckOrThrow(parsed, factsWithContact)).not.toThrow()
  })

  it('allows a numeric claim that is annotated in factsCited even if it is paraphrased', () => {
    const parsed = {
      subject: 'x',
      salutation: 'Dear team,',
      body: 'Roughly $50M in this space.',  // $50M not literally in FACTS but cited
      closing: 'Best, Firm',
      factsCited: [{ claim: '$50M', source: 'paraphrased from primeStats.totalPastValueDisplay' }],
    }
    expect(() => factCheckOrThrow(parsed, SAFE_FACTS)).not.toThrow()
  })
})

// =============================================================
// Review checklist generation
// =============================================================

describe('buildReviewChecklist', () => {
  it('always includes the core review items', () => {
    const items = buildReviewChecklist(SAFE_FACTS)
    expect(items.join(' ')).toMatch(/Subject line/)
    expect(items.join(' ')).toMatch(/cites only facts/)
    expect(items.join(' ')).toMatch(/No placeholders/)
  })

  it('adds the SDVOSB-pressure verification item when underPressure is true', () => {
    const items = buildReviewChecklist({
      ...SAFE_FACTS,
      sdvosbCompliance: { underPressure: true },
    })
    expect(items.some((i) => /SDVOSB-goal-gap reference is accurate/.test(i))).toBe(true)
  })

  it('adds the inverse "does NOT imply pressure" item when underPressure is false', () => {
    const items = buildReviewChecklist(SAFE_FACTS)
    expect(items.some((i) => /does NOT imply/.test(i))).toBe(true)
  })
})
