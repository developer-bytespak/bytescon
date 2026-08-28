// =============================================================
// AI Assistant — floating chat agent for platform guidance
// POST /api/assistant/chat
// =============================================================
import { Router, Response, NextFunction } from 'express'
import { z } from 'zod'
import { authenticateJWT } from '../middleware/auth'
import { requireActiveBase, requireAddon } from '../middleware/addonGate'
import { enforceTenantScope, getTenantId } from '../middleware/tenant'
import { AuthenticatedRequest } from '../types'
import { generateWithRouter } from '../services/llm/llmRouter'
import { prisma } from '../config/database'
import { logger } from '../utils/logger'

const router = Router()

const ChatSchema = z.object({
  message: z.string().min(1).max(2000),
  history: z.array(z.object({
    role: z.enum(['user', 'assistant']),
    content: z.string(),
  })).max(20).default([]),
})

const SYSTEM_PROMPT = `You are Bytescon AI — the in-app assistant for the Bytescon Advisory Intelligence platform.
Your role is to help government contracting consultants navigate and use the platform effectively.

Platform capabilities you can help with:
- **Opportunities**: Syncing from SAM.gov, searching, filtering, viewing details, uploading solicitation documents
- **Client Management**: Adding clients, setting up NAICS codes, certifications (SDVOSB, 8(a), HUBZone, WOSB), SAM.gov lookup by UEI/CAGE
- **Win Scoring**: 8-factor AI probability engine, per-client analysis, baseline vs client-specific scores
- **Bid Decisions**: Running analysis, understanding BID PRIME / BID SUB / NO BID recommendations
- **Compliance Matrix**: AI-generated document requirement checklists from solicitation docs
- **Proposal Assistant**: AI-guided Q&A flow to generate proposal drafts (requires tokens)
- **Submissions**: Tracking submission records, on-time/late status
- **Penalties**: Financial penalty tracking and trend analysis
- **Analytics**: Pipeline funnel, win distribution, revenue forecasting (Monte Carlo), market intelligence
- **Subcontracting**: Finding subcontracting opportunities from prime contractors
- **State & Municipal**: State/county-level contract opportunities (add-on)
- **Client Portal**: Read-only portal for your clients to see their pipeline and decisions
- **Settings**: SAM.gov API key, AI provider selection (Claude/OpenAI/Ollama), penalty engine config
- **Billing**: Subscription management, token purchases for AI features

Navigation tips:
- Dashboard is the home page with KPI cards and charts
- Sidebar has all main sections
- Admin-only pages: Settings, Compliance Logs

Scoring explanation:
- Baseline Score = best probability across all active clients (computed by background worker)
- Client-Specific Score = per-client analysis factoring in NAICS match, set-aside eligibility, past performance, competition density, agency history, penalty drag, and Bayesian calibration
- If a client scores 0%, they likely need NAICS codes added to their profile

Be concise, helpful, and direct. Use the platform's terminology. If asked about something outside the platform, politely redirect to platform features. Never make up features that don't exist.`

router.post(
  '/chat',
  authenticateJWT,
  enforceTenantScope,
  requireActiveBase,
  requireAddon('proposal_studio'),
  async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
    try {
      const { message, history } = ChatSchema.parse(req.body)
      const consultingFirmId = getTenantId(req)

      // Build conversation context
      const conversationContext = history
        .map(m => `${m.role === 'user' ? 'User' : 'Assistant'}: ${m.content}`)
        .join('\n')

      const userPrompt = conversationContext
        ? `${conversationContext}\nUser: ${message}`
        : message

      // Fetch some context about the user's firm
      const firm = await prisma.consultingFirm.findUnique({
        where: { id: consultingFirmId },
        select: {
          name: true,
          _count: { select: { clientCompanies: true, opportunities: true } },
        },
      })

      const contextNote = firm
        ? `\n\nContext: The user is from "${firm.name}" which has ${firm._count.clientCompanies} client(s) and ${firm._count.opportunities} opportunity(ies) in the system.`
        : ''

      const response = await generateWithRouter(
        {
          systemPrompt: SYSTEM_PROMPT + contextNote,
          userPrompt,
          maxTokens: 800,
          temperature: 0.3,
        },
        consultingFirmId,
        { task: 'AI_ASSISTANT', useCache: false }
      )

      logger.info('AI assistant chat', {
        consultingFirmId,
        userId: req.user?.userId,
        inputTokens: response.inputTokens,
        outputTokens: response.outputTokens,
        cost: response.estimatedCostUsd,
      })

      res.json({
        success: true,
        data: {
          reply: response.text,
          provider: response.provider,
          model: response.model,
          tokens: response.inputTokens + response.outputTokens,
        },
      })
    } catch (err) {
      next(err)
    }
  }
)

export default router
