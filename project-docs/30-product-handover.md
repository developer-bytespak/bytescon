# 30 — Handing the product to a client (their own copy)

Who this is for: founders and developers setting up a copy of the platform that a client buys and runs as their own product.

The rule: **the client's copy uses only the client's own accounts, keys and data.** Nothing that belongs to Bytescon — keys, logins, the database, the SAM.gov pool, operator accounts — goes into it.

Setting names come from `backend/.env.example`, `frontend/.env.example`, `render.yaml` and `backend/src/config/flavours.ts`. If those change, this list must change with them.

---

## 1. Accounts the client must own

Created in the client's name, paid by the client, with the client holding the owner login:

| What | Today (Bytescon) | Client's copy |
|---|---|---|
| Backend hosting | Render `bytescon-api`, `bytescon-mcp`, `bytescon-redis` | Their own Render (or other) services |
| Frontend hosting | Vercel project `bytescon` | Their own Vercel project |
| Database | Neon (Postgres) | Their own Postgres, created empty |
| Redis | Render Key Value | Their own |
| File storage | S3-compatible bucket | Their own bucket |
| Domain and DNS | `bytesgov.com` | Their own domain |
| Email sending | SendGrid | Their own account, with their domain authenticated |
| Payments | Stripe | Their own Stripe account, products and prices |
| AI | OpenAI (and/or Anthropic) | Their own keys, with spending limits |
| SAM.gov | Bytescon's key | Their own key, or each firm's key in Settings ([29-opportunity-sources.md](29-opportunity-sources.md)) |
| Error and usage tracking | Sentry, PostHog (if used) | Their own, or left off |
| Source code | Bytescon's GitHub | As the sale agreement says |

---

## 2. Settings

Set on their backend host (Render or equivalent) and their frontend host (Vercel). Never copy a value from Bytescon's settings.

### Must be the client's own

| Setting | What it is |
|---|---|
| `DATABASE_URL`, `DIRECT_URL` | Their database |
| `REDIS_URL` | Their Redis |
| `JWT_SECRET` | New random secret for sign-in tokens |
| `FIELD_ENCRYPTION_KEY` | **New** key that encrypts stored secrets (e.g. firms' SAM keys). Never reuse Bytescon's: whoever holds it can read the data. Keep a safe copy; losing it loses those secrets. |
| `APP_URL`, `FRONTEND_URL`, `PUBLIC_APP_URL`, `PUBLIC_API_URL` | Their web addresses |
| `ALLOWED_ORIGINS` | Their frontend address(es) only |
| `PLATFORM_ROOT_DOMAIN`, `EMAIL_APP_DOMAIN` | Their domain. If unset, the code falls back to `bytesgov.com` |
| `EMAIL_FROM`, `EMAIL_FROM_NAME`, `SENDGRID_API_KEY` | Their sender address, name and email key |
| `CAN_SPAM_POSTAL_ADDRESS` | Their postal address for email footers |
| `MAILER_PROBE_TO` | Their test address. Falls back to `probe@bytesgov.com` |
| `PLATFORM_ADMIN_EMAIL`, `PLATFORM_ADMIN_EMAILS` | Their operators. Never Bytescon addresses |
| `DEVELOPER_ADMIN_EMAIL` | The one account that sees `/fetch-history` (every firm's fetches and data): **their** developer, or empty so nobody can. Never a Bytescon address |
| `SAM_API_KEY` | Their SAM.gov key, or leave empty and have each firm enter its own |
| `SAM_GOV_API_KEY`, `DATA_GOV_API_KEY` | Their keys, if those features are used |
| `OPENAI_API_KEY`, `ANTHROPIC_API_KEY` | Their AI keys |
| `STRIPE_SECRET_KEY`, `STRIPE_WEBHOOK_SECRET` | Their Stripe keys and webhook |
| `UPLOADS_S3_BUCKET`, `UPLOADS_S3_ENDPOINT`, `UPLOADS_S3_REGION`, `UPLOADS_S3_ACCESS_KEY_ID`, `UPLOADS_S3_SECRET_ACCESS_KEY` | Their file storage |
| `OPS_HEARTBEAT_TOKEN`, `METRICS_SECRET` | New random values |
| `ALERT_WEBHOOK_URL`, `ALERT_SMS_TO` | Their alert destinations |
| `SENTRY_DSN` | Their Sentry, or empty |
| `GCP_PROJECT_ID`, `BQ_DATASET` | Their Google Cloud, if Winners Intel is used |
| `CLAY_API_KEY` | Theirs, if Clay enrichment is used |
| Integrations: `QUICKBOOKS_*`, `UNANET_*`, `DELTEK_*`, `GOOGLE_CALENDAR_*`, `MICROSOFT_*`, `SLACK_*`, `DOCUSIGN_*` | Only if used, with apps registered in **their** name |
| Frontend: `VITE_API_URL` | Their backend address |
| Frontend: `VITE_STRIPE_PUBLISHABLE_KEY`, `VITE_STRIPE_PRICING_TABLE_ID` | Their Stripe |
| Frontend: `VITE_SENTRY_DSN`, `VITE_POSTHOG_KEY`, `VITE_POSTHOG_HOST`, `VITE_POSTHOG_UI_HOST` | Theirs, or empty |

### Bytescon-only — empty or off in a client's copy

| Setting | Why |
|---|---|
| `APP_ENV` | Must be `production` (not `demo` or `staging`). The demo runs the shared pool, demo accounts and demo limits. |
| Frontend `VITE_APP_ENV` | Not `demo`. Build with `npm run build`, not `build:demo`. |
| `DEMO_ADMIN_EMAIL`, `DEMO_ADMIN_PASSWORD` | Demo operator login |
| `DEMO_POOL_ADMIN_EMAIL`, `DEMO_POOL_ADMIN_PASSWORD` | Bytescon's demo pool login; the demo only. |
| `STAGING_ALLOWED_EMAILS`, `STAGING_ALLOWED_PHONES`, `STAGING_SEED_ADMIN_EMAIL`, `STAGING_SEED_ADMIN_PASSWORD` | Bytescon's internal staging |

### Can stay at their defaults

`NODE_ENV=production`, `PORT`, `JWT_EXPIRES_IN`, `RATE_LIMIT_*`, `MAX_UPLOAD_MB`, `SAM_BASE_URL`, `SAM_PAGE_SIZE`, `USASPENDING_BASE_URL`, `GSA_API_BASE_URL`, `ENRICHMENT_*`, `MATCHING_*`, `CLAUDE_MODEL_*`, `OPENAI_MODEL_*`, `DEFAULT_LLM_PROVIDER`, `PROBABILITY_RENORMALIZE_ABSENT`, `PRISMA_TX_*` and the feature switches in `backend/.env.example`. Review the switches with the client; each is documented there.

An empty `ENRICHMENT_*` line (e.g. `ENRICHMENT_NOTICEDESC_URL=` as copied from `.env.example`) means "use the default" since 2026-11-13. Before that, an empty URL was used as-is and every SAM.gov description fetch failed with "Invalid URL", so on an older copy, remove such lines or fill them in.

### Two decisions to make with the client

- **Who pays for AI.** There are two ways to supply a key:
  - a **platform key** (`OPENAI_API_KEY` / `ANTHROPIC_API_KEY`) that every firm on their copy uses, billed to them;
  - **each firm's own key**, entered by that firm's admin in **Settings → AI Intelligence Provider**, billed to that firm.

  Both can be used: a firm's own key takes precedence. Without either, AI features tell an admin where to add a key, and anyone else to ask an admin.
- **Profiles must be complete before AI and scoring.** Scoring, bid decisions, AI analysis and proposal writing wait until a company profile is complete: a contractor's own company, or each client of a consulting firm ([32](32-profile-completion.md)). New users see "Complete your profile first". Tell the client so their users aren't surprised, and fill in the profile for any company you set up for them.

The backend logs a warning at start when a required setting for its flavour is missing (`backend/src/config/flavours.ts`); it doesn't stop. `npm run flavour:check` in `backend/` is the strict check to run before going live.

---

## 3. Bytescon addresses in the code

Most are fallbacks used only when a setting is empty, so setting section 2 correctly covers them:

| File | Falls back to | Setting that replaces it |
|---|---|---|
| `backend/src/config/config.ts`, `workers/watchlistDigestWorker.ts`, `services/clientMatchNotificationEmail.ts`, `services/clientMatchNotificationService.ts` | `https://app.bytesgov.com` | `APP_URL` |
| `backend/src/services/mailer.ts` | `noreply@bytesgov.com` | `EMAIL_FROM` |
| `backend/src/services/hostResolver.ts` | `bytesgov.com` | `PLATFORM_ROOT_DOMAIN` |
| `backend/src/services/brandedEmailTemplates.ts` | `bytesgov.com` | `EMAIL_APP_DOMAIN` |
| `backend/src/routes/health.ts` | `probe@bytesgov.com` | `MAILER_PROBE_TO` |
| `backend/src/services/watchlistDigestEmail.ts` | `https://app.bytesgov.com` | Its caller passes `APP_URL` |

These are **written into the page** and need a code change in the client's copy:

| File | Text |
|---|---|
| `frontend/src/pages/Settings.tsx` | `support@bytescon.com` (veteran discount contact) |
| `frontend/src/pages/TrustSecurity.tsx` | `security@bytescon.com` |
| `frontend/src/pages/DemoAdmin.tsx` | `https://demo.bytesgov.com` (demo-only page; unused when `APP_ENV` isn't `demo`) |

The product name "Bytescon", logos, and the Terms and Privacy text also appear throughout the app. Whether the client's copy keeps them or is rebranded is a sale decision; rebranding is a separate piece of work.

To recheck before each handover:

```bash
grep -rnE "bytesgov\.com|bytescon\.vercel\.app|onrender\.com|bytesplatform\.com|@bytescon\.com" backend/src frontend/src mcp --include='*.ts' --include='*.tsx' | grep -v '\.test\.'
```

---

## 4. Setting up the copy

1. Create the client's accounts (section 1), with the client as owner.
2. Create an empty database. **Never copy Bytescon's database**: it holds other customers' data.
3. Set the settings (section 2) on their backend and frontend hosts.
4. Deploy. The backend applies database migrations at start (`npx prisma migrate deploy`).
5. Create their first operator login, using an address on `PLATFORM_ADMIN_EMAILS`.
6. Set up their Stripe products, prices and webhook, and check the plans in the app match them.
7. Authenticate their email domain in SendGrid and send a test email.
8. Point their domain at their frontend and backend; check the certificate.

---

## 5. Checks before handing over

- [ ] Health check returns OK and shows `appEnv: production`.
- [ ] No demo banner, demo admin page or pool page appears.
- [ ] Sign-up, email confirmation and sign-in work, and emails come from their address with their links.
- [ ] Sync Contracts fetches notices with **their** SAM.gov key (or a firm's own key).
- [ ] A file upload survives a server restart (their storage is in use).
- [ ] A test payment in Stripe test mode, if billing is used.
- [ ] An AI feature works on their key, within their spending limit, for an **ordinary firm admin**, not only the operator.
- [ ] Completing a company profile gets that company's waiting opportunities scored (within a minute or two).
- [ ] Opening a SAM.gov notice fetches its full description (or says it's waiting on the SAM.gov daily limit).
- [ ] The grep in section 3 finds nothing left that matters.
- [ ] None of Bytescon's keys, logins or addresses appear in their hosts' settings.

---

## 6. Never copy from Bytescon

- Any value from Bytescon's Render, Vercel or `.env` files.
- `FIELD_ENCRYPTION_KEY` or `JWT_SECRET`.
- The database, or any export of it.
- Bytescon's SAM.gov key, or the pool setup.
- Operator, demo or developer logins and passwords.
- Bytescon's Stripe, SendGrid, AI, Sentry or PostHog accounts.

When the handover is done, any access Bytescon still has to the client's accounts is removed, unless the sale agreement says otherwise.
