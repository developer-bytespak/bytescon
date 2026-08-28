import * as crypto from 'crypto'
import { prisma } from '../../config/database'
import { redis } from '../../config/redis'
import { logger } from '../../utils/logger'
import { AiUnavailableError } from '../../utils/errors'
import { decryptSecret } from '../../utils/fieldCrypto'
import { LLMRequest, LLMResponse } from './provider.interface'
import { ClaudeProvider } from './claude.provider'
import { OpenAIProvider } from './openai.provider'
import { DeepSeekProvider } from './deepseek.provider'
import { InsightEngineProvider } from './insight.provider'
import { LocalAIProvider } from './localai.provider'
import { claudeModelForTask } from './modelTiering'
import { notifyLlmOutage } from './outageAlert'
import { isLlmBaseUrlBlockedSync } from '../../utils/ssrfGuard'

export type LLMTask =
  | 'DOCUMENT_ANALYSIS'
  | 'COMPLIANCE_MATRIX'
  | 'BID_GUIDANCE'
  | 'AI_ASSISTANT'
  | 'REQUIREMENT_EXTRACTION'
  | 'PROPOSAL_OUTLINE'
  | 'PROPOSAL_DRAFT'
  | 'CONTRACT_ANALYSIS'
  | 'TEAMING_OUTREACH'
  // §7.5 — optional teaming agreement / NDA first drafts. Every draft is
  // reviewable-only: the router returns text, never an executable document.
  | 'TEAMING_AGREEMENT_DRAFT'

const CACHE_TTL_SECONDS = 60 * 60 * 24 * 7 // 7 days

/**
 * Is an LLM provider actually usable for this firm?
 *
 * §7.5 — a non-throwing pre-flight so an OPTIONAL LLM feature can choose its
 * deterministic path instead of calling the router and catching NO_LLM_KEY. It
 * resolves provider and keys exactly as `generateWithRouter` does, so the two
 * cannot disagree about whether a key exists.
 */
export async function isLlmProviderConfigured(consultingFirmId?: string): Promise<boolean> {
  const platformDefault = process.env.DEFAULT_LLM_PROVIDER || 'claude'
  let provider = platformDefault
  let anthropic: string | null = process.env.ANTHROPIC_API_KEY || null
  let openai: string | null = process.env.OPENAI_API_KEY || null
  let deepseek: string | null = process.env.DEEPSEEK_API_KEY || null
  let insight: string | null = process.env.INSIGHT_ENGINE_API_KEY || null

  if (consultingFirmId) {
    try {
      const firm = await prisma.consultingFirm.findUnique({
        where: { id: consultingFirmId },
        select: {
          llmProvider: true, anthropicApiKey: true, openaiApiKey: true,
          deepseekApiKey: true, insightEngineApiKey: true,
        },
      })
      if (firm) {
        provider = firm.llmProvider ?? platformDefault
        if (firm.anthropicApiKey) anthropic = decryptSecret(firm.anthropicApiKey)
        if (firm.openaiApiKey) openai = decryptSecret(firm.openaiApiKey)
        if (firm.deepseekApiKey) deepseek = decryptSecret(firm.deepseekApiKey)
        if (firm.insightEngineApiKey) insight = decryptSecret(firm.insightEngineApiKey)
      }
    } catch {
      // A config read failure is treated as "not configured": the caller then
      // takes its deterministic path, which is always safe.
      return false
    }
  }

  if (provider === 'localai') return Boolean(process.env.LOCALAI_BASE_URL)
  if (provider === 'openai') return Boolean(openai)
  if (provider === 'deepseek') return Boolean(deepseek)
  if (provider === 'insight_engine') return Boolean(insight)
  return Boolean(anthropic)
}

/**
 * Cache key for an LLM response.
 *
 * TENANT-SCOPED AND FULL-PROMPT. Two properties matter here and both were
 * previously broken:
 *
 *  1. `consultingFirmId` is in the key. Without it, two firms whose prompts
 *     happen to match share a cache entry — one tenant serving another tenant's
 *     generated compliance matrix or bid guidance. Firms also supply their own
 *     provider keys, so a shared entry crosses a billing boundary too.
 *
 *  2. The FULL system and user prompts are hashed. The prior fingerprint used
 *     `systemPrompt.slice(0, 100)` and `userPrompt.slice(0, 200)`, and these
 *     prompts open with a fixed instruction block followed by the document
 *     text — so two different uploads routinely produced an identical
 *     fingerprint and the second one silently received the first one's answer.
 *     Hashing in full costs microseconds and removes the collision class.
 *
 * Callers without a tenant (platform-level work) get an explicit `platform`
 * bucket rather than sharing the anonymous space with real tenants.
 */
export function cacheKey(
  task: LLMTask,
  req: LLMRequest,
  provider: string,
  consultingFirmId: string | undefined
): string {
  const tenant = consultingFirmId || 'platform'
  // Length-prefix each field so no concatenation of different splits can
  // collide (e.g. prompts "ab"+"c" vs "a"+"bc").
  const fingerprint = [
    provider,
    `${req.systemPrompt.length}:${req.systemPrompt}`,
    `${req.userPrompt.length}:${req.userPrompt}`,
  ].join('|')
  const hash = crypto.createHash('sha256').update(fingerprint).digest('hex')
  return `llm:${task}:${tenant}:${hash}`
}

export async function generateWithRouter(
  req: LLMRequest,
  consultingFirmId: string | undefined,
  opts: { task: LLMTask; useCache?: boolean }
): Promise<LLMResponse> {
  // Resolve provider config from DB, with platform env vars as fallback.
  // DEFAULT_LLM_PROVIDER env var sets the platform-wide default (e.g. 'openai')
  // so AI features work out of the box without firms configuring their own keys.
  const platformDefault = process.env.DEFAULT_LLM_PROVIDER || 'claude'
  let llmProvider = platformDefault
  let anthropicApiKey: string | null = process.env.ANTHROPIC_API_KEY || null
  let openaiApiKey: string | null = process.env.OPENAI_API_KEY || null
  let deepseekApiKey: string | null = process.env.DEEPSEEK_API_KEY || null
  let insightEngineApiKey: string | null = process.env.INSIGHT_ENGINE_API_KEY || null
  let localaiBaseUrl: string | null = process.env.LOCALAI_BASE_URL || null
  let localaiModel: string | null = process.env.LOCALAI_MODEL || null

  if (consultingFirmId) {
    try {
      const firm = await prisma.consultingFirm.findUnique({
        where: { id: consultingFirmId },
        select: { llmProvider: true, anthropicApiKey: true, openaiApiKey: true, deepseekApiKey: true, insightEngineApiKey: true, localaiBaseUrl: true, localaiModel: true },
      })
      if (firm) {
        // Use firm's provider choice if they set one, otherwise use platform default
        llmProvider = firm.llmProvider ?? platformDefault
        // Firm-level keys override platform env keys
        if (firm.anthropicApiKey) anthropicApiKey = decryptSecret(firm.anthropicApiKey)
        if (firm.openaiApiKey) openaiApiKey = decryptSecret(firm.openaiApiKey)
        if (firm.deepseekApiKey) deepseekApiKey = decryptSecret(firm.deepseekApiKey)
        if (firm.insightEngineApiKey) insightEngineApiKey = decryptSecret(firm.insightEngineApiKey)
        if (firm.localaiModel) localaiModel = firm.localaiModel
        if (firm.localaiBaseUrl) {
          const rewritten = firm.localaiBaseUrl.replace(
            /https?:\/\/localhost(:\d+)?/,
            (_, port) => `http://ollama${port || ':11434'}`
          )
          // Defense-in-depth: ignore a stored value that targets a private/
          // reserved host (e.g. a row written before the write-path guard, or
          // a DNS-rebind). Fall back to the platform default endpoint.
          if (isLlmBaseUrlBlockedSync(rewritten)) {
            logger.warn('Ignoring unsafe firm LocalAI base URL', { consultingFirmId })
            localaiBaseUrl = process.env.LOCALAI_BASE_URL || null
          } else {
            localaiBaseUrl = rewritten
          }
        }
      }
    } catch (err) {
      logger.warn('Failed to load firm LLM config, using env defaults', { error: (err as Error).message })
    }
  }

  // LocalAI (Mistral 7B class) cannot reliably produce the 16K-token structured
  // JSON required for full proposal drafts — the output is truncated/malformed
  // and renders as a blank PDF. Block LocalAI for BID_GUIDANCE entirely.
  const localAiBlockedForTask = opts.task === 'BID_GUIDANCE'
  if (llmProvider === 'localai' && localAiBlockedForTask) {
    throw new Error('NO_LLM_KEY')
  }

  // Validate the key for the chosen provider (LocalAI runs locally — no key required)
  const activeKey =
    llmProvider === 'openai' ? openaiApiKey :
    llmProvider === 'deepseek' ? deepseekApiKey :
    llmProvider === 'insight_engine' ? insightEngineApiKey :
    llmProvider === 'localai' ? 'localai' :
    anthropicApiKey

  if (!activeKey) {
    throw new Error('NO_LLM_KEY')
  }

  const key = cacheKey(opts.task, req, llmProvider, consultingFirmId)

  // Cache read (skip for DOCUMENT_ANALYSIS — content varies per doc)
  if (opts.useCache) {
    try {
      const cached = await redis.get(key)
      if (cached) {
        logger.debug('LLM cache hit', { task: opts.task, provider: llmProvider })
        const cachedResponse = JSON.parse(cached) as LLMResponse

        // Log cache hit with zero cost
        if (consultingFirmId) {
          prisma.apiUsageLog.create({
            data: {
              consultingFirmId,
              provider: llmProvider,
              model: cachedResponse.model,
              task: opts.task,
              inputTokens: 0,
              outputTokens: 0,
              estimatedCostUsd: 0,
              cacheHit: true,
              durationMs: 0,
            },
          }).catch((err: Error) => {
            logger.warn('Failed to log cached LLM response to ApiUsageLog', { error: err.message })
          }) // non-blocking
        }
        return cachedResponse
      }
    } catch {
      // Redis miss or error — proceed with live call
    }
  }

  // Instantiate provider — LocalAI gets a Claude fallback if it fails
  const provider =
    llmProvider === 'openai'         ? new OpenAIProvider(activeKey) :
    llmProvider === 'deepseek'       ? new DeepSeekProvider(activeKey) :
    llmProvider === 'insight_engine' ? new InsightEngineProvider(activeKey) :
    llmProvider === 'localai'        ? new LocalAIProvider(localaiBaseUrl, localaiModel) :
    new ClaudeProvider(activeKey, claudeModelForTask(opts.task))

  const startMs = Date.now()
  let result: LLMResponse
  try {
    result = await provider.generate(req)
  } catch (providerErr) {
    const errMsg = (providerErr as Error).message

    // Surface rate-limit errors immediately — no point retrying
    if (errMsg.includes('429') || errMsg.toLowerCase().includes('rate_limit')) {
      throw new Error('RATE_LIMITED')
    }

    if (llmProvider === 'localai') {
      // LocalAI failed — try Claude, then give up
      if (anthropicApiKey) {
        logger.warn('LocalAI call failed — falling back to Claude', { error: errMsg })
        try {
          result = await new ClaudeProvider(anthropicApiKey, claudeModelForTask(opts.task)).generate(req)
        } catch (claudeErr) {
          logger.error('Claude fallback after LocalAI failure also failed', {
            error: (claudeErr as Error).message,
            task: opts.task,
          })
          void notifyLlmOutage({ provider: llmProvider, task: opts.task, error: (claudeErr as Error).message })
          throw new AiUnavailableError()
        }
      } else {
        logger.error('LocalAI call failed and no Claude key available to fall back to', {
          error: errMsg,
          task: opts.task,
        })
        void notifyLlmOutage({ provider: llmProvider, task: opts.task, error: errMsg })
        throw new AiUnavailableError()
      }
    } else {
      // LocalAI fallback is disabled for BID_GUIDANCE (proposal drafts) — Mistral 7B
      // can't produce reliable 16K JSON output and silently corrupts the artifact.
      const localaiUrl = localaiBaseUrl || process.env.LOCALAI_BASE_URL || null
      if (!localaiUrl || localAiBlockedForTask) {
        logger.error(`${llmProvider} call failed, LocalAI fallback skipped`, { error: errMsg, task: opts.task })
        void notifyLlmOutage({ provider: llmProvider, task: opts.task, error: errMsg })
        throw new AiUnavailableError()
      }
      logger.warn(`${llmProvider} call failed — falling back to LocalAI`, { error: errMsg, url: localaiUrl })
      try {
        result = await new LocalAIProvider(localaiUrl, localaiModel).generate(req)
        result = { ...result, provider: `localai-fallback-from-${llmProvider}` }
      } catch (localaiErr) {
        logger.error('LocalAI fallback also failed', {
          error: (localaiErr as Error).message,
          originalError: errMsg,
          task: opts.task,
        })
        void notifyLlmOutage({ provider: llmProvider, task: opts.task, error: errMsg })
        throw new AiUnavailableError()
      }
    }
  }
  const durationMs = Date.now() - startMs

  // Log usage (non-blocking)
  if (consultingFirmId) {
    prisma.apiUsageLog.create({
      data: {
        consultingFirmId,
        provider: result.provider,
        model: result.model,
        task: opts.task,
        inputTokens: result.inputTokens,
        outputTokens: result.outputTokens,
        estimatedCostUsd: result.estimatedCostUsd,
        cacheHit: false,
        durationMs,
      },
    }).catch((err) => logger.warn('Failed to log AI usage', { error: (err as Error).message }))
  }

  // Cache write
  if (opts.useCache) {
    try {
      await redis.set(key, JSON.stringify(result), 'EX', CACHE_TTL_SECONDS)
    } catch {
      // Cache write failure is non-fatal
    }
  }

  return result
}
