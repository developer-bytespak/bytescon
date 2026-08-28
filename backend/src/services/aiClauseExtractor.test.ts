// =============================================================
// aiClauseExtractor — parser + source map tests
// Validates defensive LLM parsing and clause merge logic.
// Most important tests in the codebase — the parser protects
// the system from LLM hallucinations reaching compliance output.
// =============================================================

import { describe, it, expect } from 'vitest'
import { parseLLMResponse, buildSourceMap, ExtractedClause } from './aiClauseExtractor'

describe('parseLLMResponse — happy paths', () => {
  it('parses clean JSON object', () => {
    const input = JSON.stringify({
      clauses: [
        { clauseCode: 'FAR 52.204-7', confidence: 0.98, excerpt: 'Contractor shall maintain active SAM registration.' },
      ],
    })
    const result = parseLLMResponse(input)
    expect(result).toHaveLength(1)
    expect(result[0].clauseCode).toBe('FAR 52.204-7')
    expect(result[0].category).toBe('FAR')
    expect(result[0].confidence).toBe(0.98)
    expect(result[0].source).toBe('AI_EXTRACTION')
  })

  it('parses bare array', () => {
    const input = JSON.stringify([
      { clauseCode: 'DFARS 252.204-7012', confidence: 0.95, excerpt: 'NIST 800-171 applies.' },
    ])
    const result = parseLLMResponse(input)
    expect(result).toHaveLength(1)
    expect(result[0].category).toBe('DFARS')
  })

  it('strips markdown code fences', () => {
    const input = '```json\n{"clauses":[{"clauseCode":"FAR 52.204-7","confidence":0.9,"excerpt":"test"}]}\n```'
    const result = parseLLMResponse(input)
    expect(result).toHaveLength(1)
    expect(result[0].clauseCode).toBe('FAR 52.204-7')
  })

  it('strips pre-JSON preamble', () => {
    const input = 'Here are the clauses I found:\n\n{"clauses":[{"clauseCode":"FAR 52.219-14","confidence":0.85,"excerpt":"50% rule"}]}'
    const result = parseLLMResponse(input)
    expect(result).toHaveLength(1)
    expect(result[0].clauseCode).toBe('FAR 52.219-14')
  })
})

describe('parseLLMResponse — anti-hallucination', () => {
  it('rejects clause codes with unknown prefixes', () => {
    const input = JSON.stringify({
      clauses: [
        { clauseCode: 'SUPERFAKE 99.9-99', confidence: 0.99, excerpt: 'made up' },
        { clauseCode: 'FAR 52.204-7', confidence: 0.9, excerpt: 'real' },
      ],
    })
    const result = parseLLMResponse(input)
    expect(result).toHaveLength(1)
    expect(result[0].clauseCode).toBe('FAR 52.204-7')
  })

  it('rejects clauses below 0.7 confidence threshold', () => {
    const input = JSON.stringify({
      clauses: [
        { clauseCode: 'FAR 52.204-7', confidence: 0.5, excerpt: 'low confidence' },
      ],
    })
    expect(parseLLMResponse(input)).toHaveLength(0)
  })

  it('dedupes by clauseCode, keeping highest confidence', () => {
    const input = JSON.stringify({
      clauses: [
        { clauseCode: 'FAR 52.204-7', confidence: 0.75, excerpt: 'first' },
        { clauseCode: 'FAR 52.204-7', confidence: 0.95, excerpt: 'second' },
        { clauseCode: 'FAR 52.204-7', confidence: 0.85, excerpt: 'third' },
      ],
    })
    const result = parseLLMResponse(input)
    expect(result).toHaveLength(1)
    expect(result[0].confidence).toBe(0.95)
    expect(result[0].excerpt).toBe('second')
  })

  it('truncates excerpts over 240 chars', () => {
    const longExcerpt = 'X'.repeat(500)
    const input = JSON.stringify({
      clauses: [{ clauseCode: 'FAR 52.204-7', confidence: 0.9, excerpt: longExcerpt }],
    })
    const result = parseLLMResponse(input)
    expect(result[0].excerpt.length).toBe(240)
  })

  it('clamps confidence to [0, 1]', () => {
    const input = JSON.stringify({
      clauses: [
        { clauseCode: 'FAR 52.204-7', confidence: 1.5, excerpt: 'over' },
      ],
    })
    const result = parseLLMResponse(input)
    expect(result[0].confidence).toBe(1)
  })
})

describe('parseLLMResponse — graceful failure', () => {
  it('returns empty array for malformed JSON', () => {
    expect(parseLLMResponse('not json')).toEqual([])
    expect(parseLLMResponse('{"clauses":')).toEqual([])
    expect(parseLLMResponse('')).toEqual([])
  })

  it('returns empty array for wrong shape', () => {
    expect(parseLLMResponse('{"wrong": "shape"}')).toEqual([])
    expect(parseLLMResponse('null')).toEqual([])
    expect(parseLLMResponse('"just a string"')).toEqual([])
  })

  it('skips clauses missing required fields', () => {
    const input = JSON.stringify({
      clauses: [
        { clauseCode: '', confidence: 0.9 }, // empty code
        { confidence: 0.9, excerpt: 'no code' }, // missing code
        { clauseCode: 'FAR 52.204-7' }, // missing confidence
        { clauseCode: 'FAR 52.204-7', confidence: 0.9, excerpt: 'valid' },
      ],
    })
    expect(parseLLMResponse(input)).toHaveLength(1)
  })
})

describe('buildSourceMap', () => {
  it('marks keyword-only clauses correctly', () => {
    const map = buildSourceMap(['FAR 52.204-7'], [])
    expect(map.get('FAR 52.204-7')?.detectedBy).toBe('KEYWORD')
  })

  it('marks AI-only clauses correctly', () => {
    const aiClauses: ExtractedClause[] = [{
      clauseCode: 'FAR 52.204-10',
      category: 'FAR',
      confidence: 0.9,
      excerpt: 'exec comp',
      source: 'AI_EXTRACTION',
    }]
    const map = buildSourceMap([], aiClauses)
    expect(map.get('FAR 52.204-10')?.detectedBy).toBe('AI')
    expect(map.get('FAR 52.204-10')?.aiConfidence).toBe(0.9)
  })

  it('marks overlapping clauses as BOTH', () => {
    const aiClauses: ExtractedClause[] = [{
      clauseCode: 'FAR 52.204-7',
      category: 'FAR',
      confidence: 0.95,
      excerpt: 'SAM reg',
      source: 'AI_EXTRACTION',
    }]
    const map = buildSourceMap(['FAR 52.204-7'], aiClauses)
    const entry = map.get('FAR 52.204-7')
    expect(entry?.detectedBy).toBe('BOTH')
    expect(entry?.aiConfidence).toBe(0.95)
    expect(entry?.excerpt).toBe('SAM reg')
  })
})
