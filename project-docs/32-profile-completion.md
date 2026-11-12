# 32 — Complete your profile first

Who this is for: founders and developers. It covers what a complete company profile is, what is blocked until a profile is complete, where each field is filled in, and how it was checked.

Code wins if it disagrees with this page. Main places: `backend/src/services/profileCompleteness.ts` (the rule), `backend/src/services/profileGate.ts` (the block), `backend/src/routes/profile.ts` (status and My Company), `frontend/src/components/ProfileCompletionCard.tsx`, `frontend/src/components/ProfileIncompleteModal.tsx`, `frontend/src/pages/MyCompany.tsx`.

---

## 1. Whose profile

- **Contractor:** its own company (the hidden own-company record, [31](31-account-types.md)), edited on **My Company**.
- **Consulting firm:** each client, edited on the client's page. A client with an incomplete profile is blocked; complete clients work as normal.

## 2. What "complete" means

Required (all seven):

A contractor fills in everything on **My Company**. Its registration details (name, UEI, CAGE, NAICS, SAM status and expiry, set-asides) are saved to the registration profile, so Registration & Compliance shows the same values and can edit them too; there is one copy of each.

| Field | Contractor fills it in | Consulting firm fills it in |
|---|---|---|
| Company name | My Company (set at sign-up) | Client page |
| State (address) | My Company | Client page → Edit profile |
| NAICS codes | My Company | Client page |
| UEI | My Company | Client page → Edit profile |
| SAM.gov registration status | My Company | Client page → Edit profile |
| Small-business and set-aside status | My Company (saving it confirms) | Client page → Edit profile (saving confirms) |
| Capability keywords | My Company | Client page → Qualifications |

The % complete counts the seven required fields only, so a complete profile is 100%. Optional fields never block anything and are listed separately once the profile is complete ("Optional details: n of 14 added", `optional` in the status): past-performance projects, street, city, ZIP, phone, website, CAGE, PSC codes, contract vehicles, employee count, average annual revenue (`ClientCompany.annualRevenue`, new), security clearances, ISO certifications, logo (a contractor's logo is uploaded on My Company and is also the firm's branding logo).

**Past performance is optional** (changed 2026-11-13). A company with no projects yet, such as a new firm or a client the firm has only just taken on, can still be scored and written for. Projects still help: the scorecard's past-performance criterion and proposals use them.

Set-aside status needs an explicit answer (`ClientCompany.setAsideStatusConfirmedAt`, new): the yes/no flags have defaults, so a default can't be told apart from an answer.

### Capability keywords: what reads them

The company's own words for its work (e.g. "structured cabling, fiber optic installation"), beyond NAICS and PSC codes.

- **Score** (`engines/probabilityEngine.ts`, `matchCapabilityKeywords`): a keyword counts when every word in it appears in the opportunity's title or description, ignoring case, punctuation and a plural "s". Each match adds 0.1, up to 0.2, to the "NAICS / domain match" factor, never past 1. Words under 3 letters and generic words ("services", "support", "management"…) are skipped, so "IT services" never matches on its own. Applied through `buildScoringInputs`, so the stored score and the bid decision agree. The matcher pre-filter and client match emails still use NAICS only.
- **Proposal draft** (`proposalDraftService.ts`): listed in the OFFEROR PROFILE block as "Core capabilities".
- **Document analysis** (`documentAnalysis.ts`): sent as "Client capabilities", and the AI's alignment score is judged against the client's NAICS, certifications and capabilities.

## 3. What is blocked until then

The server refuses these with **422 `PROFILE_INCOMPLETE`**, carrying the missing fields in `details`:

| Action | Route |
|---|---|
| Win-probability scoring | `POST /api/opportunities/:id/score` |
| Bid / no-bid | `POST /api/decision/run`, `/run-all`, `/run-all-async` |
| Compliance matrix and bid guidance | `POST /api/compliance-matrix/:id/generate`, `/bid-guidance`, `/refresh`, `/re-extract` |
| Proposal outline, questions and draft | `POST /api/proposal-assist/:id/outline`, `/questions`, `/draft`; `POST /api/proposal/:id/outline`, `/sections/:id/draft` |
| Document AI analysis, amendment interpretation | `POST /api/jobs/analyze/:documentId`; `POST /api/opportunities/:id/amendments/:id/interpret` |

Which profile is checked: the client the action names; else a contractor's own company; else (a consulting firm) at least one client must be complete.

Background scoring (`scoringWorker`, `enrichmentWorker`, the portfolio engine) skips incomplete profiles, so their scores don't appear until the profile is done.

A contractor's proposals now use its own company as the offeror (UEI, NAICS, set-asides, location) rather than the account name alone.

### Scoring once the profile is complete

Background scoring skips an incomplete profile, so opportunities that arrive first stay unscored. When a save turns a profile complete, `middleware/rescoreOnProfileComplete.ts` queues every unscored opportunity for scoring straight away (`enqueueAllOpportunitiesForScoring`), instead of waiting for the next opportunity sync. It is mounted on the My Company, clients, registration and both past-performance routers, and only acts on saves.

## 4. On screen

- **Card on every page** until complete: a contractor's % and missing items, or a consulting firm's incomplete clients, each linked to where it's filled in. Gone once everything is complete.
- **"Complete your profile first" dialog** whenever the server refuses an action, listing what's missing.
- **My Company** (contractors, in the menu under Relationships): registration fields read-only with links, the rest editable.
- **Client page:** a completeness panel; the edit form gains SAM.gov status and average annual revenue. **Clients list:** a "Profile n% · incomplete" or "Profile complete" badge.
- Profile status is re-checked after every successful save in the app.

## 5. Accounts an admin creates start complete

When an admin creates the company, the admin enters the core profile there and then, so it works from the first sign-in. The client can edit it afterwards like any other profile.

- **A consulting firm adding a client** (Clients → Add Client): the form requires the company name, state, NAICS codes, UEI (12 letters or digits), SAM.gov status, capability keywords and the set-aside answers. `POST /api/clients` refuses a client without them (`newProfileProblems` in `profileCompleteness.ts`). The **CSV import** still accepts rows with a name only; those clients are marked incomplete and blocked until completed.
- **Demo Admin** (`POST /api/demo/accounts`, `profile` required): the operator enters the UEI, NAICS codes, SAM.gov status, capability keywords, set-asides and (optionally) city; the state is the account's state.
  - **Contractor:** this is its own company and its registration profile.
  - **Consulting firm:** this is the **first client**, named in the form, beside two invented sample clients.
  - The invented sample work (past bids, past-performance projects, proposals) is still added, so every feature has something to show.

### Where links send people

A contractor edits its whole profile, registration details included, on **My Company**; Registration & Compliance shows the same registration and also holds certification records, insurance and bonding. So:
- **"Can I bid on this?"** links each check to where it is fixed. For a contractor: SAM and NAICS go to My Company; set-aside certifications and bonding go to Registration & Compliance. For a client: its page, except bonding, which is the firm's.
- **The 0% score warning** and the contractor's welcome step point to My Company.
- **Library → "Referenced from"** links registration, certification and insurance sources to Registration & Compliance, and past performance to its library; proposals and submissions are named without a link.
- **Demo sample certifications** for a contractor match the set-asides the operator ticked (plus a sample ISO 9001), so the records never claim a set-aside the company doesn't have.

## 6. Existing accounts

The rule applies to every account. A data migration (`20261111191321_client_profile_completion`) fills the missing core fields on demo and operator accounts' sample clients so the demo keeps working; new demo accounts are created complete. Real accounts are not changed: their users complete their profiles, and until then the actions in §3 are refused.

## 7. Checking it

- Tests: `profileCompleteness.test.ts`, `routes/profileGate.integration.test.ts` (adding a client), `routes/demo.integration.test.ts` ("the operator enters the company profile"), `portfolioDecisionEngine.test.ts`, `proposal.test.ts`; frontend `ProfileCompletion.test.tsx`, `MyCompany.test.tsx`, `Clients.test.tsx`, `demo/demo.test.tsx`. Test helpers `createCompleteClient()` and `CORE_CLIENT_PROFILE` in `test-utils/testClient.ts`.
- Checked by hand on 2026-11-12, locally (when past performance was still required):
  - **Contractor:**
    - a new account showed the card at 5%;
    - Run Analysis showed the dialog with 7 items;
    - after filling My Company, Registration and one past-performance project, the card disappeared;
    - Run Analysis then scored 90%.
  - **Consulting firm:**
    - a client at 10% showed the card and the panel;
    - the edit form saved SAM status, UEI, state and revenue;
    - with keywords and a project added, scoring went from 422 to 200.
