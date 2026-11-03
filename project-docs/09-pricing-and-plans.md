# Pricing and Plans

## Simple version

There is **one main plan** ($99/month). You can add **extra modules** like toppings on a pizza,
or buy **All Access** ($199/month) to get every topping. Early supporters can pay **once** ($2,500) and
use everything forever. Everyone gets **14 days free** with everything unlocked, no credit card.

Prices below come from the code (`backend/src/config/addons.ts`, `billingService.ts`) and the landing page. Live
prices are served from Stripe and can differ.

---

## Plans

| Plan | Monthly | Annual (per month) | Seats | Client companies | Includes |
|------|---------|--------------------|-------|------------------|----------|
| **Bytescon Core** | $99 | $84 | 3 | 5 | SAM.gov search, win-probability scoring, bid/no-bid engine, pursuit tracker, dashboard, 500 AI calls/month |
| **All Access** | $199 | $169 | 10 | Unlimited | Every add-on module, 50 proposal tokens/month, priority support |
| **Founders Lifetime** (20 slots) | $2,500 once | — | 10 | Unlimited | Everything forever, 200 tokens up front + 50/month |

- **Free trial:** 14 days, all modules, no card.
- **Veteran Owned & Operated:** 10% discount option in Settings.
- Retired plan names (personal, starter, professional, enterprise, elite) are kept only for history.

## Add-on modules

**How add-ons are billed:** add-ons are extra lines on the same subscription as the base plan, so the customer gets
**one invoice and one charge** a month. For example, Core $99 + Teaming $49 = $148.
- **Adding a module** in Billing shows today's charge (only the days left in the period), charges the card on file,
  and unlocks the module at once. A declined card changes nothing.
- **Removing a module** credits unused days on the next bill.
- **Billing cycle:** add-ons follow the plan's cycle; a yearly plan means yearly add-ons.
- **Details:** see [16-billing-one-subscription.md](16-billing-one-subscription.md).

| Module | Code name | Monthly | Annual (per month) | Tokens / month | Unlocks |
|--------|-----------|---------|--------------------|----------------|---------|
| Set-Aside Intelligence | `setaside_intel` | $29 | $25 | — | Set-aside scanner, eligibility, agency rates |
| Teaming & Subcontracting | `teaming_suite` | $49 | $42 | 5 | Teaming, subcontracting board, prime contacts, SCW workflow |
| Contract Analysis & Compliance | `contract_analysis` | $59 | $50 | 15 | Compliance matrix, FAR clauses, documents, contract upload, doc requirements, penalties |
| Proposal Studio | `proposal_studio` | $79 | $67 | 25 | AI proposal assist, templates, AI assistant |
| Market & Competitor Intelligence | `market_intel` | $39 | $33 | — | Analytics, market analytics, agency view, recipient lookup |
| Automated Daily Sync | `auto_sync` | $29 | $25 | — | Daily 6 AM SAM.gov sync |
| API & MCP Access | `api_access` | $49 | $42 | — | MCP and Public API tokens |
| Client Portal & Branded Reports | `client_portal` | $39 | $33 | — | Client portal, branded PDFs |
| State & Municipal Access | `state_municipal` | $49 | $42 | — | State/county/city bids (not shown in landing-page fallback list) |

## Proposal tokens

| Pack | Tokens | Price |
|------|--------|-------|
| `proposal_tokens_15` | 15 | $25 |
| `proposal_tokens_40` | 40 | $50 |
| `proposal_tokens_120` | 120 | $125 |

- An AI **outline** costs 1 token; a full **draft PDF** costs 5.
- Monthly grants top up to a maximum of 500. Bought tokens never expire and can go above 500.

## Who gets what (in order — first match wins)

1. Owner / demo account → everything
2. Lifetime access → everything
3. Founders Lifetime plan → everything
4. Active trial → everything
5. Active All Access → everything
6. Active Core → Core + bought add-ons
7. Otherwise → locked to Billing and Profile only
