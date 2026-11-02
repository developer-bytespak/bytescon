# Functional Requirements

**Simple version:** "Functional requirements" are the list of things the system **must be able to do**.
Each line below says *"The system shall…"*, which just means *"The system must…"*.

Each requirement has an ID so people can point to it (e.g. "FR-DISC-3"). Status column:
✅ built · 🟡 built but limited / behind a flag · ⛔ not built.

---

## FR-ACC — Accounts, sign-in and access

| ID | Requirement | Status |
|----|-------------|--------|
| FR-ACC-1 | Firms shall be able to self-register and start a 14-day all-access free trial without a card. | ✅ |
| FR-ACC-2 | Users shall sign in with email + password; reset password; verify email. | ✅ |
| FR-ACC-3 | Users shall accept the current Terms of Service / Beta NDA version before using data screens. | ✅ |
| FR-ACC-4 | Users shall be able to enable MFA (authenticator app, TOTP) with recovery codes. | ✅ (opt-in) |
| FR-ACC-5 | Firms shall be able to require SSO (OIDC) for their users. | 🟡 HS256 path tested; RS256/JWKS not tested against a live identity provider |
| FR-ACC-6 | Admins shall invite users and assign roles: ADMIN, CONSULTANT, BD_CAPTURE, PROPOSAL, CONTRACTS, FINANCE, VIEWER, plus extra permissions. | ✅ |
| FR-ACC-7 | Bid decisions and submission to government shall be restricted to ADMIN. | ✅ |
| FR-ACC-8 | Client-company users shall sign in to a separate Client Portal. | ✅ |
| FR-ACC-9 | Partner/subcontractor users shall be invite-only and sign in to a separate Partner Portal, optionally with MFA. | ✅ |
| FR-ACC-10 | Platform operators shall have admin-only screens (template moderation, fleet margin, platform metrics). | ✅ |

## FR-BILL — Billing and entitlements

| ID | Requirement | Status |
|----|-------------|--------|
| FR-BILL-1 | The system shall sell a base plan (Core), an All-Access plan, and a one-time Founders Lifetime plan through Stripe. | ✅ |
| FR-BILL-2 | The system shall sell 9 add-on modules monthly or annually. | ✅ |
| FR-BILL-3 | The system shall sell proposal-token packs (15 / 40 / 120) and grant monthly tokens, capped at 500 from grants. | ✅ |
| FR-BILL-4 | Locked features shall show an upgrade prompt (402 plan required / 403 add-on required). | ✅ |
| FR-BILL-5 | Stripe webhooks shall be processed exactly once. | ✅ |
| FR-BILL-6 | Firms shall see invoices and download PDFs; manage subscription via Stripe portal. | ✅ |
| FR-BILL-7 | Plans shall show "Coming soon" when Stripe is not configured. | ✅ |

## FR-CLI — Client companies

| ID | Requirement | Status |
|----|-------------|--------|
| FR-CLI-1 | Firms shall create, edit, archive, restore and CSV-import client companies. | ✅ |
| FR-CLI-2 | Each client shall store UEI, CAGE, NAICS, PSC, certifications (SDVOSB, WOSB, HUBZone, small business), clearances, ISO, agencies of interest. | ✅ |
| FR-CLI-3 | Firms shall look up a client from SAM.gov by UEI. | ✅ |
| FR-CLI-4 | Firms shall set document requirements with deadlines per client and track late penalties. | ✅ (🔒 contract_analysis) |
| FR-CLI-5 | Firms shall award compliance rewards to clients. | ✅ |
| FR-CLI-6 | Clients shall upload documents, review/approve deliverables, comment, and see fees/rewards in the portal. | ✅ (🔒 client_portal) |

## FR-DISC — Discovery

| ID | Requirement | Status |
|----|-------------|--------|
| FR-DISC-1 | The system shall ingest SAM.gov opportunities hourly and daily per firm. | ✅ (needs SAM API key) |
| FR-DISC-2 | The system shall ingest from additional source adapters (Grants.gov, forecasts, award history, civilian, state/local, subcontracting board, city/county portals). | ✅ |
| FR-DISC-3 | The system shall match opportunities to clients by NAICS, capabilities and set-aside eligibility. | ✅ (Matching v2 behind flag) |
| FR-DISC-4 | Users shall save monitoring profiles and receive deduplicated alerts. | ✅ |
| FR-DISC-5 | The system shall detect likely re-competes and link forecasts to solicitations (as suggestions). | ✅ |
| FR-DISC-6 | The system shall expire opportunities after their deadline. | ✅ |
| FR-DISC-7 | The system shall fetch full SAM.gov descriptions and extract clauses within a daily API budget. | ✅ |
| FR-DISC-8 | Users shall manually add opportunities and upload an RFP to create one with AI-extracted metadata. | ✅ |
| FR-DISC-9 | Users shall export opportunities to CSV. | ✅ |
| FR-DISC-10 | Firms shall be emailed when new matches appear for their clients. | 🟡 behind `CLIENT_NOTIFICATIONS_ENABLED` |

## FR-QUAL — Scoring and qualification

| ID | Requirement | Status |
|----|-------------|--------|
| FR-QUAL-1 | The system shall compute a win probability with a factor-by-factor explanation. | ✅ |
| FR-QUAL-2 | The system shall calibrate scores to a firm's own outcomes only when it beats the baseline. | ✅ |
| FR-QUAL-3 | The system shall show confidence intervals that widen with little data. | ✅ |
| FR-QUAL-4 | The system shall recommend BID_PRIME / BID_SUB / NO_BID. | ✅ |
| FR-QUAL-5 | Users shall move pursuits through pipeline stages with owners and next actions. | ✅ |
| FR-QUAL-6 | Users shall complete a weighted qualification scorecard (weights sum to 100). | ✅ |
| FR-QUAL-7 | Assigned reviewers shall approve/reject/request changes at gate reviews. | ✅ |
| FR-QUAL-8 | The system shall compute portfolio expected value. | ✅ |
| FR-QUAL-9 | Admins shall backtest the model against historical awards. | ✅ |
| FR-QUAL-10 | A numeric fit score shall be hidden until calibrated (3-band display instead). | 🟡 flag `SHOW_NUMERIC_FIT_SCORE` |

## FR-COMP — Compliance

| ID | Requirement | Status |
|----|-------------|--------|
| FR-COMP-1 | The system shall build a compliance matrix from solicitation documents. | ✅ 🔒 |
| FR-COMP-2 | The system shall map Section L to Section M. | ✅ |
| FR-COMP-3 | The system shall record amendments and their impacts for acknowledgement. | ✅ |
| FR-COMP-4 | The system shall track registration, certifications, insurance, bonding and alert before expiry. | ✅ |
| FR-COMP-5 | The system shall run pre-submission validation and list checks it cannot perform. | ✅ |
| FR-COMP-6 | The system shall provide a FAR/DFARS clause browser. | ✅ 🔒 |
| FR-COMP-7 | The system shall log every compliance status change. | ✅ |

## FR-PROP — Proposal, pricing, submission

| ID | Requirement | Status |
|----|-------------|--------|
| FR-PROP-1 | Users shall create a proposal with sections, writers, reviewers, versions and review rounds. | ✅ |
| FR-PROP-2 | The system shall generate AI outlines and drafts using proposal tokens. | ✅ 🔒 (needs an AI provider) |
| FR-PROP-3 | A human shall attest review of AI content before the final PDF is exported. | ✅ |
| FR-PROP-4 | Agents shall only quote approved capability narratives and resumes. | ✅ |
| FR-PROP-5 | Users shall build price scenarios with labor, indirect rates, ODCs, subs; submit for approval; benchmark vs. public awards; export PDF. | ✅ |
| FR-PROP-6 | Users shall run a submission checklist, mark ready, submit, and attach a confirmation. | ✅ |
| FR-PROP-7 | Users shall record the outcome of each submission. | ✅ |
| FR-PROP-8 | Users shall send proposals/pricing to clients for review. | ✅ |
| FR-PROP-9 | Firms shall share anonymised templates to a moderated cross-firm library. | ✅ |

## FR-TEAM — Teaming and partners

| ID | Requirement | Status |
|----|-------------|--------|
| FR-TEAM-1 | Users shall manage partners and teaming arrangements. | ✅ 🔒 |
| FR-TEAM-2 | The system shall recommend partners for capability gaps. | ✅ |
| FR-TEAM-3 | The system shall draft teaming agreements and outreach emails, never send them automatically. | ✅ |
| FR-TEAM-4 | Partners shall see only engagements they are granted; their edits go to review. | ✅ |
| FR-TEAM-5 | Users shall send NDAs/teaming agreements/subcontracts for e-signature. | 🟡 needs DocuSign connection |
| FR-TEAM-6 | Subcontracting notifications shall reach users by SMS and weekly email. | ⛔ in-app inbox only (SCW-5 v1) |

## FR-CON — Contracts and finance

| ID | Requirement | Status |
|----|-------------|--------|
| FR-CON-1 | Users shall create contracts (manually or from a won opportunity) with CLINs, options, modifications, deliverables. | ✅ |
| FR-CON-2 | The system shall compute contract and portfolio health. | ✅ |
| FR-CON-3 | Users shall manage budgets, resource allocations, purchase orders, subcontract invoices, flow-downs. | ✅ |
| FR-CON-4 | Employees shall enter time; managers approve; exports carry the approval trail (DCAA-ready). | ✅ |
| FR-CON-5 | The system shall draft invoices; humans approve/submit/record payments. | ✅ |
| FR-CON-6 | The system shall show receivables ageing, indirect-rate variance, cash-flow projection and an incurred-cost audit package. | ✅ |
| FR-CON-7 | The system shall export invoices to QuickBooks. | ✅ (Unanet/Deltek ⛔ stubs) |

## FR-CRM — Relationships

| ID | Requirement | Status |
|----|-------------|--------|
| FR-CRM-1 | Users shall manage agencies, offices, government contacts, partner contacts, activities and follow-ups. | ✅ |
| FR-CRM-2 | The system shall compute relationship strength (shows "no data" rather than "weak"). | ✅ |

## FR-AGT — AI agents

| ID | Requirement | Status |
|----|-------------|--------|
| FR-AGT-1 | The system shall run 9 domain agents on schedules and on business events. | ✅ |
| FR-AGT-2 | Agents shall be opt-in per firm. | 🟡 true for scheduled runs; **event-triggered runs currently start even if not enabled** (see status doc) |
| FR-AGT-3 | Agents shall never take a business action without a human. | ✅ (allowlists empty) |
| FR-AGT-4 | Agents shall raise deduplicated escalations that humans acknowledge/resolve/dismiss. | ✅ |
| FR-AGT-5 | Agent AI usage shall be capped per run, per schedule period and by plan. | ✅ |
| FR-AGT-6 | Users shall see run history, artifacts, token cost and audit trail for each run. | ✅ |
| FR-AGT-7 | Users shall set per-agent notification preferences. | ✅ |

## FR-INT — Intelligence and analytics

| ID | Requirement | Status |
|----|-------------|--------|
| FR-INT-1 | The system shall show trends, pipeline analysis, win/loss, portfolio health. | ✅ 🔒 |
| FR-INT-2 | The system shall show competition per NAICS and per agency. | ✅ 🔒 (BigQuery parts optional) |
| FR-INT-3 | The system shall email a weekly watchlist digest. | ✅ (needs BigQuery) |
| FR-INT-4 | The system shall guide tenants through federal platform/vehicle onboarding. | 🟡 flag off by default |
| FR-INT-5 | Agency View v2 per-agency panel. | 🟡 flag off by default |

## FR-API — Connections

| ID | Requirement | Status |
|----|-------------|--------|
| FR-API-1 | Firms shall create/revoke MCP and Public API tokens. | ✅ 🔒 |
| FR-API-2 | MCP servers shall expose 27 tools, tenant-scoped and audited, with OAuth 2.1 support. | ✅ |
| FR-API-3 | Public REST API v1 shall be read-only with scopes and an OpenAPI document. | ✅ |
| FR-API-4 | Firms shall connect calendars, Slack/Teams, QuickBooks, DocuSign. | ✅ |

## FR-UX — General user experience

| ID | Requirement | Status |
|----|-------------|--------|
| FR-UX-1 | In-app notifications with popups and polling. | ✅ |
| FR-UX-2 | Command palette, AI help assistant, onboarding wizard, demo data. | ✅ |
| FR-UX-3 | Installable web app; key approval screens usable at phone width. | ✅ |
| FR-UX-4 | White-label branding with subdomain and custom domain. | ✅ |
| FR-UX-5 | Firms shall export their audit log (CSV). | ✅ |
