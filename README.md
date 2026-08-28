# Bytescon

**Federal contracting intelligence platform** — multi-tenant SaaS for consulting firms that help small businesses find, qualify, win, and perform federal contracts.

## Stack

| Layer | Technology |
|---|---|
| Backend | Node.js 20, Express 4, TypeScript, Prisma, PostgreSQL 16 |
| Queue / cache | Redis 7 + BullMQ (~19 background workers) |
| Frontend | React 18 + Vite + TanStack Query + Tailwind |
| AI | Multi-provider LLM router (Claude default; OpenAI / DeepSeek optional) |
| Market analytics | Google BigQuery (optional — inert without `GCP_PROJECT_ID`) |
| Billing | Stripe (base plan + add-on modules + lifetime + token packs) |
| Email / SMS | Resend / Twilio |

**Production topology:** Render (API web service + background worker + Key Value Redis) · Vercel (frontend) · Neon (Postgres).

## Local development

Prereqs: Node 20+, Docker (for Postgres + Redis).

```bash
# 1. Infrastructure
docker compose up -d postgres redis

# 2. Backend
cd backend
cp .env.example .env          # set JWT_SECRET; SAM_API_KEY for live ingestion
npm ci
npx prisma migrate deploy     # single clean init migration — never use `db push` against shared DBs
npm run db:seed               # NAICS + FAR catalogs, legal docs, demo tenant
npm run dev                   # http://localhost:3001

# 3. Frontend (new terminal)
cd frontend
cp .env.example .env
npm install
npm run dev                   # http://localhost:3000
```

Dev seed login: `admin@bytescon.com` / `Admin1234!` (change immediately anywhere public).

## Tests

```bash
cd backend && npm test    # needs local Postgres (bytescon_platform_test) + Redis
cd frontend && npm test   # jsdom + mocks, no services needed
```

CI (GitHub Actions) runs backend typecheck + tests with Postgres/Redis service containers, frontend typecheck + tests + build, and a ratcheted ESLint pass.

## Migrations

The schema ships as **one squashed init migration** (`backend/prisma/migrations/00000000000000_init`). All schema changes from here forward:

```bash
cd backend
npx prisma migrate dev --name <change>   # local
npx prisma migrate deploy                # production (run with the DIRECT Neon endpoint, not the pooler)
```

Never use `prisma db push` against a shared database.

## Environment

- `backend/.env.example` — full annotated dev template
- `backend/.env.prod.example` — production template (Render/Neon/Stripe/Resend/LLM keys)
- `frontend/.env.example` / `.env.prod.example` — Vite build-time vars

## Notes

- The legal documents in `backend/prisma/seeds/legal/` are **placeholders** carried from the platform's origin — have counsel produce real Bytescon terms before launch.
- BigQuery market analytics requires a GCP project (`GCP_PROJECT_ID` + service-account key); everything else degrades gracefully without it.
- File uploads currently write to local disk (`uploads/`) — object storage (R2/S3) lands with Piece 3 of the build plan before production deploys.
