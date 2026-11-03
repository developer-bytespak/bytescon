# Bytescon — notes for AI coding agents

Federal contracting intelligence SaaS. Full docs: `project-docs/` (start with `project-docs/AGENTS.md`;
known gaps in `project-docs/10-status-done-and-remaining.md`). If docs and code disagree, the code wins.

## Layout
- `backend/` — Express + Prisma + BullMQ API and workers (Node 20)
- `frontend/` — React + Vite SPA (Node 24)
- `mcp/` — MCP servers + HTTP gateway
- `project-docs/` — documentation only; never imported by code

## Run locally
```bash
docker compose up -d postgres redis
cd backend && npx prisma migrate status   # apply with `npx prisma migrate deploy` if behind
cd backend && npm run dev                 # :3001
cd frontend && npm run dev                # :3000 — login admin@bytescon.com / Admin1234!
```
`backend/.env` cannot be `source`d in a shell; read values through dotenv.

## Test before committing
```bash
cd backend && npm test          # needs Postgres + Redis; ~4,300 tests
cd frontend && npm test         # must run on Node 24 (Node 26 breaks authToken.test.ts)
cd frontend && npm run lint     # max 241 warnings, 0 errors
npm run typecheck               # from repo root
```

## Rules
- **Tenant scope every query** by `consultingFirmId` (`backend/src/middleware/tenant.ts`).
- **Migrations:** `npx prisma migrate dev --name <change>`. Never `prisma db push` against a shared DB.
- **Agents never act alone:** keep `allowlistedActionKeys` empty; agents propose and escalate, humans decide.
- **No `TODO`/`FIXME`/`XXX`/`HACK`** in `backend/src/services/agents/**` — a test fails CI.
- **All LLM calls** go through `generateWithRouter` (`backend/src/services/llm/llmRouter.ts`).
- **Files:** read, write and delete uploads only through `backend/src/services/fileStorage.ts`
  (`restoreUpload`, `writeUpload`, `persistUpload`, `removeUpload`); never `fs` on `uploads/` directly —
  the local folder is a cache and production disks are wiped on restart.
- **Paywall** with `requireActiveBase` / `requireAddon(slug)`; permissions via `services/rbac/permissions.ts`.
- Never print secret values from `.env*` files.
- Match surrounding code: comment density, naming, error classes (`NotFoundError`, etc.).

## Git
- Solo developer (Kamran Khan); commits go straight to `main` after the checks above pass.
- Descriptive commit messages; split unrelated changes into separate commits.
- `CLAUDE.md` and `.claude/` (settings, skills) **are committed to GitHub** — commit changes to them like
  any other file. Never add them back to `.gitignore`; only `.claude/settings.local.json` stays local.
- Pushing to `main` auto-deploys the frontend to Vercel (https://bytescon.vercel.app).
  Backend runs on Render (https://bytescon-api.onrender.com).
- Vercel project `bytescon` (team `developers-projects-78f8d18c`, Root Directory `frontend`).
  If the Vercel CLI is linked (`vercel link` at the repo root; `.vercel/` is gitignored), use
  `vercel ls`, `vercel logs`, `vercel env ls`. Never change or remove env vars without asking.
- Render services `bytescon-api` (rootDir `backend`, runs migrations at boot), `bytescon-mcp`,
  `bytescon-redis`; all auto-deploy from `main`. If the Render CLI is logged in, use `render services`,
  `render deploys list <srv-id>`, `render logs --resources <srv-id>`. Read-only unless asked.
- Machine-specific setup (CLI logins, local paths, shell config) never goes in committed files.
