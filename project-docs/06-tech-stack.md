# Tech Stack

## Simple version

Think of Bytescon like a restaurant:

| Restaurant part | Bytescon part | Technology |
|-----------------|---------------|------------|
| 🍽️ Dining room (what customers see) | The website | **React** |
| 👨‍🍳 Kitchen (does the work) | The server | **Node.js + Express** |
| 🗄️ Pantry (stores everything) | The database | **PostgreSQL** |
| 📋 Order tickets waiting in line | The job queue | **Redis + BullMQ** |
| 🧠 Expert chef you call for hard dishes | AI | **Claude** (OpenAI / DeepSeek optional) |
| 💳 Cash register | Payments | **Stripe** |
| 📮 Mail carrier | Email / SMS | **SendGrid / Twilio** |
| 🏠 The building | Hosting | **Render, Vercel, Neon** |

Everything is written in one language: **TypeScript** (JavaScript with safety checks).

---

## Backend (`backend/`)

| Purpose | Technology |
|---------|------------|
| Runtime | Node.js 20 |
| Language | TypeScript 5 |
| Web framework | Express 4 |
| Database ORM | Prisma 5 |
| Database | PostgreSQL 16 |
| Queue / cache | Redis 7, BullMQ 4, ioredis |
| Validation | Zod |
| Auth | jsonwebtoken, bcryptjs, otpauth (MFA) |
| Security | helmet, cors, express-rate-limit, sanitize-html |
| Files | multer (uploads), pdf-parse, mammoth (Word), adm-zip, xlsx |
| PDFs | pdfkit |
| Scheduling | cron-parser (agent schedules), BullMQ repeatable jobs |
| Payments | stripe |
| Email | SendGrid v3 (via `mailer.ts`); nodemailer present |
| SMS | twilio |
| Analytics data | @google-cloud/bigquery (optional) |
| AI SDK | openai (for OpenAI); Claude called via HTTP `fetch` |
| Observability | winston, morgan, @sentry/node, prom-client |
| Tests | Vitest, Supertest |

## Frontend (`frontend/`)

| Purpose | Technology |
|---------|------------|
| UI library | React 18 |
| Build tool | Vite 5 |
| Routing | react-router-dom 6 |
| Server data | @tanstack/react-query 5, axios |
| Styling | Tailwind CSS 3.4 (own component kit, no 3rd-party UI library) |
| Charts | Recharts |
| Icons | lucide-react |
| Animation | framer-motion, lenis (landing page) |
| Dates | date-fns |
| Errors / analytics | @sentry/react, posthog-js |
| Tests | Vitest, jsdom, Testing Library |
| Lint | ESLint with react, hooks, jsx-a11y |
| Mobile | PWA manifest + service worker (app shell only) |

## MCP servers (`mcp/`)

| Purpose | Technology |
|---------|------------|
| Protocol | Model Context Protocol (stdio + Streamable HTTP) |
| Servers | opportunity-mcp, knowledge-mcp, proposal-mcp, bytescon-core-mcp |
| Gateway | Express HTTP gateway (port 3002) |
| Auth | Bearer API tokens + embedded OAuth 2.1 (PKCE, dynamic client registration) |
| Data | Shares the backend's Prisma client via `@bytescon/mcp-shared` |

## AI models (defaults)

| Use | Default model | Notes |
|-----|---------------|-------|
| Cheap tasks (document analysis, extraction, compliance matrix) | `claude-haiku-4-5` | OpenAI alt: `gpt-5-mini` |
| Premium tasks (drafting, guidance, assistant) | `claude-sonnet-4-6` | OpenAI alt: `gpt-5` |
| Other providers | DeepSeek, "Insight Engine" (DeepSeek), LocalAI/Ollama (`mistral:7b-instruct`) | Fallback chain |

Firms can bring their own AI keys; otherwise platform keys are used.

## External data sources

SAM.gov (Opportunities v2, Entity v3, description endpoint), USAspending, FPDS-NG ATOM, Grants.gov,
SBA SUBNet, USAC (E-Rate, Rural Health), state & city procurement portals, BigQuery (optional).

## Third-party integrations

QuickBooks Online, Unanet (stub), Deltek Costpoint (stub), Google Calendar, Microsoft 365 Calendar,
Slack, Microsoft Teams, DocuSign, Clay (optional contact enrichment).

## Infrastructure

| Piece | Where |
|-------|-------|
| API web service + background worker | Render |
| Redis | Render Key Value |
| PostgreSQL | Neon |
| Frontend | Vercel (SPA rewrite) — or Docker + nginx |
| Local development | `docker-compose.yml` (Postgres, Redis, backend, frontend) |
| CI | GitHub Actions (`.github/workflows/ci.yml`) |

No Infrastructure-as-Code (`render.yaml`, Terraform) is committed.
