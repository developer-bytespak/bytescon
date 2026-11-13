# AGENTS.md — Guide for AI coding tools

This file is written for AI agents and coding assistants (Claude Code, OpenAI Codex, OpenCode,
Google Antigravity, Cursor, Aider, Copilot, etc.). It is plain Markdown with no tool-specific syntax.

## Scope of this folder

- `project-docs/` is **documentation only**. It is not referenced by any build, test, lint, or deploy step.
- Do **not** move these files into `backend/`, `frontend/`, or `mcp/`, and do not import them from code.
- This file is intentionally **not** at the repository root, so it does not change how tools behave
  in the main codebase. If the team later wants tools to auto-load it, copy (don't move) it to the root as
  `AGENTS.md` / `CLAUDE.md`.

## Facts an agent should know before touching code

| Topic | Fact |
|-------|------|
| Repo layout | `backend/` (Express + Prisma API and workers), `frontend/` (React + Vite SPA), `mcp/` (Model Context Protocol servers + gateway), `project-docs/` (this) |
| Language | TypeScript in all three code packages |
| Node | Backend Node 20; frontend CI uses Node 24 |
| Database | PostgreSQL 16 via Prisma 5. Schema: `backend/prisma/schema.prisma` (~215 models, ~131 enums) |
| Migrations | One squashed init migration + small follow-ups. Use `npx prisma migrate dev --name <x>`. **Never `prisma db push` against a shared DB.** (CI uses `db push` against a throwaway DB only.) |
| Queue | Redis 7 + BullMQ. Workers in `backend/src/workers/`, started from `backend/src/server.ts` |
| Tenancy | Tenant = `ConsultingFirm`. Every query must be scoped by `consultingFirmId` (`backend/src/middleware/tenant.ts`) |
| Auth | JWT for firm users; separate token classes for client-portal users and partner-portal users; optional MFA (TOTP) and SSO (OIDC) |
| Roles | ADMIN, CONSULTANT (read-only), BD_CAPTURE, PROPOSAL, CONTRACTS, FINANCE, VIEWER — see `backend/src/services/rbac/permissions.ts` |
| Paywall | `requireActiveBase` (402) and `requireAddon(slug)` (403) in `backend/src/middleware/addonGate.ts` |
| LLM | All model calls go through `generateWithRouter` in `backend/src/services/llm/llmRouter.ts`. Default provider Claude |
| Agents | Registry in `backend/src/services/agents/registry.ts`. Agents never take business actions on their own (allowlists are empty) |
| Tests | `cd backend && npm test` (needs Postgres + Redis); `cd frontend && npm test` (jsdom) |
| Lint rule | Agent directories must not contain `TODO`/`FIXME`/`XXX`/`HACK` — a test fails CI (`section7Acceptance.audit.test.ts`) |
| Secrets | Never print values from `.env*` files. Only variable names appear in these docs |

## Where to look

- Feature → code map: [12-codebase-map.md](12-codebase-map.md)
- Detailed as-built specs (read before changing scoring, agents, subcontracting or Winners Intel):
  [specs/README.md](specs/README.md). The original spec files cited in code comments (`PROMPT.md`,
  `FIXES.md`, …) do not exist; these replace them.
- Architecture: [07-how-it-works.md](07-how-it-works.md)
- Requirements: [04-functional-requirements.md](04-functional-requirements.md), [05-non-functional-requirements.md](05-non-functional-requirements.md)
- Known gaps and risks: [10-status-done-and-remaining.md](10-status-done-and-remaining.md)
- Account types (consulting firm vs contractor; use `useIsContractor()` and `requireConsultingAccount` for anything client-related): [31-account-types.md](31-account-types.md)
- Complete-profile gate (scoring, decisions, AI and proposals need a complete profile; gate new such routes with `requireProfileReady`): [32-profile-completion.md](32-profile-completion.md)
- Status and next step (a new action on an opportunity should call `useNextStep` after it succeeds; journey rules in `services/opportunityJourney.ts`): [34-next-step-guidance.md](34-next-step-guidance.md)
- SAM.gov notice details, the description fetch on open, and solicitation documents imported from SAM.gov (no extra API calls for contacts/place/links; attachments only on proposal start or on request): [35-sam-notice-details.md](35-sam-notice-details.md)
- Qualification (scorecards are per client — pass `clientCompanyId`; suggested scores; no-bid reasons; the To qualify queue): [33-qualification-flow.md](33-qualification-flow.md)
- Vocabulary: [11-glossary.md](11-glossary.md)

## Keeping these docs accurate

When you change behaviour that a doc here describes, update the matching file in the same change, and
bump the "Snapshot date" in [README.md](README.md). If the code and these docs disagree, **the code wins**.
