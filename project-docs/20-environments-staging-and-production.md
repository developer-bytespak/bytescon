# Environments: staging and production

**Written:** 2026-11-04 · **Status:** 🟡 Code done (C1–C9, 2026-11-04); waiting on the owner steps S1–S8 (steps and order: [doc 10 §3](10-status-done-and-remaining.md#3-going-live))
**Decision (owner, 2026-11-04):** two live environments.
- **Production** is for end users.
- **Staging** is for the internal team only. Every change is tested there before it reaches production.

---

## 1. Simple version

Think of two copies of the shop:
- **Staging** is the back room, where the team tries everything first. Only staff can get in, the money is fake, and
  emails only reach staff.
- **Production** is the real shop, open to customers.

New work always goes to the back room first. Only when the owner says "ready" is the exact same version moved to the
real shop.

## 2. The two environments

| | **Staging** (internal only) | **Production** (end users) |
|---|---|---|
| Git branch | `staging` | `main` |
| Website | `staging.bytescon.com` | `app.bytescon.com` |
| API | `api-staging.bytescon.com` → Render `bytescon-api-staging` | `api.bytescon.com` → Render `bytescon-api` |
| Redis | Render `bytescon-redis-staging` | Render `bytescon-redis` (paid) |
| MCP gateway | `bytescon-mcp-staging` only when MCP is being tested | `bytescon-mcp` |
| Database | Neon **branch `staging`**: test data only, never customer data | Neon main branch |
| Payments | Stripe **test mode** (fake cards, no money moves) | Stripe **live** |
| File storage | R2 bucket `bytescon-uploads-staging` | R2 bucket `bytescon-uploads` |
| Email / SMS | Delivered **only** to an internal allow-list; everything else is logged and dropped | Delivered to customers |
| AI keys | Separate key with a low spending cap | Production key |
| Secrets (`JWT_SECRET`, `FIELD_ENCRYPTION_KEY`, …) | Their **own** values | Their own values. Never shared, so a staging leak can't open production |
| Who can sign in | **Only allow-listed staff emails**; public sign-up is off | Customers |
| Search engines | Blocked | Allowed (landing pages) |
| Look | Orange **"STAGING — internal"** bar on every page | Normal |
| Server plan | API **Starter** ($7) so it's always on and scheduled jobs run like production; Redis free | API Standard, paid Redis (doc 10 T3) |

Both environments run the **same code**; only their settings differ. `NODE_ENV=production` on both, so staging behaves
like production. A new setting, `APP_ENV=staging|production`, switches on the staging-only protections.

## 2a. Flavours

A flavour is a named setup: **development**, **staging** or **production**. All three run the same code, and only the settings differ.

| Flavour | Backend | Frontend | Settings listed in |
|---------|---------|----------|--------------------|
| Development | `npm run dev` | `npm run dev` | `backend/.env.example` |
| Staging | `APP_ENV=staging` | `npm run build:staging` locally; `VITE_APP_ENV=staging` on Vercel (S5) | `backend/.env.staging.example`, `frontend/.env.staging` |
| Production | `APP_ENV=production` | `npm run build` | `backend/.env.prod.example`, `frontend/.env.production` |

- **The one list** of what each hosted flavour needs is `backend/src/config/flavours.ts`. A test fails if `render.yaml` or the example files disagree with it.
- **Is this environment ready?** Run `npm run flavour:check` in the service's Render shell, or `npm run flavour:check -- staging` to name a flavour. It prints setting names only, never values, and exits 1 if anything is missing or wrong.
- **At startup,** a hosted server logs which settings are missing or wrong, in the host's own log. (Production logs used to go only to local files, which Render wipes; they now reach the console too.) It's a warning, not a stop: only a staging that could charge real cards or lock everyone out refuses to start (§3).
- **Adding a required setting:** add it to `flavours.ts`, `render.yaml` and the example files. Non-secret frontend switches go in `frontend/.env.staging` and `.env.production`; secrets never go in any committed file.

## 3. Keeping staging internal

Three independent locks, so one mistake can't expose staging:
1. **Sign-in allow-list (in the app).** With `APP_ENV=staging`, the backend refuses sign-up and refuses sign-in for any
   email not on `STAGING_ALLOWED_EMAILS`. That's a list of addresses or whole domains, e.g. `@bytesplatform.com`.
   It works whatever the hosting plan.
2. **Website protection (Vercel).** Turn on Deployment Protection for preview deployments, so staging pages need a
   Vercel login from the team.
3. **No outside contact.** The staging email and SMS allow-list means testers can't accidentally email a real agency
   or client. Search engines are told not to index it.

## 4. How a change reaches users

```
 work ─▶ staging branch ─▶ CI tests ─▶ auto-deploy to STAGING ─▶ internal team tests
                                                                     │ owner approves
                                                                     ▼
                         merge staging → main ─▶ CI tests ─▶ auto-deploy to PRODUCTION
```

1. **Everyday work:**
   - Claude commits to `staging`.
   - CI runs the full test suite.
   - Render and Vercel deploy staging.
   - Database migrations run on staging first, so a bad migration is caught before production.
2. **Release:** when the owner says it's ready, `staging` is merged into `main`. Production gets exactly the code that
   was tested.
3. **Urgent production fix:**
   - Branch from `main` and apply the fix.
   - Quick check on staging.
   - Merge to `main`, then merge `main` back into `staging` so they don't drift apart.
4. **Rollback:** redeploy the previous version from the Vercel and Render dashboards. Migrations only ever add, so
   this is safe.
5. **GitHub protection on `main`:** changes arrive only by merging from `staging` (or a hotfix branch) and only with
   green CI. The owner keeps the final say.

## 5. Work list

### Claude (code, week 1) ✅ done 2026-11-04

| # | Change | Where |
|---|--------|-------|
| C1 | `APP_ENV` setting, exposed in `/health` and to the frontend (`VITE_APP_ENV`) | `backend/src/config/config.ts`, frontend config |
| C2 | Staging sign-in gate: no public sign-up, `STAGING_ALLOWED_EMAILS` check on password, SSO and invite sign-in | `backend/src/routes/auth.ts`, `routes/sso.ts` |
| C3 | Staging email/SMS allow-list; everything else logged, not sent | `backend/src/services/mailer.ts`, `smsService.ts` |
| C4 | Orange "STAGING — internal" bar; `noindex` on staging | frontend layout, `index.html`/headers |
| C5 | `render.yaml` describing both environments' services and plans (also R11), so neither can drift to the wrong plan | repo root |
| C6 | CI runs on pushes to `staging` and `main` and on pull requests into either | `.github/workflows/ci.yml` |
| C7 | Test-data seed for staging (demo firm, clients, opportunities). Never copied from production | `backend/prisma/` |
| C8 | Tests for C2–C4 | backend + frontend |
| C9 | Update `CLAUDE.md` and the run/ship skills: commit to `staging`, promote to `main` only on the owner's approval | `CLAUDE.md`, `.claude/skills/` |

### Owner steps

The owner's steps S1–S8 are in [doc 10 §3.5](10-status-done-and-remaining.md#3-going-live), about 45 minutes in total.

### Settings for `bytescon-api-staging` (S3)

Render asks for these when the Blueprint is applied. Every value is **staging's own**, never production's.

| Setting | Value |
|---------|-------|
| `STAGING_ALLOWED_EMAILS` | Your decision from S7, e.g. `@bytesplatform.com`. Staging won't start if it's empty |
| `STAGING_ALLOWED_PHONES` | Staff numbers for SMS tests; leave empty for none |
| `STAGING_SEED_ADMIN_EMAIL` / `STAGING_SEED_ADMIN_PASSWORD` | The first staff admin. The email must be on the list; the password needs at least 12 characters |
| `DATABASE_URL` / `DIRECT_URL` | The Neon `staging` branch (S1) |
| `FIELD_ENCRYPTION_KEY` | A new value: `openssl rand -hex 32` |
| `APP_URL`, `FRONTEND_URL`, `PUBLIC_APP_URL`, `ALLOWED_ORIGINS` | The staging website address |
| `STRIPE_SECRET_KEY` / `STRIPE_WEBHOOK_SECRET` | Stripe **test mode** (S4). Staging won't start with a live key |
| `SENDGRID_API_KEY`, `EMAIL_FROM` | A separate key; only the access list receives mail |
| `SAM_API_KEY`, `OPENAI_API_KEY`, `ANTHROPIC_API_KEY` | Separate keys, with a low spending cap on the AI keys |
| `UPLOADS_S3_*` | The staging bucket (S2) |

`JWT_SECRET` is generated by Render. Afterwards, run `npm run db:seed-staging` once in the service's Render shell to
create the demo firm and the first admin. It refuses to run anywhere but staging.

**Before applying the Blueprint:** Render shows every change first. `render.yaml` also lists the production services
at their paid plans (T3), so applying it **upgrades production**. Do it only when you're ready for that cost, and
check the preview. Claude creates the `staging` branch on GitHub when you start this step.

### Results of the code work (2026-11-04)

| Check | Result |
|-------|--------|
| New tests `backend/src/services/appEnvironment.integration.test.ts` | ✅ Sign-in, sign-up, email, SMS, start-up guards and seed. Removing each of 6 locks on purpose made a test fail |
| New test `frontend/src/components/StagingBanner.test.tsx` | ✅ Shown on staging, hidden otherwise |
| `render.yaml` | ✅ `render blueprints validate` says valid. Nothing was applied |
| Local rehearsal in staging mode | ✅ Non-staff with the right password refused (403); seeded staff admin signed in; sign-up closed (403); an outsider's reset email logged, not sent; `/health` reports `staging`; `X-Robots-Tag` and `noindex` present on staging only; orange bar shown in a browser; a live Stripe key is refused at start |

**Not yet proven:** the real hosted staging, which needs S1–S8; the checks in §6 are run then. Single sign-on goes
through the same session check, but its early refusal has no test of its own. Firm API tokens are not limited by the
access list, so create them only for staff.

### Already fixed by this plan
- **Today:** a Vercel preview of any branch talks to the **production** API (its only setting, `VITE_API_URL`, points
  there). **After S5:** previews talk to staging.
- **Today:** a push to `main` is a release with no prior test environment. **After S8:** every release has been on
  staging first.

## 6. Checks that both environments are live and separate

Done when all of these pass:

| Check | Expected |
|-------|----------|
| `https://app.bytescon.com` and `https://staging.bytescon.com` both load | ✅ both up, staging shows the orange bar |
| `GET /health` on each API | 200, reporting `production` / `staging` respectively |
| A non-staff email signs in or signs up on staging | Refused |
| A staff email signs in on staging | Works |
| Upload a file on staging | It lands in the **staging** bucket only |
| Stripe test card on staging | Works; production Stripe shows nothing |
| Email triggered on staging to a non-staff address | Logged, not sent |
| A change merged to `staging` | Appears on staging only. After merge to `main`, appears on production |
| Production data seen from staging | None |

## 7. Cost

| Item | ~ per month |
|------|-------------|
| `bytescon-api-staging` (Starter, always on) | $7 |
| `bytescon-redis-staging` (free) | $0 |
| Neon `staging` branch | $0 on most plans (check the plan's branch limit) |
| R2 staging bucket, Vercel preview, Stripe test mode | $0 |
| **Staging total** | **≈ $7** on top of production (doc 10 §3.7) |

Render prices are from third-party trackers (Nov 2026). Confirm on render.com/pricing.
