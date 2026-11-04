---
name: verify-and-ship
description: Verify Bytescon changes (type-check, backend + frontend tests, lint), commit them in logical parts on a task branch, open a pull request, merge on the owner's approval, then confirm CI and the Vercel/Render deploys. Use when asked to commit, push, ship, or "check everything before committing".
---

# Verify and ship

Run from the repository root. Stop and report at the first real failure — never commit red.

## 1. Review what changed
- `git status --short` and `git diff --stat`. Read the full diff of every file you are about to commit.
- Group changes into logical commits (e.g. code fix + its tests in one; docs in another; tooling in another).
- Never stage secrets: `.env`, `.env.local`, `.vercel/`, `.claude/settings.local.json`, anything with real keys.
- `CLAUDE.md` and `.claude/` (settings, skills) ARE committed. Before committing them, check they contain no
  machine-specific content: no home-directory or session temp paths, no "logged in on this machine" statements.

## 2. Static checks
```bash
(cd backend && npx tsc --noEmit)
(cd frontend && npx tsc --noEmit)
(cd frontend && npm run lint)        # 0 errors; warnings must stay at or under the --max-warnings cap
```
Skip a side only when nothing under it changed.

## 3. Backend tests (needs Postgres + Redis)
- Ensure Docker is running (`docker info`), then `docker compose up -d postgres redis`.
- Check the test database is migrated: load `DATABASE_URL` from `backend/.env.test` (via dotenv, not `source`)
  and run `npx prisma migrate status`; apply with `npx prisma migrate deploy` only on the local test DB.
- Run `cd backend && npm test`. Use a long timeout (the suite takes several minutes).
- A single failure in a test that passes when re-run alone and is unrelated to the diff may be flaky: re-run that
  file alone, then the full suite once more. Report it either way; never hide a failure.

## 4. Frontend tests (Node 24)
- Run on Node 24, matching CI. With fnm: `cd frontend && fnm exec --using=24 npm test`.
  Without fnm: `cd frontend && npx -y node@24 node_modules/vitest/vitest.mjs run`.
- Node 26+ breaks `src/lib/authToken.test.ts` (built-in `localStorage` shadows jsdom) — that is an environment
  problem, not a code failure.

## 5. Commit and push
- One commit per logical group, descriptive subject line, body explaining what and why.
- Work on a task branch made from the latest `main`, never on `main` itself. Push it with `git push -u origin <branch>` and open a pull request (`gh pr create`) so CI runs.
- Merge to `main` only when the owner says so, because that deploys to production. Confirm the deploys only after a merge.
- Once the owner confirms staging is live, task branches merge into `staging` first, and `staging` merges into `main` on the owner's approval (see `CLAUDE.md`).

## 6. Confirm the deploy
- CI: `gh run list --limit 3` — wait for the run for the new commit and report success/failure
  (on failure: `gh run view <id> --log-failed`).
- Frontend: if the Vercel CLI is linked, `vercel ls bytescon` shows the new Production deploy as Ready.
- Backend: if the Render CLI is logged in, `render deploys list <bytescon-api srv-id>`; `bytescon-api` only
  redeploys when `backend/` changed. Then `curl -s https://bytescon-api.onrender.com/health` should report
  `"db":"ok"` (the first request may take ~1 min if the free-plan service was asleep).

## 7. Report
Summarise: checks run and results (with counts), commits (hash + subject), push state, CI result, deploy state,
and anything skipped or flaky.
