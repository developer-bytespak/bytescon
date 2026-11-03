# Environments: staging and production

**Written:** 2026-11-04 · **Status:** 📋 Planned (part of the [go-live plan](19-go-live-plan.md), weeks 1–2)
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
| Server plan | API **Starter** ($7) so it's always on and scheduled jobs run like production; Redis free | API Standard, paid Redis (doc 19 T3) |

Both environments run the **same code**; only their settings differ. `NODE_ENV=production` on both, so staging behaves
like production. A new setting, `APP_ENV=staging|production`, switches on the staging-only protections.

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

### Claude (code, week 1)

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

### Owner (dashboards, week 1–2, about 45 minutes in total)

| # | Task | Where |
|---|------|-------|
| S1 | Create the Neon branch `staging` **now, before any customer data exists**, then copy its connection string | Neon dashboard |
| S2 | Create the R2 bucket `bytescon-uploads-staging` and an access token for it | Cloudflare |
| S3 | Create the staging services from `render.yaml` (Render → Blueprints → the repo) and paste the staging settings. Claude gives the exact list | Render |
| S4 | Stripe **test mode**: add a webhook to `https://api-staging.bytescon.com/api/webhooks/stripe` and copy its secret | Stripe |
| S5 | Vercel: assign `staging.bytescon.com` to the `staging` branch. Set Preview variables `VITE_API_URL=https://api-staging.bytescon.com` and `VITE_APP_ENV=staging`. Turn on Deployment Protection for previews | Vercel |
| S6 | DNS: `staging` and `api-staging` records for the domain | Your DNS provider |
| S7 | Decide `STAGING_ALLOWED_EMAILS`, the staff who may use staging | — |
| S8 | GitHub: protect `main` (require CI, no direct pushes) | GitHub → Settings → Branches |

Claude can do S3 and S5 through the CLIs if you prefer, but only on your go-ahead, because they create paid services
and change settings.

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
| **Staging total** | **≈ $7** on top of production (doc 19 §6) |

Render prices are from third-party trackers (Nov 2026). Confirm on render.com/pricing.
