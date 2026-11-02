# Codebase Map — Where Things Live

**Simple version:** This is the "map of the building" for developers and AI coding tools. It says which folder holds which feature.

All paths are relative to the repository root.

## Top level

| Path | What it is |
|------|------------|
| `backend/` | API server and background workers (Express, Prisma, BullMQ) |
| `frontend/` | Website (React + Vite) |
| `mcp/` | MCP servers and HTTP gateway for AI assistants |
| `project-docs/` | This documentation (not used by code) |
| `docker-compose.yml` | Local Postgres, Redis, backend, frontend |
| `.github/workflows/ci.yml` | CI: backend, frontend, lint, mcp jobs |
| `package.json` | Convenience scripts (`dev:backend`, `typecheck`, …) |

## Backend (`backend/`)

| Path | What it holds |
|------|---------------|
| `src/server.ts` | App setup, middleware order, route mounting, worker start-up, shutdown |
| `src/config/` | Env config, add-on catalog (`addons.ts`), observability, BigQuery |
| `src/middleware/` | `auth`, `tenant`, `permissions`, `addonGate`, `tierGate`, `upload`, `auditMiddleware`, `platformAdmin` |
| `src/routes/` | ~60 REST modules (one per feature area); tests sit beside them |
| `src/routes/publicApi/v1.ts` | Public REST API v1 |
| `src/services/` | Business logic (one file or folder per domain) |
| `src/services/agents/` | Agent runtime + one folder per agent |
| `src/services/llm/` | LLM router, providers, model tiering, outage alerts |
| `src/services/discovery/` | Source adapters + sync orchestrator, forecasts, re-competes, matches |
| `src/services/scoring/`, `src/engines/` | Win probability, calibration, decision layers, penalties |
| `src/services/whoWins/`, `winnersIntel/`, `backtest/` | Public-award models and backtesting |
| `src/services/rbac/` | Roles and permissions |
| `src/services/integrations/` | QuickBooks, calendars, Slack/Teams, DocuSign |
| `src/services/crm/`, `erp/`, `scw/`, `partnerPortal/`, `knowledge/`, `sso/` | Feature domains |
| `src/workers/` | BullMQ workers |
| `src/gb106/`, `src/gb107/` | Drop-in modules: platform onboarding; SAM description enrichment |
| `src/audit/` | Section 8 acceptance/audit tests |
| `prisma/schema.prisma` | Database schema |
| `prisma/migrations/` | Migrations |
| `prisma/seeds/` | NAICS, FAR/DFARS, legal docs, demo tenant |
| `.env.example`, `.env.prod.example` | Env variable templates |

## Feature → backend route → frontend page

| Feature | Backend route file | Frontend page(s) |
|---------|--------------------|------------------|
| Sign-in, MFA, agreements | `routes/auth.ts`, `sso.ts` | `Login`, `MfaChallenge`, `AcceptAgreements` |
| Firm settings, users | `routes/firm.ts`, `rbac.ts` | `Settings`, `Integrations` |
| Billing | `routes/billing.ts`, `addons.ts`, `stripeWebhook.ts` | `Billing` |
| Clients | `routes/clients.ts` | `Clients`, `ClientDetail` |
| Opportunities | `routes/opportunities.ts` | `Opportunities`, `OpportunityDetail` |
| Discovery | `routes/discovery.ts`, `monitoringProfiles.ts` | `Discovery` |
| Scoring | `routes/scoringIntel.ts`, `decision.ts`, `captureEvidence.ts` | `Decisions`, `Portfolio` |
| Pipeline | `routes/pursuits.ts`, `qualification.ts`, `gateReviews.ts` | `Pipeline`, `Qualification` |
| Compliance | `routes/complianceMatrix.ts`, `requirementsIntel.ts`, `farClauses.ts`, `registration.ts` | `OpportunityDetail`, `Registration`, `DocumentLibrary` |
| Proposal | `routes/proposal.ts`, `proposalAssist.ts`, `templates.ts` | `ProposalWorkspace`, `Templates` |
| Pricing | `routes/pricing.ts` | `PricingWorkspace` |
| Submission | `routes/submissionWorkspace.ts`, `submissions.ts` | `SubmissionWorkspace`, `Submissions` |
| Libraries | `routes/pastPerformanceLibrary.ts`, `personnel.ts`, `knowledge.ts` | `PastPerformanceLibrary`, `CapabilityLibrary`, `Knowledge` |
| Teaming | `routes/teaming.ts`, `subcontracting*.ts`, `scw.ts` | `Teaming`, `SubcontractingPage`, `PrimeContactsPage` |
| Partner portal | `routes/partnerPortal.ts` | `partner/*`, `PartnerSubmissions` |
| Client portal | `routes/clientPortal.ts`, `clientDeliverables.ts`, `clientDocuments.ts` | `ClientPortalLogin`, `ClientPortalDashboard` |
| Contracts | `routes/contractManagement.ts`, `contractHealth.ts`, `erp.ts` | `Contracts`, `ContractDetail` |
| Finance | `routes/contractFinance.ts` | `Timekeeping`, `Receivables`, `IndirectRates`, `AuditReadiness` |
| CRM | `routes/crm.ts` | `Crm` |
| E-sign | `routes/esign.ts` | `Signatures` |
| Analytics | `routes/analytics.ts`, `marketAnalytics.ts`, `agency.ts`, `setAside.ts`, `recipient.ts` | `Analytics`, `AgencyView`, `SetAsideIntelligence`, `RecipientProfile` |
| State / grants / civilian | `routes/stateMunicipal.ts`, `grants.ts` | `StateMunicipalPage`, `GrantsPage`, `CivilianProgramsPage`, `CommercialOpportunitiesPage` |
| Agents | `routes/agents.ts` + `*Agent.ts` | `Agents`, `AgentRunDetail`, `components/section7/*` |
| MCP tokens | `routes/mcp.ts` | `Settings` (MCP tokens), `ConnectClaudeWizard` |
| Admin | `routes/backtest.ts`, `firm.ts` (platform) | `AdminBacktest`, `PlatformCogs`, `PlatformMetrics`, `TemplateModeration`, `ComplianceLogs` |

## Frontend (`frontend/`)

| Path | What it holds |
|------|---------------|
| `src/App.tsx` | All routes |
| `src/navigation.ts` | Sidebar, hubs, command palette (single source) |
| `src/pages/` | ~90 pages |
| `src/components/` | Shared UI; `section6/` intel panels; `section7/` agent panels; `contracts/`, `erp/`, `crm/`, `scw/`, `landing/`, `charts/` |
| `src/services/` | API clients |
| `src/hooks/` | `useAuth`, `useCanModerate`, … |
| `src/gb106/` | Platform onboarding UI |
| `public/` | PWA manifest, service worker, AI connection guides |
| `vercel.json`, `Dockerfile.prod`, `nginx.conf` | Deployment |

## MCP (`mcp/`)

| Path | What it holds |
|------|---------------|
| `shared/` | Auth, tiers, audit, sanitising, OAuth 2.1 server, bootstrap |
| `opportunity-mcp/` | 14 tools (search, detail, pipeline, forecasts…) |
| `knowledge-mcp/` | 4 tools (FAR/DFARS clauses, agency patterns) |
| `proposal-mcp/` | 5 tools (compliance matrix, guidance, pricing template) |
| `bytescon-core-mcp/` | 4 PRO-tier tools (deliverables, billing, usage, users) |
| `gateway/` | One HTTP server mounting all of them (`/mcp`, `/knowledge/mcp`, `/proposal/mcp`, `/core/mcp`, `/all/mcp`) |
| `registry.json` | Server registry (contains a stale carrier-mcp entry) |

## Common commands

```bash
docker compose up -d postgres redis
cd backend && npm ci && npx prisma migrate deploy && npm run db:seed && npm run dev   # :3001
cd frontend && npm install && npm run dev                                             # :3000
cd backend && npm test
cd frontend && npm test
npm run typecheck        # from repo root
```
