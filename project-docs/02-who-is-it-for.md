# Who Bytescon Is For and How It Helps

## Simple version

Bytescon is for **people who help small businesses win government work**. It saves them time,
helps them choose the right jobs, keeps them out of rule trouble, and makes them look professional
to their clients.

---

## 1. Target audience

### Primary audience — GovCon consulting firms
Firms that provide "capture", proposal-writing, and compliance services to **many** small-business
government contractors at once. The landing page says it directly: *"Built for firms with many clients, not one."*

Why they fit:
- They manage several client companies, each with different skills (NAICS codes) and certifications.
- They need one workspace with **no data mixing** between clients.
- They want to show clients branded reports and a client portal.

### Secondary audience — individual small contractors
A single small business can sign up and treat itself as its one "client company".
(This is an inference from how the data model works, not a separately marketed plan.)

Typical small-business types the product is designed around:
- **SDVOSB** — Service-Disabled Veteran-Owned Small Business
- **WOSB** — Women-Owned Small Business
- **HUBZone** — businesses in historically underused areas
- **8(a)** — SBA's program for disadvantaged businesses
- General **small businesses** under SBA size rules

(See [11-glossary.md](11-glossary.md) for these words.)

### Other people who touch the system
| Person | How they use Bytescon |
|--------|-----------------------|
| Firm **Admin** | Sets up the firm, users, billing, integrations; makes final bid and submit decisions |
| **Consultant** (read-only role) | Views everything, edits notes |
| **BD / Capture** staff | Works the pipeline, CRM, partners |
| **Proposal** writers | Writes and approves proposal sections |
| **Contracts** staff | Manages awarded contracts, sends things for signature |
| **Finance** staff | Timesheets, invoices, indirect rates, audit readiness |
| **Viewer** / auditor | Read-only access |
| **Client company** | Uses the Client Portal: uploads documents, reviews proposals and deliverables, sees fees and rewards |
| **Partner / subcontractor** | Uses the Partner Portal: sees only the work it was invited to, submits deliverables and documents |
| **Platform operator** (Bytescon staff) | Moderates shared templates, watches margins and platform metrics |
| **AI assistants** (Claude, ChatGPT, etc.) | Connect through MCP or the Public API to ask questions like "Which SDVOSB bids close this week?" |

---

## 2. The market (from the landing page)

- **$179 billion** in federal prime contracts went to small businesses in FY2025.
- **28%** of every federal prime-contract dollar went to a small firm.
(Source cited on the site: SBA FY2025 scorecard.)

---

## 3. Their pain → how Bytescon helps

| Pain | Without Bytescon | With Bytescon |
|------|------------------|---------------|
| **Finding jobs** | Manually searching SAM.gov and dozens of state/city portals | Daily automatic pull from SAM.gov, Grants.gov, USAspending, state & city portals, E-Rate, and more — matched to each client's NAICS codes and certifications |
| **Choosing what to bid** | Gut feeling | A win-probability score with the reasons shown, calibrated to the firm's own past wins/losses, plus a Bid / Bid-as-sub / No-bid recommendation |
| **Following the rules** | Reading 200-page solicitations by hand | Auto-built compliance matrix (Section L & M, FAR/DFARS clauses), amendment tracking, document-expiry warnings, pre-submission checks |
| **Writing the proposal** | Weeks of drafting | AI outline and drafts from approved company material, review workflow, human attestation before final PDF |
| **Pricing** | Spreadsheets | Labor/indirect-rate pricing workspace, scenarios, and comparison against public award history |
| **Finding partners** | Phone calls and LinkedIn | Partner recommendations, prime-contractor directory, teaming agreement drafts, partner portal |
| **After the award** | Scattered spreadsheets | Contract health, deliverables, options, modifications, budgets, timesheets (DCAA-style), invoices, receivables, audit package |
| **Showing value to clients** | Emailed PDFs | Branded client portal, branded reports, custom domain |
| **Knowing what's working** | Hard to measure | Win/loss analytics, portfolio expected value, market and agency intelligence |

---

## 4. Why they would trust it

- **Shows its reasoning.** Scores explain which factors pushed them up or down.
- **Honest about uncertainty.** Shows confidence ranges; says "not enough data" instead of guessing.
- **Humans stay in charge.** AI never submits, signs, approves, or pays.
- **Data safety.** Tenant isolation, encryption of sensitive fields, MFA, SSO, full audit trail. The Trust page states *"we do not train AI models on your data."*
- **Works without AI keys.** Most agents are pure math and rules; only the drafting features need an AI provider.
