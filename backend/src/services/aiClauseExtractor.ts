// =============================================================
// AI Clause Extractor — LLM-powered FAR/DFARS clause detection
// Extends keyword-based complianceGapAnalysis with semantic extraction
//
// Compliance: results cached per opportunity (LLM cost control), audited
// via existing LLM router observability. Per-firm token quotas enforced
// upstream by tierGate middleware.
//
// Reliability: structured JSON output, schema-validated, falls back to
// empty array on parse failure (never crashes calling code).
// =============================================================

import { prisma } from '../config/database'
import { redis } from '../config/redis'
import { logger } from '../utils/logger'
import { generateWithRouter } from './llm/llmRouter'
import { CLAUSE_LIBRARY } from './complianceGapAnalysis'
import * as crypto from 'crypto'

// -------------------------------------------------------------
// Types
// -------------------------------------------------------------

export interface ExtractedClause {
  clauseCode: string         // e.g., "FAR 52.204-7" or "DFARS 252.204-7012"
  category: 'FAR' | 'DFARS' | 'OTHER'
  confidence: number         // 0.0–1.0
  excerpt: string            // verbatim quote from solicitation (max 240 chars)
  source: 'AI_EXTRACTION'
}

export interface ExtractionResult {
  opportunityId: string
  clauses: ExtractedClause[]
  modelUsed: string
  tokensUsed: number
  cached: boolean
  extractedAt: Date
}

// -------------------------------------------------------------
// Cache (Redis, 30-day TTL — opportunity descriptions rarely change)
// -------------------------------------------------------------

const CACHE_TTL_SECONDS = 60 * 60 * 24 * 30
const MAX_CONTEXT_CHARS = 12000   // ~3000 tokens, fits in any modern model
const MAX_EXCERPT_CHARS = 240

function cacheKey(opportunityId: string, contentHash: string): string {
  return `clause-extract:${opportunityId}:${contentHash}`
}

function hashContent(content: string): string {
  return crypto.createHash('sha256').update(content).digest('hex').slice(0, 16)
}

// -------------------------------------------------------------
// Validation — known clause prefixes (defensive — LLMs hallucinate)
// -------------------------------------------------------------

const KNOWN_FAR_PREFIXES = ['FAR 52.', 'FAR 4.', 'FAR 3.', 'FAR 14.', 'FAR 15.', 'FAR 16.', 'FAR 19.', 'FAR 22.', 'FAR 25.', 'FAR 32.', 'FAR 36.', 'FAR 37.', 'FAR 42.', 'FAR 49.']
const KNOWN_DFARS_PREFIXES = ['DFARS 252.', 'DFARS 204.', 'DFARS 219.', 'DFARS 225.', 'DFARS 227.']
const LIBRARY_CODES = new Set(CLAUSE_LIBRARY.map(c => c.code))

function isPlausibleClauseCode(code: string): boolean {
  if (LIBRARY_CODES.has(code)) return true
  return [...KNOWN_FAR_PREFIXES, ...KNOWN_DFARS_PREFIXES].some(p => code.startsWith(p))
}

function categorize(code: string): 'FAR' | 'DFARS' | 'OTHER' {
  if (code.startsWith('FAR ')) return 'FAR'
  if (code.startsWith('DFARS ')) return 'DFARS'
  return 'OTHER'
}

// -------------------------------------------------------------
// Prompt — structured JSON output, anti-hallucination
// -------------------------------------------------------------

const SYSTEM_PROMPT = `You are an expert federal contracting compliance analyst. Your job is to extract verbatim FAR (Federal Acquisition Regulation) and DFARS (Defense FAR Supplement) clause references from solicitation text.

CRITICAL RULES:
1. Extract ONLY clauses explicitly mentioned in the text. Do NOT infer or suggest clauses that aren't there.
2. Output VALID JSON only — no markdown, no preamble, no explanation.
3. For each clause, include the exact verbatim excerpt (max 240 chars) where it appears.
4. If no clauses are found, return {"clauses": []}.
5. Clause codes must follow exact format: "FAR 52.204-7" or "DFARS 252.204-7012" (single space after FAR/DFARS).
6. Confidence: 0.95+ for explicit citation with full code, 0.7-0.9 for partial citation, below 0.7 don't include.

Output schema:
{
  "clauses": [
    {
      "clauseCode": "FAR 52.204-7",
      "confidence": 0.98,
      "excerpt": "verbatim text from the document where this clause is referenced"
    }
  ]
}`

function buildUserPrompt(content: string): string {
  const truncated = content.length > MAX_CONTEXT_CHARS
    ? content.slice(0, MAX_CONTEXT_CHARS) + '\n\n[truncated]'
    : content
  return `Extract all FAR and DFARS clauses from this solicitation text:\n\n---\n${truncated}\n---\n\nReturn JSON only.`
}

// -------------------------------------------------------------
// Parser — defensive, tolerates LLM quirks (markdown fences, preamble)
// -------------------------------------------------------------

// Exported for unit tests — see aiClauseExtractor.test.ts
export function parseLLMResponse(text: string): ExtractedClause[] {
  // Strip markdown code fences if present
  let cleaned = text.trim()
  if (cleaned.startsWith('```')) {
    cleaned = cleaned.replace(/^```(?:json)?\s*/, '').replace(/```\s*$/, '')
  }

  // Strip any pre-JSON preamble (find first { or [)
  const firstBrace = Math.min(
    cleaned.indexOf('{') === -1 ? Infinity : cleaned.indexOf('{'),
    cleaned.indexOf('[') === -1 ? Infinity : cleaned.indexOf('[')
  )
  if (firstBrace > 0 && firstBrace !== Infinity) {
    cleaned = cleaned.slice(firstBrace)
  }

  let parsed: any
  try {
    parsed = JSON.parse(cleaned)
  } catch (err) {
    logger.warn('AI clause extractor: JSON parse failed', {
      error: (err as Error).message,
      preview: text.slice(0, 200),
    })
    return []
  }

  // Guard against null/non-object parse results (e.g., LLM returns "null" or a string)
  const rawClauses: any[] = Array.isArray(parsed)
    ? parsed
    : (parsed && typeof parsed === 'object' && Array.isArray(parsed.clauses))
      ? parsed.clauses
      : []

  const validated: ExtractedClause[] = []
  for (const c of rawClauses) {
    if (!c || typeof c !== 'object') continue
    const code = typeof c.clauseCode === 'string' ? c.clauseCode.trim() : ''
    const confidence = typeof c.confidence === 'number' ? c.confidence : 0
    const excerpt = typeof c.excerpt === 'string' ? c.excerpt.slice(0, MAX_EXCERPT_CHARS) : ''

    if (!code || confidence < 0.7) continue
    if (!isPlausibleClauseCode(code)) {
      logger.warn('AI clause extractor: rejected implausible code', { code })
      continue
    }

    validated.push({
      clauseCode: code,
      category: categorize(code),
      confidence: Math.min(1, Math.max(0, confidence)),
      excerpt,
      source: 'AI_EXTRACTION',
    })
  }

  // Dedupe by clauseCode (keep highest confidence)
  const byCode = new Map<string, ExtractedClause>()
  for (const c of validated) {
    const existing = byCode.get(c.clauseCode)
    if (!existing || c.confidence > existing.confidence) {
      byCode.set(c.clauseCode, c)
    }
  }

  return Array.from(byCode.values())
}

// -------------------------------------------------------------
// Public API: extract clauses from an opportunity
// -------------------------------------------------------------

export async function extractClausesFromOpportunity(
  opportunityId: string,
  consultingFirmId: string,
  opts: { force?: boolean } = {}
): Promise<ExtractionResult> {
  const opp = await prisma.opportunity.findFirst({
    where: { id: opportunityId, consultingFirmId },
    select: { id: true, title: true, description: true },
  })
  if (!opp) throw new Error('Opportunity not found')

  // Aggregate text from opportunity + any analyzed documents.
  // Note: OpportunityDocument doesn't store full extractedText, but
  // analysis output (scopeKeywords + rawAnalysis) provides clause-relevant signals.
  const docs = await prisma.opportunityDocument.findMany({
    where: { opportunityId, analysisStatus: 'COMPLETE' },
    select: { fileName: true, scopeKeywords: true, rawAnalysis: true },
    take: 5, // cap to control cost
  })

  const docsText = docs.map(d => {
    const parts = [`DOCUMENT: ${d.fileName}`]
    if (d.scopeKeywords?.length) parts.push(`Keywords: ${d.scopeKeywords.join(', ')}`)
    if (d.rawAnalysis && typeof d.rawAnalysis === 'object') {
      const analysisStr = JSON.stringify(d.rawAnalysis).slice(0, 2000)
      parts.push(`Analysis excerpt: ${analysisStr}`)
    }
    return parts.join('\n')
  }).filter(Boolean)

  const aggregated = [
    `TITLE: ${opp.title}`,
    opp.description || '',
    ...docsText,
  ].join('\n\n')

  if (aggregated.trim().length < 100) {
    logger.info('AI clause extractor: insufficient text', { opportunityId, length: aggregated.length })
    return {
      opportunityId,
      clauses: [],
      modelUsed: 'none',
      tokensUsed: 0,
      cached: false,
      extractedAt: new Date(),
    }
  }

  const contentHash = hashContent(aggregated)
  const key = cacheKey(opportunityId, contentHash)

  // Cache check (unless forced refresh)
  if (!opts.force) {
    try {
      const cached = await redis.get(key)
      if (cached) {
        const parsed = JSON.parse(cached) as ExtractionResult
        return { ...parsed, cached: true, extractedAt: new Date(parsed.extractedAt) }
      }
    } catch (err) {
      logger.warn('AI clause extractor: cache read failed', { error: (err as Error).message })
    }
  }

  // Call LLM
  let response
  try {
    response = await generateWithRouter(
      {
        systemPrompt: SYSTEM_PROMPT,
        userPrompt: buildUserPrompt(aggregated),
        maxTokens: 2000,
        temperature: 0.0, // deterministic for compliance work
      },
      consultingFirmId,
      { task: 'COMPLIANCE_MATRIX', useCache: false } // caching handled here, not in router
    )
  } catch (err: any) {
    if (err.message === 'NO_LLM_KEY') {
      logger.info('AI clause extractor: no LLM key configured', { firmId: consultingFirmId })
      return {
        opportunityId,
        clauses: [],
        modelUsed: 'none',
        tokensUsed: 0,
        cached: false,
        extractedAt: new Date(),
      }
    }
    throw err
  }

  const clauses = parseLLMResponse(response.text)

  const result: ExtractionResult = {
    opportunityId,
    clauses,
    modelUsed: `${response.provider}/${response.model}`,
    tokensUsed: response.inputTokens + response.outputTokens,
    cached: false,
    extractedAt: new Date(),
  }

  // Cache result
  try {
    await redis.setex(key, CACHE_TTL_SECONDS, JSON.stringify(result))
  } catch (err) {
    logger.warn('AI clause extractor: cache write failed', { error: (err as Error).message })
  }

  logger.info('AI clause extraction complete', {
    opportunityId,
    firmId: consultingFirmId,
    clausesFound: clauses.length,
    tokens: result.tokensUsed,
    model: result.modelUsed,
    contentLength: aggregated.length,
  })

  return result
}

// -------------------------------------------------------------
// Merge: combine keyword (existing) gaps with AI-extracted clauses
// AI fills in clauses the keyword library doesn't know about,
// boosts confidence on overlapping clauses, never overwrites severity
// -------------------------------------------------------------

export interface MergedClauseSource {
  clauseCode: string
  detectedBy: 'KEYWORD' | 'AI' | 'BOTH'
  aiConfidence?: number
  excerpt?: string
}

export function buildSourceMap(
  keywordClauseCodes: string[],
  aiClauses: ExtractedClause[]
): Map<string, MergedClauseSource> {
  const map = new Map<string, MergedClauseSource>()

  for (const code of keywordClauseCodes) {
    map.set(code, { clauseCode: code, detectedBy: 'KEYWORD' })
  }

  for (const ai of aiClauses) {
    const existing = map.get(ai.clauseCode)
    if (existing) {
      map.set(ai.clauseCode, {
        clauseCode: ai.clauseCode,
        detectedBy: 'BOTH',
        aiConfidence: ai.confidence,
        excerpt: ai.excerpt,
      })
    } else {
      map.set(ai.clauseCode, {
        clauseCode: ai.clauseCode,
        detectedBy: 'AI',
        aiConfidence: ai.confidence,
        excerpt: ai.excerpt,
      })
    }
  }

  return map
}
