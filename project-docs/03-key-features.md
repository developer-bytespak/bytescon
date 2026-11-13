# Key Features

Each feature has a **simple version** (for anyone) and **details** (what exactly is in the product).
Features marked 🔒 need a paid add-on (see [09-pricing-and-plans.md](09-pricing-and-plans.md)).

The product follows one loop, as the landing page says: **Discover → Qualify → Comply → Propose → Perform**,
and every win or loss teaches the system for next time.

---

## 1. Discover — find the right jobs

**Simple:** Every morning, Bytescon looks at government job boards and shows each client only the jobs that fit them.

**Details**
- Federal opportunities from **SAM.gov**, refreshed hourly (source sync) and daily (6 AM sync per firm).
- Other sources: **Grants.gov**, agency **forecasts**, **USAspending** award history, **FPDS**, **SBA SUBNet** subcontracting board,
  **USAC E-Rate & Rural Health Care** (civilian programs), and US state/city/county portals
  (NYC City Record, LA RAMP, Delaware Bids, Montgomery County MD, TxDOT, Socrata feeds, plus scrapers for NY, TX, FL, VA, GA, NC, OH, IL, CA, MD, PA).
- **Matching** against each client's NAICS codes, capabilities, set-aside certifications.
- **Saved searches** ("monitoring profiles") with alerts.
- **Re-compete detection** — spots contracts likely to be re-bid soon.
- **Forecast linking** — connects early agency forecasts to the solicitation when it appears.
- Full solicitation text enrichment from SAM.gov (module "GB-107").
- 🔒 **State & Municipal** opportunities (add-on `state_municipal`).
- **Civilian & Commercial** hub for non-SAM bids.
- **Grants** pipeline with SF-424 checklist (filing itself happens on Grants.gov).
- **Recipient profile** — look up any company by its UEI.
- CSV export of opportunities.

## 2. Qualify — decide whether to bid

**Simple:** Bytescon tells you your chance of winning and whether to bid, and shows its homework.

**Details**
- **Win probability** from a 9-factor engine (NAICS overlap, incumbent weakness, document alignment, agency alignment, award-size fit, competition density, agency history, deadline urgency, …).
- **Calibration**: adjusts scores using the firm's own verified outcomes (only if it proves better on held-out data); otherwise uses a platform-wide curve. Shows confidence ranges.
- **"Who Wins" model** trained on public award data for segment priors.
- **Three-layer decision**: eligibility gate → fit score → market score → **BID_PRIME / BID_SUB / NO_BID**.
- **Pipeline** (kanban): Identified → Qualification → Capture → Proposal → Submitted → Awarded/Lost/No-bid.
- **Qualification scorecard** with firm-configurable weighted criteria.
- **Gate reviews** — formal go/no-go approvals by an assigned reviewer.
- **Portfolio value** — expected value of the whole pipeline.
- **Capture evidence** — incumbent and competitor evidence from award history.
- 🔒 **Set-Aside Intelligence** — set-aside scanner, eligibility per client, agency set-aside rates.
- **ROI calculator** for a bid.
- **Model backtest** (admin) — tests the scoring model against real historical winners.

## 3. Comply — follow every rule

**Simple:** Bytescon reads the rules for you, makes a checklist, and warns you before you miss something.

**Details**
- 🔒 **Compliance matrix** — requirements extracted from the solicitation; Section L (instructions) & Section M (evaluation) mapping; verify/assign/link to proposal sections.
- 🔒 **FAR/DFARS clause browser** and clause obligations.
- **Amendment tracking** — what changed and what it affects.
- **Registration tracking** — SAM registration, certifications, insurance, bonding, with expiry alerts.
- **Standing document library** with versions and expiry vs. period of performance.
- **Pre-submission validation** — automatic checks plus a list of checks the platform *cannot* do (so humans do them).
- 🔒 **Document requirements** for client companies with deadlines, and **penalties** for late client submissions.
- **Compliance log** — audit history of every compliance change.

## 4. Propose — write and price the bid

**Simple:** The AI writes a first draft from your approved material, people review it, and a human signs off before the final PDF.

**Details**
- **Proposal workspace** — sections, writers, reviewers, versions, review rounds ("colour teams"), responsibility matrix, PDF export, send to client for review.
- 🔒 **Proposal Studio** — AI outline, questions, drafts, form extraction; costs "proposal tokens" (outline = 1, full draft PDF = 5).
- **Human attestation** required before the final PDF can be exported.
- **Capability library** — reusable narratives; agents may only quote **approved** text.
- **Past-performance library** — records, relevance scoring per opportunity, AI tailoring.
- **Personnel library** — resumes (approved only) and key personnel per proposal.
- **Pricing workspace** — labor categories, hours, fringe/overhead/G&A, other costs, subs, scenarios, review/approval, benchmark against public awards, PDF. **Use my rates** starts a scenario from the firm's own records (latest final actual indirect rates in Finance; labour, rates and fee from the last approved price elsewhere — never invented, only what's missing; `services/pricingStartingPoint.ts`). The benchmark shows the range of comparable awards (25th–75th percentile, median) before anything is priced, as a target.
- **Submission workspace** — auto checklist, readiness, submit/confirm with receipt.
- **Submission ledger** — record outcome (Won/Lost/No award/Withdrawn); feeds learning.
- 🔒 **Templates** and a cross-firm, anonymised **Template Library** (moderated).
- **Winners Intel** (optional) — public award patterns fed into proposal prompts.

## 5. Team up — partners and subcontracting

**Simple:** Bytescon suggests good partner companies and gives them a safe window to share their part of the work.

**Details**
- 🔒 **Teaming** — partner list, teaming graph, recommendations per opportunity, AI teaming-agreement drafts.
- 🔒 **Subcontracting** board and **prime contacts** directory.
- 🔒 **Subcontracting workflow** — likely primes per opportunity, AI outreach email drafts (approval does **not** send).
- **Partner portal** — invite-only; partners see only granted engagements; submissions go to review queues.
- **E-signatures** — NDA, teaming agreement, subcontract via DocuSign (needs a connected provider; sending needs a special permission).
- **CRM ("Relationships")** — agencies, government contacts, partner contacts, activities, follow-ups, relationship strength.

## 6. Perform — after you win

**Simple:** Bytescon keeps the diary and the money book for the contract so nothing is late and audits go smoothly.

**Details**
- **Contracts** — CLINs, option periods, modifications, deliverables workflow, health score per contract and portfolio.
- **ERP-style tools** — budgets, budget-vs-actual, resource allocation and capacity, purchase orders with approvals, subcontract invoices, flow-down clauses.
- **Finance** — timekeeping built for DCAA audits, invoices (draft → approve → submit → paid), payments, follow-ups, receivables ageing, indirect rates (provisional vs actual), cash-flow projection, incurred-cost audit package.
- **Milestones & calendar** — working-backwards schedules, holiday calendars, `.ics` calendar feed, escalating reminders.

## 7. Intelligence — learn and improve

**Simple:** Bytescon shows where you win, where you lose, and what the market is doing.

**Details**
- 🔒 **Analytics** — trends, pipeline analysis, predictions, portfolio health.
- 🔒 **Market & competitor intelligence** — competition per NAICS, agency profiles, contractor lookups, watchlist digests (BigQuery optional).
- 🔒 **Agency View** — spend, top NAICS/PSC, primes and subs per agency, AI outreach draft.
- **Win/loss analysis**, capture focus, capability roadmap (Intelligence agent).
- **Platform onboarding** (GB-106, behind a flag) — step-by-step path onto federal platforms and contract vehicles.

## 8. The 9 AI agents

**Simple:** Nine little robot helpers check different things on a timer and tell a person when something needs a decision.

See [08-ai-agents.md](08-ai-agents.md).

## 9. Clients, portals and branding

- **Client management** — profiles, NAICS, certifications, CSV import, archive/restore.
- 🔒 **Client portal** — clients upload documents, review proposals/deliverables, see matched contracts, fees, rewards.
- **White-label branding** — logo, colours, subdomain, verified custom domain, branded emails and PDFs.
- **Rewards** — compliance incentives for client companies.

## 10. Connect other tools

- 🔒 **MCP access** — connect Claude (and guides for ChatGPT, Gemini, Perplexity) to 27 read-mostly tools.
- 🔒 **Public REST API v1** — read-only with scoped tokens and an OpenAPI spec.
- **Integrations** — QuickBooks (working), Unanet and Deltek (stubs), Google/Microsoft calendar, Slack, Microsoft Teams, DocuSign.
- **SSO** (OIDC) and **MFA** (authenticator app).

## 11. Everyday helpers

- Floating **"Bytescon AI" assistant** chat.
- **Command palette** (Ctrl/Cmd + K) to jump anywhere.
- **Notifications** inbox with popups.
- **Onboarding wizard** and tutorials; **"Load demo"** button that creates 8 sample opportunities.
- **Installable on phones** (PWA); approval screens work at phone width.
- **NPS feedback** form.
