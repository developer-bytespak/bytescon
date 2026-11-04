# Go-live plan

**Written:** 2026-11-04 · **Owner:** Kamran Khan · **Status:** 📋 Proposed (dates are a suggestion; the owner sets them)

**Simple version:** the code is close. The main things between today and real customers are a few **settings and paid
accounts that only the owner can set up**, plus about a week of fixes to what customers could notice or what could
leak data. After that, a short rehearsal and a **small beta** with a handful of firms, then public launch.

---

## 1. Suggested timeline

| Week | Dates (suggested) | Engineering (Claude) | Owner (Kamran) |
|------|-------------------|----------------------|----------------|
| 1 | Mon 9 – Fri 13 Nov 2026 | Fix the launch-blocking bugs (§3). Build the staging/production split (doc 20, C1–C9) | Create accounts: Cloudflare R2, Sentry, a Stripe account for Bytescon. Decide the domain (§2). Create the Neon `staging` branch now, before any customer data (doc 20, S1) |
| 2 | Mon 16 – Fri 20 Nov | Bring staging live and run the rehearsal **on staging**, then repeat the key steps on production. Practise restoring the database | Upgrade Render, create the staging services, connect both domains, verify the email domain, enter the settings (§4, doc 20 S2–S8) |
| 3 | Mon 23 – Fri 27 Nov (Thanksgiving week, 26–27 Nov) | Fix whatever the rehearsal finds; watch monitoring | Invite 3–5 friendly beta firms |
| **Beta live** | **Mon 30 Nov 2026** | Daily check of errors, jobs and payments for 2 weeks | Talk to beta firms weekly |
| **Public launch** | **Mid-December 2026** (after 2 calm beta weeks) | — | Open sign-ups and remove the beta cap |

The dates only hold if the owner steps in weeks 1–2 are done. Each owner task takes 10–30 minutes.

## 2. Decisions only the owner can make

| # | Decision | Why it matters | Recommendation |
|---|----------|----------------|----------------|
| D1 | **The domain** (e.g. `bytescon.com`). The code's production example already assumes `bytescon.com` | Customers, emails and Stripe receipts should come from your own domain, not `vercel.app` / `onrender.com` | Use `app.bytescon.com` for the app and `api.bytescon.com` for the backend |
| D2 | **Storage:** Cloudflare R2 or AWS S3 | Needed so uploads survive (B1) | R2 now; S3 later if FedRAMP/CMMC hosting comes first (see doc 15) |
| D3 | **Beta or straight to public** | A beta catches real-world problems with low risk | Beta first. The code already has a beta-slot cap (`MAX_BETA_SLOTS`) and a beta NDA |
| D4 | **Launch prices** | Stripe charges what the code says ($99 Core, $199 All Access, add-ons $29–$79) | Confirm or change before Stripe goes live |

## 3. Code to finish before launch (Claude, week 1)

Already fixed: B1 (code), B3, B4, B5, B6, B7, B8, B13, B14, B23, B27, B28.

| Priority | Bug | Why before launch |
|----------|-----|-------------------|
| 🟠 | **R11** Hosting config file (`render.yaml`) | Makes the paid plans and settings repeatable, so a redeploy can't quietly fall back to free plans |
| 🟡 | **B29** Discovery source descriptions show an internal field name (`configJson.maxRecords`) | First impressions |

Can wait until after beta: B9–B12, B15–B22, B24–B26 (see doc 14).

## 4. Production setup (owner, weeks 1–2)

| # | Task | Where | Notes |
|---|------|-------|-------|
| T1 | **Storage bucket**, plus the 5 `UPLOADS_S3_*` settings | Cloudflare → Render `bytescon-api` | Steps in doc 15 §5 |
| T2 | **Stripe test key** in local `backend/.env`, for the fake-card rehearsal | Stripe dashboard (test mode) | Never paste it in chat |
| T3 | **Upgrade Render:** `bytescon-api` → Standard, `bytescon-redis` → a paid Key Value plan; `bytescon-mcp` → Starter if MCP connectors are offered | Render dashboard | Fixes B2. Paid Key Value keeps its data, which job queues and sign-outs rely on |
| T4 | **Stripe live:** live secret key, plus a webhook to `https://<api domain>/api/webhooks/stripe` and its signing secret (`STRIPE_SECRET_KEY`, `STRIPE_WEBHOOK_SECRET`) | Stripe → Render | Only after the T2 rehearsal passes |
| T5 | **Domain:** add the app domain in Vercel and the API domain in Render, then set `APP_URL`, `FRONTEND_URL` and `PUBLIC_APP_URL` on Render and `VITE_API_URL` on Vercel | Vercel, Render, your DNS | Claude can prepare the exact values once D1 is decided |
| T6 | **Email:** verify the sending domain in SendGrid, then set `SENDGRID_API_KEY` and `EMAIL_FROM=noreply@<domain>` | SendGrid → Render | Without it, verify/reset/invite emails land in spam or aren't sent |
| T7 | **Monitoring:** `SENTRY_DSN`, `OPS_HEARTBEAT_TOKEN`, `ALERT_WEBHOOK_URL`, `METRICS_SECRET`, `PLATFORM_ADMIN_EMAIL` (where alerts go), `PLATFORM_ADMIN_EMAILS` (Bytescon operators allowed into platform-only areas: model tests, template approval, platform metrics) | Sentry → Render | Missing today (found 2026-11-03) |
| T8 | **Database backups:** confirm the Neon plan's restore window | Neon dashboard | Then Claude rehearses a restore |
| T9 | **Vercel plan:** Vercel's free Hobby plan is for non-commercial use, so check the team's plan before charging customers | Vercel dashboard | Pro is about $20/user/month (confirm on vercel.com) |

## 5. Rehearsal before beta (week 2)

The whole customer journey, first on **staging** (doc 20), then the key steps on production with Stripe in test mode:
1. **Sign up and onboard:**
   - sign up;
   - verify the email;
   - accept the Terms;
   - set up MFA;
   - add a client company.
2. **Pay:**
   - subscribe to Core with a test card;
   - add an add-on (one charge);
   - fail a renewal, then pay it;
   - cancel.
3. **Files:** upload an RFP, restart the server, and download it again (proves T1).
4. **Daily work:**
   - sync federal, state and subcontracting leads;
   - score an opportunity;
   - build a compliance matrix;
   - generate a proposal draft.
5. **Team:** invite a team member, then deactivate them.
6. **Agents and monitoring:** check an agent run respects opt-in (after B6), and that Sentry and the heartbeat receive events.
7. **Backups:** restore the database to a copy and confirm the data is there.

Every step passes → beta. Any step fails → fix on staging, then repeat that step.

From go-live on, every change goes **staging first, then production** (doc 20 §4).

## 6. Monthly running cost (approximate, confirm before buying)

| Item | Plan | ~ per month |
|------|------|-------------|
| Render `bytescon-api` | Standard (2 GB RAM, 1 CPU) | $25 |
| Render `bytescon-redis` | Starter Key Value | ~$10 |
| Render `bytescon-mcp` | Starter (only if MCP connectors are offered) | $7 |
| Render workspace | Hobby is $0; Pro ($25) only for team seats and more bandwidth | $0–25 |
| Vercel frontend | Pro, for commercial use | ~$20 |
| Cloudflare R2 | 10 GB free, then per GB | ~$0–2 |
| Neon Postgres, Sentry, SendGrid | Free tiers may be enough for the beta; check limits | $0+ |
| AI (OpenAI/Claude) | Usage-based, capped by firm budgets (B6 fixed) | varies |
| **Total before AI usage** | | **≈ $60–90** |

Render prices are from third-party trackers (Nov 2026) and Render's changelog; confirm on render.com/pricing.

## 7. First two weeks after go-live
- **Daily:** check Sentry errors, the job-health page, Stripe payments and webhook failures, and agent spend.
- **Weekly:** talk to each beta firm, and fix top issues within the week.
- **Rollback:** Vercel and Render both keep previous deploys. Roll back from their dashboards; database migrations
  only add, so a code rollback is safe.
