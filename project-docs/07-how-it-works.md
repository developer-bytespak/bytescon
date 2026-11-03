# How It Works (Architecture)

## Simple version

1. You open the **website** in your browser.
2. The website asks the **server** for information.
3. The server checks **who you are** and **which firm you belong to**, then reads or writes the **database**.
4. Slow jobs (like downloading thousands of government notices) are put in a **waiting line** and done by **background workers**.
5. When AI is needed, the server asks **Claude** (or a backup AI).
6. The **9 robot agents** wake up on a timer or when something happens, look at the data, and leave notes and warnings for people.

---

## Big picture

```
                    ┌──────────────────────────────┐
  Browser / phone ─▶│  Frontend (React SPA)        │  Vercel or nginx
                    └──────────────┬───────────────┘
                                   │ HTTPS  /api/*
                    ┌──────────────▼───────────────┐
  Client portal ───▶│  Backend API (Express)       │  Render web service
  Partner portal ──▶│  auth → tenant → RBAC →      │
  Public API v1 ───▶│  add-on gate → route → audit │
                    └───┬──────────┬───────────┬───┘
                        │          │           │
              ┌─────────▼──┐  ┌────▼─────┐  ┌──▼──────────────┐
              │ PostgreSQL │  │  Redis   │  │ External APIs   │
              │  (Neon)    │  │ (BullMQ, │  │ SAM.gov, USA-   │
              │ 215 tables │  │  cache)  │  │ spending, Stripe│
              └─────▲──────┘  └────┬─────┘  │ SendGrid, Claude│
                    │              │        └─────────────────┘
              ┌─────┴──────────────▼─────┐
              │ Background workers (~20) │  Render worker
              │ + Agent runtime (9 agents)│
              └──────────────────────────┘

  Claude / ChatGPT ──▶ MCP gateway (port 3002) ──▶ same PostgreSQL (read-mostly)
```

## What happens on every API request

1. **Helmet / CORS / rate limit** — basic web protection.
2. **Authenticate** — check the JWT (or client/partner/API token) and the revocation cut-off, then re-read the account: it must still be active, and its **current** role replaces the role in the token.
3. **Tenant scope** — attach the firm id; block CONSULTANT writes; block half-finished sign-ins.
4. **Permission check** — role-based (RBAC).
5. **Plan / add-on gate** — 402 if no active plan, 403 if the add-on isn't owned.
6. **Route handler** — validates input (Zod), uses Prisma.
7. **Audit** — every change to data writes an `AuditEvent`.

## Data model in one picture

```
ConsultingFirm (tenant)
 ├── Users (roles)            ├── Subscription / Add-ons / Tokens
 ├── ClientCompany ──┬── ClientPortalUsers
 │                   └── Document requirements, rewards, penalties
 ├── Opportunities ── Amendments, documents, matches, scores, decisions
 │     └── BidPursuit (pipeline) ── Scorecard, GateReview, CapturePlan
 │            ├── ComplianceMatrix ── Requirements
 │            ├── Proposal ── Sections, versions, reviews, attestation
 │            ├── PricingWorkspace ── Scenarios, labor, rates
 │            ├── ProposalSubmission ── checklist
 │            └── SubmissionRecord (WON / LOST …)
 ├── Contracts ── CLINs, options, mods, deliverables, budgets, POs,
 │                time entries, invoices, payments
 ├── Partners ── Teaming arrangements, PartnerPortalUsers
 ├── CRM ── agencies, contacts, activities, follow-ups
 ├── Libraries ── capabilities, past performance, personnel, standing docs
 └── Agents ── schedules, runs, artifacts, escalations, events
```

## Background jobs (main ones)

| Job | When (UTC) | Does what |
|-----|------------|-----------|
| agent-runtime tick | every minute | starts due agent runs, processes events |
| agent-runtime reaper | every 5 min | cleans up stuck runs |
| source-sync | hourly | pulls from all discovery sources |
| discovery-intel | every 6 h | forecasts, re-competes, matches |
| profile-alerts | every 15 min | saved-search alerts |
| milestone-reminders | hourly | deadline reminders, CRM follow-ups |
| opportunity-sync | 06:00 daily | SAM.gov ingest per firm |
| opportunity-expiry | 05:00 daily | expire past-deadline notices |
| nightly-recalibration | 02:00 daily | refresh caches, rescore |
| portfolio-scoring | 08:00 & 20:00 | portfolio decisions |
| deadline-notifications | 09:00 daily | reminder emails |
| subcontract-maintenance | 03:30 daily | contacts + cleanup |
| market-intel / winners-intel refresh | Sun 04:00 | USAspending → BigQuery / staging |
| watchlist-digest | Mon 13:00 | weekly email |
| client-match-notification | 13:30 daily | (flag) client match emails |
| stripe-webhook-rotation | 09:30 daily | remind to rotate secret |
| ops-watchdog | hourly | dead-man's switch |
| GB-107 enrichment | every 60 s + every 6 h | SAM description fetch |
| GB-106 freshness | 06:00 daily | flag stale onboarding data |
| scoring / enrichment / document-analysis / requirement-extraction | on demand | per-item work |

## AI calls

All AI calls go through **one router** (`generateWithRouter`):
pick provider (firm setting → platform default Claude) → pick cheap or premium model by task →
check cache → call → log tokens and cost → on failure, fall back (Claude ↔ LocalAI) → if all fail, alert admin.

## Agents

Event or timer → create run (idempotent) → queue → handler computes → saves **artifacts** (reports),
**escalations** (questions for humans), **proposed actions** → notifications. Details: [08-ai-agents.md](08-ai-agents.md).

## Portals and white-label

- Branding is looked up by hostname, so `acme.bytescon.com` or a verified custom domain shows the firm's logo and colours.
- Client and partner portals use their own token types and see only their own slice of data.

## Environments and settings

Settings come from environment variables. Groups (names only):
core (database, Redis, JWT, encryption key), federal data (SAM, USAspending), AI keys and models,
BigQuery, email (SendGrid), SMS (Twilio), Stripe, ops/alerts (Sentry, metrics, heartbeat), scoring flags,
integration client IDs, state portal logins. Templates: `backend/.env.example`, `backend/.env.prod.example`, `frontend/.env.example`.
