// =============================================================
// Test client — boots a test Express app instance with the same
// middleware stack as production, plus DB seeding helpers.
//
// Per engineering.md Rule 6 (deterministic): each test gets a
// freshly-seeded firm + admin + JWT. Tests are isolated by ID.
// Per engineering.md Rule 4: cleanup runs in afterAll to prevent
// test pollution leaking into next run.
// =============================================================

import express, { Express } from 'express'
import helmet from 'helmet'
import cors from 'cors'
import jwt from 'jsonwebtoken'
import { prisma } from '../config/database'
import { config } from '../config/config'
import type { UserRole } from '../types'
import { errorHandler, notFoundHandler } from '../middleware/errorHandler'

// Route imports — same as server.ts (no workers, no shutdown handlers)
import authRoutes from '../routes/auth'
import opportunityRoutes from '../routes/opportunities'
import clientRoutes from '../routes/clients'
import firmRoutes from '../routes/firm'
import brandingRoutes from '../routes/branding'
import billingRoutes from '../routes/billing'
import clientDeliverablesRoutes from '../routes/clientDeliverables'
import clientPortalRoutes from '../routes/clientPortal'
import complianceMatrixRoutes from '../routes/complianceMatrix'
import stripeWebhookRoutes from '../routes/stripeWebhook'
import opsHeartbeatRoutes from '../routes/opsHeartbeat'
import betaRoutes from '../routes/beta'
import submissionRoutes from '../routes/submissions'
import healthAdminRoutes from '../routes/health'
import teamingRoutes from '../routes/teaming'
import crmRoutes from '../routes/crm'
import erpRoutes from '../routes/erp'
import personnelRoutes from '../routes/personnel'
import knowledgeRoutes from '../routes/knowledge'
import mcpRoutes from '../routes/mcp'
import publicApiV1Routes from '../routes/publicApi/v1'
import integrationRoutes, { callbackRouter as integrationCallbackRouter } from '../routes/integrations'
import integrationWebhookRoutes from '../routes/integrationWebhooks'
import esignRoutes from '../routes/esign'
import rbacRoutes from '../routes/rbac'
import ssoRoutes, { ssoPublicRouter } from '../routes/sso'
import partnerPortalRoutes from '../routes/partnerPortal'
import proposalAssistRoutes from '../routes/proposalAssist'
import proposalRoutes from '../routes/proposal'
import pricingRoutes from '../routes/pricing'
import submissionWorkspaceRoutes from '../routes/submissionWorkspace'
import pastPerformanceLibraryRoutes from '../routes/pastPerformanceLibrary'
import analyticsRoutes from '../routes/analytics'
import decisionRoutes from '../routes/decision'
import pursuitRoutes from '../routes/pursuits'
import registrationRoutes from '../routes/registration'
import contractManagementRoutes from '../routes/contractManagement'
import contractFinanceRoutes from '../routes/contractFinance'
import qualificationRoutes from '../routes/qualification'
import gateReviewRoutes from '../routes/gateReviews'
import notificationRoutes from '../routes/notifications'
import monitoringProfileRoutes from '../routes/monitoringProfiles'
import captureEvidenceRoutes from '../routes/captureEvidence'
// §6 — the four-pillar enhancement APIs, mounted exactly as in server.ts.
import discoveryRoutes from '../routes/discovery'
import scoringIntelRoutes from '../routes/scoringIntel'
import requirementsIntelRoutes from '../routes/requirementsIntel'
import milestoneRoutes from '../routes/milestones'
import agentRoutes from '../routes/agents'
import contractHealthRoutes from '../routes/contractHealth'
import opportunityAgentRoutes from '../routes/opportunityAgent'
import complianceAgentRoutes from '../routes/complianceAgent'
import qualificationAgentRoutes from '../routes/qualificationAgent'
import teamingAgentRoutes from '../routes/teamingAgent'
import pricingAgentRoutes from '../routes/pricingAgent'
import proposalAgentRoutes from '../routes/proposalAgent'
import financeAgentRoutes from '../routes/financeAgent'
import intelligenceAgentRoutes from '../routes/intelligenceAgent'
import { metricsMiddleware, metricsHandler } from '../config/observability'

export function buildTestApp(): Express {
  const app = express()
  app.set('trust proxy', 1)

  app.use(helmet({ contentSecurityPolicy: false, hsts: false }))
  app.use(cors({ origin: true, credentials: true }))

  // Webhook needs raw body BEFORE express.json
  app.use('/api/webhooks', stripeWebhookRoutes)
  // §8.5 — provider webhooks need the RAW body for signature verification, so
  // they mount here, beside the Stripe webhook and before express.json().
  app.use('/api/webhooks/integrations', integrationWebhookRoutes)

  // Ops heartbeat — token-authed, mounted on app like production server.ts
  app.use('/api/ops', opsHeartbeatRoutes)

  app.use(express.json({ limit: '10mb' }))

  // Observability — same as production server (mounted under /api/
  // so reverse-proxy routing works in prod)
  app.use(metricsMiddleware)
  app.get('/api/metrics', metricsHandler)

  app.get('/health', (_req, res) => res.json({ status: 'healthy' }))

  const apiRouter = express.Router()
  apiRouter.use('/auth', authRoutes)
  apiRouter.use('/opportunities', opportunityRoutes)
  apiRouter.use('/clients', clientRoutes)
  apiRouter.use('/crm', crmRoutes)
  apiRouter.use('/erp', erpRoutes)
  apiRouter.use('/personnel', personnelRoutes)
  apiRouter.use('/knowledge', knowledgeRoutes)
  apiRouter.use('/admin/mcp', mcpRoutes)
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
  apiRouter.use('/firm', firmRoutes)
  apiRouter.use('/branding', brandingRoutes)
  apiRouter.use('/billing', billingRoutes)
  apiRouter.use('/client-deliverables', clientDeliverablesRoutes)
  apiRouter.use('/client-portal', clientPortalRoutes)
  apiRouter.use('/compliance-matrix', complianceMatrixRoutes)
  apiRouter.use('/beta', betaRoutes)
  apiRouter.use('/submissions', submissionRoutes)
  apiRouter.use('/health', healthAdminRoutes)
  apiRouter.use('/teaming', teamingRoutes)
  apiRouter.use('/proposal-assist', proposalAssistRoutes)
  apiRouter.use('/proposal', proposalRoutes)
  apiRouter.use('/pricing', pricingRoutes)
  apiRouter.use('/submission', submissionWorkspaceRoutes)
  apiRouter.use('/past-performance-library', pastPerformanceLibraryRoutes)
  apiRouter.use('/analytics', analyticsRoutes)
  apiRouter.use('/decision', decisionRoutes)
  apiRouter.use('/pursuits', pursuitRoutes)
  apiRouter.use('/registration', registrationRoutes)
  apiRouter.use('/contract-management', contractManagementRoutes)
  apiRouter.use('/contract-finance', contractFinanceRoutes)
  apiRouter.use('/qualification', qualificationRoutes)
  apiRouter.use('/gate-reviews', gateReviewRoutes)
  apiRouter.use('/notifications', notificationRoutes)
  apiRouter.use('/monitoring-profiles', monitoringProfileRoutes)
  apiRouter.use('/capture-evidence', captureEvidenceRoutes)
  apiRouter.use('/discovery', discoveryRoutes)
  apiRouter.use('/scoring-intel', scoringIntelRoutes)
  apiRouter.use('/requirements-intel', requirementsIntelRoutes)
  apiRouter.use('/milestones', milestoneRoutes)
  // Mounted before the generic /agents router so its own paths win, exactly as
  // in server.ts.
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
  app.use('/api', apiRouter)

  app.use(notFoundHandler)
  app.use(errorHandler)

  return app
}

// -------------------------------------------------------------
// Test fixture helpers
// -------------------------------------------------------------

export interface TestFirm {
  id: string
  name: string
  contactEmail: string
}

export interface TestUser {
  id: string
  email: string
  role: UserRole
  consultingFirmId: string
  token: string
}

let counter = 0
function uniq(prefix: string): string {
  counter += 1
  // pid disambiguates parallel vitest workers (each resets `counter` to 0);
  // the random suffix guards same-millisecond collisions within a worker.
  return `${prefix}-${Date.now()}-${process.pid}-${counter}-${Math.random().toString(36).slice(2, 8)}`
}

// Plan rows the test firms subscribe to. Values mirror billingService
// DEFAULT_PLANS; update: {} so a seeded row is never clobbered. Concurrent
// vitest workers can race the first create — P2002 means another worker won,
// so re-read.
async function ensureTestPlan(slug: 'base' | 'all_access') {
  const defaults =
    slug === 'base'
      ? { name: 'Bytescon Core', monthlyPriceUsd: 99, annualPriceUsd: 84, maxUsers: 3, maxClients: 5, aiCallsPerMonth: 500 }
      : { name: 'All Access', monthlyPriceUsd: 199, annualPriceUsd: 169, maxUsers: 10, maxClients: -1, aiCallsPerMonth: -1 }
  try {
    return await prisma.subscriptionPlan.upsert({
      where: { slug },
      update: {},
      create: { slug, features: [], sortOrder: slug === 'base' ? 1 : 2, ...defaults },
    })
  } catch {
    const plan = await prisma.subscriptionPlan.findUnique({ where: { slug } })
    if (!plan) throw new Error(`Test plan '${slug}' could not be created or found`)
    return plan
  }
}

export async function createTestFirm(
  overrides: Partial<TestFirm> & {
    /**
     * Entitlement level for the firm. Route gating (requireActiveBase /
     * requireAddon) needs an ACTIVE subscription, so the default is an
     * all_access sub — feature tests hit module routes without per-test
     * billing setup. Pass 'base' to exercise module gates, 'none' for the
     * locked floor.
     */
    plan?: 'all_access' | 'base' | 'none'
  } = {},
): Promise<TestFirm> {
  const id = overrides.id ?? uniq('test-firm')
  const firm = await prisma.consultingFirm.create({
    data: {
      id,
      name: overrides.name ?? `Test Firm ${id}`,
      contactEmail: overrides.contactEmail ?? `${id}@test.local`,
      isActive: true,
    },
  })
  const planSlug = overrides.plan ?? 'all_access'
  if (planSlug !== 'none') {
    const plan = await ensureTestPlan(planSlug)
    const now = new Date()
    await prisma.subscription.create({
      data: {
        consultingFirmId: firm.id,
        planId: plan.id,
        status: 'ACTIVE',
        billingCycle: 'MONTHLY',
        currentPeriodStart: now,
        currentPeriodEnd: new Date(now.getTime() + 30 * 24 * 60 * 60 * 1000),
      },
    })
  }
  return { id: firm.id, name: firm.name, contactEmail: firm.contactEmail }
}

export async function createTestUser(
  consultingFirmId: string,
  overrides: { role?: UserRole; email?: string; extraPermissions?: string[] } = {}
): Promise<TestUser> {
  const email = overrides.email ?? `${uniq('test-user')}@test.local`
  const user = await prisma.user.create({
    data: {
      consultingFirmId,
      email,
      passwordHash: '$2b$10$dummytestpasswordhash',
      firstName: 'Test',
      lastName: 'User',
      role: overrides.role ?? 'ADMIN',
      extraPermissions: overrides.extraPermissions ?? [],
      isActive: true,
    },
  })
  const token = jwt.sign(
    {
      userId: user.id,
      consultingFirmId,
      email: user.email,
      role: user.role,
    },
    config.jwt.secret,
    { expiresIn: '1h' }
  )
  return {
    id: user.id,
    email: user.email,
    role: user.role as UserRole,
    consultingFirmId,
    token,
  }
}

export async function cleanupFirm(firmId: string): Promise<void> {
  // Cascade deletes everything via Prisma onDelete: Cascade on firm relations
  await prisma.consultingFirm.delete({ where: { id: firmId } }).catch(() => {})
}

export async function disconnectDb(): Promise<void> {
  await prisma.$disconnect()
}
