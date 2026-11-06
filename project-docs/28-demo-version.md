# Demo version: demo.bytesgov.com

**Status:** 🟡 Code done (2026-11-05, branch `feat/demo-version`). Waiting on hosting.
**Purpose:** show clients what the product does, without payments or file storage.

---

## 1. What a client gets

- A login an operator creates and sends them. No sign-up, email check or MFA.
- Short onboarding at every sign-in (what the product is, what it does and how, key features), leading into a guided tour. A page refresh doesn't restart it, and the tour can be replayed from the bar at the top.
- Every feature until the end date, with their own pre-filled clients, pipeline, past bids, a proposal and a contract. Opportunities are real SAM.gov notices in their business type once the shared pool has some; until then, invented ones.
- Real AI within a limit: 25 proposal tokens in total and 100 AI calls a month. The limit is checked in `generateWithRouter`, so every AI feature is covered.
- No file uploads or downloads, and no billing.

After the end date they see "Your demo has ended" and can't sign in, and partner and client portal logins stop too. Open sessions stop within 30 seconds at most, or at once when an operator ends the demo on the same server. The data is deleted 30 days later.

The Pipeline works as in the full version. It starts with sample work in every column, and opening a notice adds it under Identified.

### Real notices from SAM.gov

A public SAM.gov key allows only a handful of requests a day, so accounts never call SAM.gov themselves. A hidden pool firm (`services/demoOpportunityPool.ts`) pulls everything new once a day (the first pull looks back 30 days, at most 3 pages of 1,000), and every demo and operator account is filled with the pool's open notices in its business type, newest first, up to 200 a fill. Every account shows at least 20 open notices: real ones first, and invented ones for any shortfall. As real notices arrive, invented ones not on the pipeline (Identified to Submitted) are retired, so a client's work is kept; if real ones expire, invented ones return to make up the twenty. New accounts are filled at once; **Sync Contracts** refreshes the pool if it's due and tops the account up. If a pull fails, nothing is removed: accounts keep their invented notices and the operator page shows the error. `SAM_API_KEY` must be valid on the server, and SAM.gov keys expire, so renew it before it lapses.

## 2. How it fits together

It's a fourth flavour (doc 20 §2a), `APP_ENV=demo`, with its own server, database and Redis. Production is untouched.

| Part | Where |
|------|-------|
| Who may sign in | `services/demoAccess.ts`: operators and unexpired demo accounts only, even if other accounts are in the database |
| Accounts, expiry and deletion | `services/demoAccounts.ts`, `routes/demo.ts`, `ConsultingFirm.demoExpiresAt` |
| Sample data | `services/demoSampleData.ts`. Scores and bid decisions come from the real engine, so re-scoring keeps them |
| No files | `middleware/demoFileGuard.ts` refuses them for the whole API. `demo/DemoFileGuard.tsx` hides the controls |
| Email and SMS | Dropped and logged, never sent |
| Screen pieces | `frontend/src/demo/`, `pages/DemoAdmin.tsx` |
| Hosting | `render-demo.yaml`, kept apart from `render.yaml`, which would also create staging and upgrade production |

Operators are the addresses on `PLATFORM_ADMIN_EMAILS`. They create accounts one at a time with the form at `/demo-admin`, linked from the bar at the top: company, contact, email, state and days, then **Generate**. The login and password appear once. **Business type** is required and uses the 12 NAICS groups the app already has. It sets the account's sample clients, opportunities, past bids and contract (`services/demoBusinessTypes.ts`), and the Opportunities list only shows that business. Accounts created before this got a random type at startup, with their sample data rebuilt. The state list has all 50 states and DC, plus **Other** for a place typed in. It picks the account's invented companies: Virginia, Texas, California, Illinois and Georgia have hand-picked names, and the rest use the place's name, such as Ohio Ridgeline Technologies. Check those names before a client sees them, as they haven't all been checked against real firms.

The server runs on Render's free plan, so it sleeps when idle and the first page load can take about a minute. Open the site a couple of minutes before a demo. Changing to Starter (about $7 a month) stops that.

## 3. Going live

1. Neon: create a branch `demo` from main and copy its two connection strings for `neondb`.
2. Render: Blueprints → New → this repo, branch `feat/demo-version`, Blueprint path `render-demo.yaml`. Enter the settings it asks for.
3. Render: add the custom domain `api-demo.bytesgov.com` to `bytescon-api-demo`.
4. Vercel: a new project from this repo with Root Directory `frontend`, Production Branch `feat/demo-version` and Build Command `npm run build:demo`, plus the domain `demo.bytesgov.com`.
5. GoDaddy: add the two CNAME records Render and Vercel show.
6. Sign in as the operator at `https://demo.bytesgov.com`. The server creates that login when it starts, from `DEMO_ADMIN_EMAIL` and `DEMO_ADMIN_PASSWORD`. It also fills that account with the same sample data as a client, once, if it's empty.
7. On `/demo-admin`, fill in the form, press **Generate** and save the login. Then walk through the account as a client.

## 4. Verification results (2026-11-05)

| Check | Result |
|-------|--------|
| New tests | ✅ 29 backend (`routes/demo.integration.test.ts`), plus flavour and frontend tests (`demo/demo.test.tsx`) |
| Tests catch regressions | ✅ 18 of 19 deliberate breaks made a test fail. The other removed the `res.download` guard, which is still refused through the `sendFile` guard |
| Full suites | Frontend 896/896. Backend 4,612 of 4,613; the failure (`agents.test.ts`) fits the intermittent pattern in doc 27 §4, but wasn't re-run alone |
| Lint, type-check, demo build, blueprint | ✅ 238 warnings (limit 241); `render-demo.yaml` is valid |
| Local browser run as a client | ✅ Login, onboarding, tour (every step on target), and 25 pages with no error text or visible file controls after fixes |

**Found by the browser run, now fixed:** an unreadable onboarding box, sample scores overwritten with about 95% each, $0 and 0% dashboard cards, an 8750% completion rate, a leftover Load Demo button, a CSV button, and a reachable upload page.

**Seen on screen since:** the demo-ended message (at sign-in and during a session) and the operator page.

## 5. Known limits

- **Hiding file controls works by their wording** (upload, download, export, attach, import, CSV, PDF), plus blocks marked `data-demo-hide`. A control with other wording could still show, but the server refuses the action anyway.
- **Scores run high** (about 50–87%), because the sample clients fit these opportunities well. They're the engine's real output.
- **Pipeline figures measure different things:** the Dashboard sums recommended bids after subcontract share and a time discount, Portfolio weights every opportunity's full value, and Analytics projects revenue over six months. So they won't match.
- **Some screens start empty:** sources that sync from outside (Grants, Commercial, State & Municipal, Subcontracting), and workspaces a client creates (Pricing, Submission).
- **AI hasn't been tested on the demo:** that needs the hosted key.
- **Company names:** the client names were searched in November 2026 and had no exact match as a company, but that isn't a legal check. The partner names weren't searched.
- **Background jobs still run** on the demo server, but scheduled agents only run for demo accounts that haven't ended.
- **Unexplained 404s** (doc 27 §4) aren't resolved, so a client could hit one.
