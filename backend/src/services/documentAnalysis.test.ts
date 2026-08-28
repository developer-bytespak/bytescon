// =============================================================
// documentAnalysis — unit tests (P1-3)
//
// Asserts the disease fix: a malformed or incomplete AI response SURFACES as a
// thrown error (→ worker writes FAILED, BullMQ retries) instead of being masked
// as a fabricated complexityScore/alignmentScore of 0.5. The LLM router is
// mocked; a real temp .txt file feeds the (non-PDF) read path.
// =============================================================
import { describe, it, expect, vi, beforeAll, afterAll } from 'vitest'
import * as fs from 'fs'
import * as path from 'path'
import { tmpdir } from 'os'

vi.mock('./llm/llmRouter', () => ({ generateWithRouter: vi.fn() }))
vi.mock('../utils/logger', () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}))

import { documentAnalysisService } from './documentAnalysis'
import { generateWithRouter } from './llm/llmRouter'

const gen = generateWithRouter as unknown as ReturnType<typeof vi.fn>
const DOC = path.join(tmpdir(), 'ralph_docanalysis_test.txt')

beforeAll(() => fs.writeFileSync(DOC, 'SOW content '.repeat(40), 'utf-8')) // > 100 chars
afterAll(() => { try { fs.unlinkSync(DOC) } catch { /* ignore */ } })

describe('documentAnalysis (P1-3 — parse/incomplete failures surface, never fabricated 0.5)', () => {
  it('returns the real scores from a valid AI response', async () => {
    gen.mockResolvedValue({
      text: JSON.stringify({ complexityScore: 0.8, alignmentScore: 0.3, scopeKeywords: ['x'], incumbentSignals: [] }),
    })
    const r = await documentAnalysisService.analyzeDocument(DOC)
    expect(r.complexityScore).toBeCloseTo(0.8, 6)
    expect(r.alignmentScore).toBeCloseTo(0.3, 6)
  })

  it('THROWS on an unparseable AI response — never a fabricated 0.5', async () => {
    gen.mockResolvedValue({ text: 'Sorry, I cannot comply. Here is some prose {but broken' })
    await expect(documentAnalysisService.analyzeDocument(DOC)).rejects.toThrow(/not valid json|analysis failed/i)
  })

  it('THROWS when the response is valid JSON but missing required scores', async () => {
    gen.mockResolvedValue({ text: JSON.stringify({ scopeKeywords: ['x'], incumbentSignals: [] }) })
    await expect(documentAnalysisService.analyzeDocument(DOC)).rejects.toThrow(/missing required|analysis failed/i)
  })
})
