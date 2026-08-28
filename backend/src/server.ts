// =============================================================
// GovCon Advisory Intelligence Platform
// Production-Grade Express Server
// =============================================================

import 'dotenv/config'
// Observability — Sentry must initialize before other modules import
// so unhandled exceptions during boot are captured.
import { initSentry, Sentry, metricsMiddleware, metricsHandler } from './config/observability'
initSentry()

import express from 'express'
import path from 'path'
import helmet from 'helmet'
import cors from 'cors'
import morgan from 'morgan'
import rateLimit from 'express-rate-limit'

import { config } from './config/config'
import { connectDatabase, disconnectDatabase, prisma } from './config/database'
import { getOrSeedPlans } from './services/billingService'
import { connectRedis, disconnectRedis } from './config/redis'
import { logger } from './utils/logger'
import { errorHandler, notFoundHandler } from './middleware/errorHandler'
import { auditMutations } from './middleware/auditMiddleware'
import { startScoringWorker } from './workers/scoringWorker'
import { startEnrichmentWorker } from './workers/enrichmentWorker'
import { startRecalibrationWorker } from './workers/recalibrationWorker'
import { startDeadlineNotificationWorker } from './workers/deadlineNotificationWorker'
import { startPortfolioScoringWorker } from './workers/portfolioScoringWorker'
import { startOpportunitySyncWorker } from './workers/opportunitySyncWorker'
import { startOpportunityExpiryWorker } from './workers/opportunityExpiryWorker'
import { startWatchlistDigestWorker } from './workers/watchlistDigestWorker'
import { startSection6Worker } from './workers/section6Worker'
import { startAgentWorker } from './workers/agentWorker'
import { startStripeWebhookRotationReminderWorker } from './workers/stripeWebhookRotationReminderWorker'
import { startMarketIntelligenceRefreshWorker } from './workers/marketIntelligenceRefreshWorker'
import { startRequirementExtractionWorker } from './workers/requirementExtractionWorker'
import { startWinnersIntelRefreshWorker } from './workers/winnersIntelRefreshWorker'
import { startClientMatchNotificationWorker } from './workers/clientMatchNotificationWorker'
import { startDocumentAnalysisWorker } from './workers/documentAnalysisWorker'
import { startSubcontractMaintenanceWorker } from './workers/subcontractMaintenanceWorker'
import { startOpsWatchdogWorker } from './workers/opsWatchdogWorker'
import { wireJobObservability } from './services/jobHealth'
import { sendOpsAlert } from './services/alertService'
import opsHeartbeatRoutes from './routes/opsHeartbeat'
import { recoverOrphanedDocuments } from './services/orphanRecovery'

// Route imports
import authRoutes from './routes/auth'
import opportunityRoutes from './routes/opportunities'
import clientRoutes from './routes/clients'
import submissionRoutes from './routes/submissions'
import pursuitRoutes from './routes/pursuits'
import penaltyRoutes from './routes/penalties'
import firmRoutes from './routes/firm'
import decisionRoutes from './routes/decision'
import jobRoutes from './routes/jobs'
import documentsRoutes from './routes/documents'
import docRequirementsRoutes from './routes/docRequirements'
import clientPortalRoutes from './routes/clientPortal'
import clientDeliverablesRoutes from './routes/clientDeliverables'
import rewardsRoutes from './routes/rewards'
import templateRoutes from './routes/templates'
import clientDocumentsRoutes from './routes/clientDocuments'
import pastPerformanceRoutes from './routes/pastPerformance'
import registrationRoutes from './routes/registration'
import contractManagementRoutes from './routes/contractManagement'
import contractFinanceRoutes from './routes/contractFinance'
import qualificationRoutes from './routes/qualification'
import gateReviewRoutes from './routes/gateReviews'
import notificationRoutes from './routes/notifications'
import monitoringProfileRoutes from './routes/monitoringProfiles'
// §6 — the four-pillar enhancement APIs.
import discoveryRoutes from './routes/discovery'
import scoringIntelRoutes from './routes/scoringIntel'
import requirementsIntelRoutes from './routes/requirementsIntel'
import milestoneRoutes from './routes/milestones'
import agentRoutes from './routes/agents'
import contractHealthRoutes from './routes/contractHealth'
import opportunityAgentRoutes from './routes/opportunityAgent'
import complianceAgentRoutes from './routes/complianceAgent'
import qualificationAgentRoutes from './routes/qualificationAgent'
import teamingAgentRoutes from './routes/teamingAgent'
import pricingAgentRoutes from './routes/pricingAgent'
import proposalAgentRoutes from './routes/proposalAgent'
import financeAgentRoutes from './routes/financeAgent'
import intelligenceAgentRoutes from './routes/intelligenceAgent'
import captureEvidenceRoutes from './routes/captureEvidence'
import analyticsRoutes from './routes/analytics'
import complianceMatrixRoutes from './routes/complianceMatrix'
import billingRoutes from './routes/billing'
import marketAnalyticsRoutes from './routes/marketAnalytics'
import addonsRoutes from './routes/addons'
import proposalAssistRoutes from './routes/proposalAssist'
import proposalRoutes from './routes/proposal'
import pricingRoutes from './routes/pricing'
import submissionWorkspaceRoutes from './routes/submissionWorkspace'
import pastPerformanceLibraryRoutes from './routes/pastPerformanceLibrary'
import stateMunicipalRoutes from './routes/stateMunicipal'
import setAsideRoutes from './routes/setAside'
import subcontractingRoutes from './routes/subcontracting'
import subcontractingContactsRoutes from './routes/subcontractingContacts'
import contractsRoutes from './routes/contracts'
import assistantRoutes from './routes/assistant'
import brandingRoutes from './routes/branding'
import stripeWebhookRoutes from './routes/stripeWebhook'
import backtestRoutes from './routes/backtest'
import betaRoutes from './routes/beta'
import farClausesRoutes from './routes/farClauses'
import healthAdminRoutes from './routes/health'
import agencyRoutes from './routes/agency'
import teamingRoutes from './routes/teaming'
import recipientRoutes from './routes/recipient'
import scwRoutes from './routes/scw'
import mcpRoutes from './routes/mcp'
import crmRoutes from './routes/crm'
import erpRoutes from './routes/erp'
import personnelRoutes from './routes/personnel'
import knowledgeRoutes from './routes/knowledge'
import publicApiV1Routes from './routes/publicApi/v1'
import integrationRoutes, { callbackRouter as integrationCallbackRouter } from './routes/integrations'
import integrationWebhookRoutes from './routes/integrationWebhooks'
import esignRoutes from './routes/esign'
import rbacRoutes from './routes/rbac'
import ssoRoutes, { ssoPublicRouter } from './routes/sso'
import partnerPortalRoutes from './routes/partnerPortal'
import { mountGB106 } from './gb106/mount.gb106'
import type { OnboardingPrisma } from './gb106/services/onboarding.service'
import { mountGb107 } from './gb107/mount.gb107'
import { authenticateJWT } from './middleware/auth'
import { enforceTenantScope } from './middleware/tenant'
import { resolveOnboardingTenant, OnboardingRequest } from './middleware/onboardingTenant'
import { getVerifiedCustomDomains, PLATFORM_ROOT_DOMAIN } from './services/hostResolver'

async function bootstrap(): Promise<void> {
  const app = express()

  app.set('trust proxy', 1)

  // -------------------------------------------------------------
  // Security Middleware
  // -------------------------------------------------------------
  app.use(
    helmet({
      contentSecurityPolicy: config.isProduction,
      hsts: config.isProduction,
    })
  )

  app.use(
    cors({
      origin: async (origin, cb) => {
        if (!config.isProduction) {
          cb(null, true)
          return
        }

        if (!origin) {
          cb(null, true)
          return
        }

        // Static allowlist from env
        const allowed = (process.env.ALLOWED_ORIGINS || '')
          .split(',')
          .map((o) => o.trim())
          .filter(Boolean)

        if (allowed.includes(origin)) {
          cb(null, true)
          return
        }

        // Always allow platform root + its subdomains
        try {
          const url = new URL(origin)
          const host = url.hostname.toLowerCase()
          if (host === PLATFORM_ROOT_DOMAIN || host.endsWith(`.${PLATFORM_ROOT_DOMAIN}`)) {
            cb(null, true)
            return
          }

          // Check verified custom domains (cached 5min in hostResolver)
          const customDomains = await getVerifiedCustomDomains()
          if (customDomains.includes(host)) {
            cb(null, true)
            return
          }
        } catch {
          // fall through to deny
        }

        cb(new Error('Origin not allowed by CORS'))
      },
      credentials: true,
      methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
      allowedHeaders: ['Content-Type', 'Authorization'],
    })
  )

  app.use(
    rateLimit({
      windowMs: config.rateLimit.windowMs,
      max: config.rateLimit.max,
      standardHeaders: true,
      legacyHeaders: false,
      message: {
        success: false,
        error: 'Too many requests',
        code: 'RATE_LIMITED',
      },
    })
  )

  // -------------------------------------------------------------
  // Stripe Webhook (BEFORE express.json — needs raw body for signature)
  // -------------------------------------------------------------
  app.use('/api/webhooks', stripeWebhookRoutes)
  // §8.5 — provider webhooks need the RAW body for signature verification, so
  // they mount here, beside the Stripe webhook and before express.json().
  app.use('/api/webhooks/integrations', integrationWebhookRoutes)

  // Ops heartbeat — token-authed reporting endpoint for host scripts
  // (nightly backup). Mounted on app directly: no JWT/tenant stack, and
  // apiRouter's audit middleware expects an authenticated user context.
  app.use('/api/ops', opsHeartbeatRoutes)

  // -------------------------------------------------------------
  // Parsing Middleware
  // -------------------------------------------------------------
  app.use(express.json({ limit: '50mb' }))
  app.use(express.urlencoded({ extended: true }))

  // -------------------------------------------------------------
  // Request Logging
  // -------------------------------------------------------------
  app.use(
    morgan('combined', {
      stream: { write: (message) => logger.http(message.trim()) },
      skip: (req) => req.url === '/health',
    })
  )

  // -------------------------------------------------------------
  // Observability — must run early so all routes are observed.
  // Metrics endpoint mounted under /api/ so Caddy/nginx forward
  // it to the backend (root-level paths fall through to the SPA).
  // Sentry auto-instruments errors.
  // -------------------------------------------------------------
  app.use(metricsMiddleware)
  app.get('/api/metrics', metricsHandler)

  // -------------------------------------------------------------
  // Health Check
  // -------------------------------------------------------------
  app.get('/health', async (_req, res) => {
    try {
      await prisma.$queryRaw`SELECT 1`
      res.json({
        status: 'healthy',
        timestamp: new Date().toISOString(),
        version: process.env.npm_package_version || '1.0.0',
        environment: config.env,
        db: 'ok',
      })
    } catch {
      res.status(503).json({
        status: 'unhealthy',
        timestamp: new Date().toISOString(),
        db: 'error',
      })
    }
  })

  // -------------------------------------------------------------
  // Public branding-asset serving
  //
  // Per-firm and per-client logos uploaded via the branding endpoints land
  // under uploads/branding/ and are served unauthenticated — they appear on
  // proposal PDFs that go to federal agencies and on public client-portal
  // login pages, so requiring auth would break those flows. Express's
  // express.static prevents path traversal; we additionally restrict the
  // mounted directory to uploads/branding ONLY so non-branding uploads
  // (capability statements, deliverables, etc.) stay behind the dedicated
  // authenticated download routes.
  // -------------------------------------------------------------
  const brandingAssetsDir = path.join(process.cwd(), 'uploads', 'branding')
  app.use(
    '/uploads/branding',
    express.static(brandingAssetsDir, {
      fallthrough: false,
      maxAge: '1d',
      index: false,
      dotfiles: 'deny',
    }),
  )

  // -------------------------------------------------------------
  // API Router
  // -------------------------------------------------------------
  const apiRouter = express.Router()

  // Audit-event capture for mutating /api/* requests. Defers the write
  // until res.finish so per-route auth has populated req.user.
  apiRouter.use(auditMutations)

  apiRouter.use('/auth', authRoutes)
  apiRouter.use('/opportunities', opportunityRoutes)
  apiRouter.use('/clients', clientRoutes)
  apiRouter.use('/submissions', submissionRoutes)
  apiRouter.use('/pursuits', pursuitRoutes)
  apiRouter.use('/penalties', penaltyRoutes)
  apiRouter.use('/firm', firmRoutes)
  apiRouter.use('/decision', decisionRoutes)
  apiRouter.use('/jobs', jobRoutes)
  apiRouter.use('/documents', documentsRoutes)
  apiRouter.use('/doc-requirements', docRequirementsRoutes)
  apiRouter.use('/client-portal', clientPortalRoutes)
  apiRouter.use('/client-deliverables', clientDeliverablesRoutes)
  apiRouter.use('/rewards', rewardsRoutes)
  apiRouter.use('/templates', templateRoutes)
  apiRouter.use('/client-documents', clientDocumentsRoutes)
  apiRouter.use('/past-performance', pastPerformanceRoutes)
  apiRouter.use('/registration', registrationRoutes)
  apiRouter.use('/contract-management', contractManagementRoutes)
  apiRouter.use('/contract-finance', contractFinanceRoutes)
  apiRouter.use('/qualification', qualificationRoutes)
  apiRouter.use('/gate-reviews', gateReviewRoutes)
  apiRouter.use('/notifications', notificationRoutes)
  apiRouter.use('/monitoring-profiles', monitoringProfileRoutes)
  apiRouter.use('/discovery', discoveryRoutes)
  apiRouter.use('/scoring-intel', scoringIntelRoutes)
  apiRouter.use('/requirements-intel', requirementsIntelRoutes)
  apiRouter.use('/milestones', milestoneRoutes)
  // Mounted before the generic /agents router so its own paths win.
  apiRouter.use('/agents/opportunity', opportunityAgentRoutes)
  apiRouter.use('/agents/compliance', complianceAgentRoutes)
  apiRouter.use('/agents/qualification', qualificationAgentRoutes)
  apiRouter.use('/agents/teaming', teamingAgentRoutes)
  apiRouter.use('/agents/pricing', pricingAgentRoutes)
  apiRouter.use('/agents/proposal', proposalAgentRoutes)
  apiRouter.use('/agents/finance', financeAgentRoutes)
  apiRouter.use('/agents/intelligence', intelligenceAgentRoutes)
  apiRouter.use('/agents', agentRoutes)
  apiRouter.use('/contract-health', contractHealthRoutes)
  apiRouter.use('/capture-evidence', captureEvidenceRoutes)
  apiRouter.use('/analytics', analyticsRoutes)
  apiRouter.use('/compliance-matrix', complianceMatrixRoutes)
  apiRouter.use('/billing', billingRoutes)
  apiRouter.use('/market-analytics', marketAnalyticsRoutes)
  apiRouter.use('/addons', addonsRoutes)
  apiRouter.use('/proposal-assist', proposalAssistRoutes)
  apiRouter.use('/proposal', proposalRoutes)
  apiRouter.use('/pricing', pricingRoutes)
  apiRouter.use('/submission', submissionWorkspaceRoutes)
  apiRouter.use('/past-performance-library', pastPerformanceLibraryRoutes)
  apiRouter.use('/state-municipal', stateMunicipalRoutes)
  apiRouter.use('/setaside', setAsideRoutes)
  // Mount the contacts directory at the more-specific path BEFORE the
  // broader /subcontracting router so it is matched directly.
  apiRouter.use('/subcontracting/contacts', subcontractingContactsRoutes)
  apiRouter.use('/subcontracting', subcontractingRoutes)
  apiRouter.use('/contracts', contractsRoutes)
  apiRouter.use('/assistant', assistantRoutes)
  apiRouter.use('/branding', brandingRoutes)
  apiRouter.use('/admin/backtest', backtestRoutes)
  apiRouter.use('/far/clauses', farClausesRoutes)
  apiRouter.use('/health', healthAdminRoutes)
  apiRouter.use('/beta', betaRoutes)
  apiRouter.use('/agency', agencyRoutes)
  apiRouter.use('/teaming', teamingRoutes)
  apiRouter.use('/recipient', recipientRoutes)
  apiRouter.use('/scw', scwRoutes)
  apiRouter.use('/admin/mcp', mcpRoutes)
  apiRouter.use('/crm', crmRoutes)
  apiRouter.use('/erp', erpRoutes)
  apiRouter.use('/personnel', personnelRoutes)
  apiRouter.use('/knowledge', knowledgeRoutes)
  // The versioned public API. Mounted last among data routers so its own
  // 404 handler cannot shadow an internal path.
  apiRouter.use('/integrations/callback', integrationCallbackRouter)
  apiRouter.use('/integrations', integrationRoutes)
  apiRouter.use('/esign', esignRoutes)
  apiRouter.use('/rbac', rbacRoutes)
  apiRouter.use('/sso', ssoPublicRouter)
  apiRouter.use('/sso', ssoRoutes)
  apiRouter.use('/v1', publicApiV1Routes)
  apiRouter.use('/partner-portal', partnerPortalRoutes)

  app.use('/api', apiRouter)

  // -------------------------------------------------------------
  // GB-106 Platform & Vehicle Onboarding (additive mount).
  // Guarded by the real auth stack (authenticateJWT + enforceTenantScope)
  // plus the host tenant adapter, NOT the module's placeholder resolver.
  // Registered as a sibling of /api so the guards run before the module
  // router; see backend/src/gb106/README context and middleware/onboardingTenant.
  // -------------------------------------------------------------
  app.use('/api/onboarding', authenticateJWT, enforceTenantScope, resolveOnboardingTenant)
  mountGB106({
    app,
    // The module needs only a minimal structural slice of PrismaClient; the
    // overloaded host client isn't directly assignable, so narrow at the seam.
    prisma: prisma as unknown as OnboardingPrisma,
    basePath: '/api/onboarding',
    resolveTenant: (req) => (req as OnboardingRequest).onboardingProfile ?? null,
  })

  // -------------------------------------------------------------
  // Error Handling
  // -------------------------------------------------------------
  // Sentry's Express integration — captures errors thrown in any
  // route + logs them with request context. No-op when SENTRY_DSN
  // is unset. Must come BEFORE the app's errorHandler so Sentry
  // sees the error before the response is sent.
  Sentry.setupExpressErrorHandler(app)
  app.use(notFoundHandler)
  app.use(errorHandler)

  // -------------------------------------------------------------
  // Infrastructure Connections
  // -------------------------------------------------------------
  await connectDatabase()
  await connectRedis()

  // Seed the subscription plan catalogue from DEFAULT_PLANS so code-defined prices
  // are reflected in the DB on every deploy, and the public /billing/public/plans
  // endpoint (landing-page pricing) always has data — even on a fresh DB. Idempotent
  // upsert; non-fatal so a seed hiccup can't block boot.
  await getOrSeedPlans().catch((err) =>
    logger.error('Subscription plan seed at startup failed (non-fatal)', {
      error: (err as Error).message,
    })
  )

  // P1-5: reap document jobs orphaned at IN_PROGRESS/EXTRACTING by a prior crash
  // BEFORE workers start. A killed process can't run `finally` and BullMQ's
  // `failed` event never fired for it, so without this they stay stuck forever
  // (mirrors findOrClearStaleRunningJob for IngestionJob). Non-fatal on error.
  await recoverOrphanedDocuments().catch((err) =>
    logger.error('Orphaned-document recovery failed at startup (non-fatal)', {
      error: (err as Error).message,
    })
  )

  const scoringWorker = startScoringWorker()
  const enrichmentWorker = startEnrichmentWorker()
  const recalibrationWorker = startRecalibrationWorker()
  const deadlineNotificationWorker = startDeadlineNotificationWorker()
  const portfolioScoringWorker = startPortfolioScoringWorker()
  const watchlistDigestWorker = startWatchlistDigestWorker()
  const section6Worker = startSection6Worker()
  // §7.0 — one shared runtime for all nine agents (dispatch + tick + reaper).
  const agentWorker = startAgentWorker()
  const stripeRotationReminderWorker = startStripeWebhookRotationReminderWorker()
  const marketIntelligenceRefreshWorker = startMarketIntelligenceRefreshWorker()
  const requirementExtractionWorker = startRequirementExtractionWorker()
  // Winners intel is dormant by default — startWinnersIntelRefreshWorker
  // returns null unless ENABLE_WINNERS_INTEL=true is in the env.
  const winnersIntelRefreshWorker = startWinnersIntelRefreshWorker()
  // GB-103 — gated by CLIENT_NOTIFICATIONS_ENABLED (default off in prod).
  const clientMatchNotificationWorker = startClientMatchNotificationWorker()
  const documentAnalysisWorker = startDocumentAnalysisWorker()
  const subcontractMaintenanceWorker = startSubcontractMaintenanceWorker()
  const opportunitySyncWorker = startOpportunitySyncWorker()
  const opportunityExpiryWorker = startOpportunityExpiryWorker()
  // GB-107 — SAM.gov description enrichment (additive mount; idles without SAM_GOV_API_KEY).
  const gb107 = mountGb107()

  // -------------------------------------------------------------
  // Platform alerting — every worker failure pages ops (throttled),
  // every cron sweep feeds the dead-man's switch, and the watchdog
  // alerts when a registered job goes silent. Demand-driven workers
  // (scoring, enrichment, extraction, analysis) get failure alerts
  // only — their cadence depends on traffic, so no staleness window.
  // -------------------------------------------------------------
  wireJobObservability(scoringWorker, 'scoring', { heartbeat: false, severity: 'warning' })
  wireJobObservability(enrichmentWorker, 'enrichment', { heartbeat: false, severity: 'warning' })
  wireJobObservability(requirementExtractionWorker, 'requirement-extraction', { heartbeat: false, severity: 'warning' })
  wireJobObservability(documentAnalysisWorker, 'document-analysis', { heartbeat: false, severity: 'warning' })
  wireJobObservability(recalibrationWorker, 'recalibration')
  wireJobObservability(deadlineNotificationWorker, 'deadline-notifications')
  wireJobObservability(portfolioScoringWorker, 'portfolio-scoring')
  wireJobObservability(watchlistDigestWorker, 'watchlist-digest')
  wireJobObservability(stripeRotationReminderWorker, 'stripe-rotation-reminder')
  wireJobObservability(marketIntelligenceRefreshWorker, 'market-intel-refresh')
  wireJobObservability(subcontractMaintenanceWorker, 'subcontract-maintenance')
  wireJobObservability(opportunitySyncWorker, 'opportunity-sync')
  wireJobObservability(opportunityExpiryWorker, 'opportunity-expiry')
  // §7.0 — the agent runtime's tick job runs every minute, so staleness here is
  // a real signal that scheduling and the outbox have stopped.
  wireJobObservability(agentWorker, 'agent-runtime')
  if (winnersIntelRefreshWorker) wireJobObservability(winnersIntelRefreshWorker, 'winners-intel-refresh')
  if (clientMatchNotificationWorker) wireJobObservability(clientMatchNotificationWorker, 'client-match-notifications')
  const opsWatchdogWorker = startOpsWatchdogWorker()

  // Load most-recent isotonic calibration curve into in-process cache.
  // No-op when no v2-permutation run exists yet. Fire-and-forget; the
  // engine reads from the cache (which is empty → no calibration) until
  // this completes.
  const { refreshCalibrationCache } = await import('./services/calibrationCache')
  refreshCalibrationCache().catch((err) => {
    logger.warn('Initial calibration cache load failed (non-fatal)', { error: err?.message })
  })

  // -------------------------------------------------------------
  // Start HTTP Server
  // -------------------------------------------------------------
  const server = app.listen(config.port, () => {
    logger.info('Bytescon Platform running - Bytescon Engine Active', {
      port: config.port,
      environment: config.env,
      pid: process.pid,
      tagline: 'Built on the FAR. Scored on capability. Won on discipline.',
    })
  })

  // -------------------------------------------------------------
  // Graceful Shutdown
  // -------------------------------------------------------------
  const shutdown = async (signal: string) => {
    logger.info(`${signal} received. Shutting down gracefully...`)

    server.close(async () => {
      logger.info('HTTP server closed')

      await scoringWorker.close()
      await enrichmentWorker.close()
      await recalibrationWorker.close()
      await deadlineNotificationWorker.close()
      await portfolioScoringWorker.close()
      await watchlistDigestWorker.close()
      await section6Worker.close()
      await agentWorker.close()
      await stripeRotationReminderWorker.close()
      await marketIntelligenceRefreshWorker.close()
      await requirementExtractionWorker.close()
      await clientMatchNotificationWorker.close()
      await documentAnalysisWorker.close()
      await subcontractMaintenanceWorker.close()
      await opportunitySyncWorker.close()
      await opportunityExpiryWorker.close()
      await opsWatchdogWorker.close()
      await gb107.close()
      // winnersIntelRefreshWorker is null when the feature flag is off.
      if (winnersIntelRefreshWorker) {
        await winnersIntelRefreshWorker.close()
      }
      logger.info('Workers stopped')

      await disconnectDatabase()
      await disconnectRedis()

      logger.info('Shutdown complete')
      process.exit(0)
    })

    setTimeout(() => {
      logger.error('Forced shutdown after timeout')
      process.exit(1)
    }, 15000)
  }

  process.on('SIGTERM', () => shutdown('SIGTERM'))
  process.on('SIGINT', () => shutdown('SIGINT'))

  process.on('unhandledRejection', (reason) => {
    logger.error('Unhandled promise rejection', { reason })
    void sendOpsAlert({
      key: 'unhandled-rejection',
      severity: 'warning',
      title: 'Unhandled promise rejection in backend',
      detail: reason instanceof Error ? `${reason.message}\n${reason.stack ?? ''}` : String(reason),
    })
  })

  process.on('uncaughtException', (err) => {
    logger.error('Uncaught exception', {
      error: err.message,
      stack: err.stack,
    })
    // Page before dying, but never hang the crash: hard-exit after 4s
    // even if alert delivery stalls.
    const exit = () => process.exit(1)
    setTimeout(exit, 4000).unref()
    void sendOpsAlert({
      key: 'uncaught-exception',
      severity: 'critical',
      title: 'Backend crashed: uncaught exception',
      detail: `${err.message}\n${err.stack ?? ''}`,
    }).then(exit, exit)
  })
}

bootstrap().catch((err) => {
  try {
    logger.error('Bootstrap failed', { error: err?.message, stack: err?.stack })
  } catch {
    // Fall back to stderr only if Winston itself failed during bootstrap
    process.stderr.write(`Bootstrap failed: ${err?.message ?? err}\n`)
  }
  process.exit(1)
})
