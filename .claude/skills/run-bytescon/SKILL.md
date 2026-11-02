---
name: run-bytescon
description: Start Bytescon locally (Docker Postgres + Redis, migrations check, backend :3001, frontend :3000) and confirm it is reachable. Use when asked to run, start, open or screenshot the app, or when localhost:3000 is not working.
---

# Run Bytescon locally

Run from the repository root. Each step is idempotent — skip what is already true.

1. **Already running?** `lsof -nP -iTCP:3000 -iTCP:3001 -sTCP:LISTEN`. If both listen and
   `curl -s localhost:3001/health` returns `"db":"ok"`, skip to step 6.

2. **Docker.** If `docker info` fails, run `open -a Docker` and wait (poll `docker info`, up to ~3 min)
   in a background command — never a foreground `sleep`.

3. **Database + Redis.** `docker compose up -d postgres redis`, then wait for
   `docker compose exec -T postgres pg_isready -U bytescon_user`.

4. **Migrations.** `backend/.env` cannot be `source`d (unquoted values with spaces), so load it via dotenv:
   ```bash
   cd backend
   DATABASE_URL=$(node -e "require('dotenv').config();process.stdout.write(process.env.DATABASE_URL)") npx prisma migrate status
   ```
   If migrations are pending, run the same with `npx prisma migrate deploy` (local dev DB only — never a
   shared or production database, never `db push`). If the `users` table has no `admin@bytescon.com`, run `npm run db:seed`.

5. **Servers** — two background commands, logs to the scratchpad or `/tmp/claude-501/`:
   - `cd backend && npm run dev` → http://localhost:3001
   - `cd frontend && npm run dev` → http://localhost:3000
   Then poll (background) until `curl localhost:3001/health` and `curl localhost:3000` both return 200.
   On failure, show the last lines of each log.

6. **Report** to the user: open http://localhost:3000, login `admin@bytescon.com` / `Admin1234!`.
   Mention: with no `SAM_API_KEY`, use Dashboard → "Load Demo" for sample opportunities;
   "Scheduled job silent" and "SAM API key not configured" log errors are expected locally.

Servers started from a session stop when the session ends. To stop them sooner: kill the background
tasks; `docker compose stop` stops Postgres and Redis.
