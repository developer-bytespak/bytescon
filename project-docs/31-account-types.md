# 31 — Account types: consulting firm and contractor

Who this is for: founders and developers. It covers the two kinds of account, what each one can see and do, how a contractor's own company is scored, the demo, and how to check it.

Code wins if it disagrees with this page. Main places: `backend/src/services/contractorAccount.ts`, `backend/prisma/schema.prisma` (`AccountType`, `ClientCompany.isSelf`), `frontend/src/hooks/useAuth.tsx` (`useIsContractor`).

---

## 1. The two types

| | Consulting firm (`CONSULTING`) | Contractor (`CONTRACTOR`) |
|---|---|---|
| Who | A firm that helps client companies win contracts | A company that bids for itself, such as a tier-3 subcontractor |
| Clients | Adds and manages client companies | None. Its own company is the one thing scored |
| Client portal | Yes (add-on) | No |
| Users' access | Set by each user's role ([22](22-role-changes-apply-at-once.md)) | The same roles; the first user is ADMIN |
| Default | Yes. Every account made before this change is a consulting firm | Chosen at sign-up or by a demo operator |

The type is stored on the firm (`ConsultingFirm.accountType`), returned in the sign-in session and the profile, and read in the app through `useIsContractor()`.

## 2. How a contractor is scored

Win probability, bid/no-bid decisions, submissions and several reports are worked out for a client company. So a contractor account keeps one hidden client record for **its own company** (`ClientCompany.isSelf = true`):

- It is created with the firm at sign-up.
- It follows the firm's **Registration & Compliance** details: NAICS codes, UEI, CAGE, SAM status and expiry, and set-asides (from the profile and from active certifications). Saving the profile or adding, editing or archiving a certification updates it (`syncSelfClient`).
- If there is no profile yet, it keeps what it has rather than being blanked.

Everything client-based then works unchanged: the opportunity page scores "your company" without a client picker, and marking a bid submitted or logging a submission needs no client choice.

## 3. What a contractor doesn't see

Refused by the server (`requireConsultingAccount`), whatever the screen shows:

- adding, importing, editing, archiving or deleting clients;
- creating client-portal logins;
- sending a proposal or price volume to a client for review;
- buying the Client Portal add-on.

Client-match emails are never sent to a contractor account.

Hidden in the app:

- menu and search: Clients, Doc Requirements, Rewards (the section is headed **Relationships**); their pages redirect to the dashboard;
- client portal links in the sidebar and account menu, and the portal domain in Settings;
- the dashboard's Active Clients card and client mix, Billing's client meter, Settings' Total Clients;
- the client filter on Bid Decisions, template assignment to clients, the top-client-dependency card in Analytics;
- the client review panels on proposal and pricing pages;
- in plan descriptions, client-company limits and "Client Portal" (`frontend/src/lib/contractorWording.ts`).

Onboarding asks a contractor to **Complete Your Registration** instead of **Add Your Clients**. Sign-up asks for the account type; the name field and side panel follow the choice.

## 4. Demo accounts

On the demo site there is no public sign-up, so operators choose the type on `/demo-admin` ([28](28-demo-version.md)):

- **Account type** on the create form, Consulting firm by default.
- A contractor demo account gets one own-company record and a matching registration profile (SAM active, the business type's NAICS codes, SDVOSB). Its sample bids, past performance, contract and proposals are all its own. It has no sample clients or client document requests.
- Each account in the list has an **Account type** dropdown to switch it:
  - **to Contractor:** its clients are archived, not deleted, and listed in the audit record. The own-company record is created, with a registration profile started from the first client if there is none.
  - **to Consulting firm:** the own-company record is archived and the clients the last switch archived are restored. A client archived before the switch stays archived.
- A signed-in user picks up a change on their next page load, without signing in again (the app re-reads the type from the profile once per load).

The demo tour's wording still talks about clients; it was left unchanged on purpose.

Changing the type of a non-demo account isn't offered yet (`changeAccountType` exists for when it is).

## 5. Checking it

- Tests: `services/contractorAccount.test.ts`, `routes/contractorAccount.integration.test.ts`, the account-type block in `routes/demo.integration.test.ts`, and on the frontend `ConsultingOnly.test.tsx`, `Register.accountType.test.tsx`, `CommandPalette.test.tsx`, `demo/demo.test.tsx`, `lib/contractorWording.test.ts`.
- Checked by hand on 2026-11-11, locally, for both types:
  - sign-up through to a logged submission, by API (53 checks);
  - every main page in the browser, with no errors and no client features for a contractor;
  - Demo Admin: create, switch and switch back;
  - the client review panels shown to a consulting firm and hidden from a contractor.
