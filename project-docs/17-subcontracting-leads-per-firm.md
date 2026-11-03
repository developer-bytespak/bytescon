# Fix: subcontracting leads shared between firms

**Bug:** B5 in [14-review-bugs-improvements-competitors.md](14-review-bugs-improvements-competitors.md) (also R12d in [10-status-done-and-remaining.md](10-status-done-and-remaining.md))
**Opened:** 2026-11-03 · **Status:** ✅ **Done** (2026-11-03)

---

## 1. Findings

**Simple version:** subcontracting leads come from public lists (SUBNet and SAM.gov), so many firms see the same lead.
The database allowed each lead to exist only **once in the whole system**. The first firm whose sync found a lead
owned it. Every later firm's sync quietly *edited the first firm's copy* instead of getting its own, so those firms
never saw the lead.

**Technical version:**

| # | Finding | Evidence |
|---|---------|----------|
| F1 | `SubcontractOpportunity.externalId` is unique **globally** | `backend/prisma/schema.prisma`: `externalId String? @unique` |
| F2 | The sync upserts on that global key, so a second firm's sync **updates the first firm's row** (title, value, deadline, description). No row is created for the second firm | `backend/src/routes/subcontracting.ts:137` `upsert({ where: { externalId } … create: { consultingFirmId … } })` |
| F3 | The second firm's prime-contact record is then linked to the **first firm's** lead id, a cross-tenant reference | Same loop: `captureContact({ consultingFirmId, … opportunityId: saved.id })`, where `saved` is the other firm's row |
| F4 | The sync counts every upsert as "created", so the audit log reported leads the firm never received | `created++` after every upsert |
| F5 | No tests cover the sync | No test file for `routes/subcontracting.ts` |

**Who is affected:** every firm except the first to sync a given lead. Firms with similar NAICS codes see
overlapping leads, which is the normal case for a consultant platform. They get empty or partial lead lists.

**Not affected:**
- Lookups, saves, dismissals and deletes, which already filter by `consultingFirmId`.
- Manually added leads, which have no `externalId`.
- The nightly expiry purge, which is intentionally platform-wide.

## 2. Plan

| Area | Change |
|------|--------|
| Database | Replace the global unique on `externalId` with a per-firm unique `@@unique([consultingFirmId, externalId])`. Safe: the global rule means no firm can already hold duplicates. Manual leads have a null `externalId`, which Postgres never counts as a duplicate |
| Sync | Move the per-lead save into a small service function that upserts on `(consultingFirmId, externalId)`, so each firm gets and updates **its own** copy. The firm's own status (saved/dismissed) is never overwritten by a re-sync |
| Contacts | Contacts link only to the firm's own lead, which follows from the change above |
| Audit count | Report `created`, `updated` and `skipped` separately |

### How "nothing breaks" will be proven
1. **New tests (real test database):**
   - two firms syncing the same lead each get their own copy;
   - a re-sync updates only that firm's copy;
   - a re-sync keeps the firm's SAVED/DISMISSED status;
   - one firm's sync never changes another firm's row;
   - created and updated are counted correctly.
2. The full backend and frontend suites, type-check and lint stay green.
3. Production applies the migration at boot, and the API health check passes after deploy.

## 3. Progress log
- 2026-11-03: findings and plan recorded.
- 2026-11-03: **resolved.**
  - Migration `20261103130000_subcontract_lead_per_firm`.
  - New `backend/src/services/scw/subcontractLeads.ts` (`saveSyncedLead`), used by the sync.
  - The audit log now reports created, updated and skipped separately.

## 4. Verification results (2026-11-03)

| Check | Result |
|-------|--------|
| New tests `backend/src/services/scw/subcontractLeads.test.ts` (real test DB) | ✅ 4/4 |
| Tests catch the bug | ✅ With the old "one copy for everyone" behaviour put back on purpose, 3 of the 4 failed. Code restored |
| Full backend suite | ✅ 4,352/4,352 |
| Full frontend suite (Node 24) | ✅ 850/850 |
| Type-check (backend + frontend) | ✅ clean |
| Frontend lint | ✅ 0 errors, 237 warnings (limit 241) |

### How to test it yourself
1. Log in as an admin of firm A and open **Subcontracting → Sync**. Note a lead's title.
2. Log in as an admin of firm B (with the same NAICS codes) and sync. Firm B now sees that lead too.
3. Dismiss the lead in firm A and sync again in both firms. Firm A still shows it dismissed, and firm B still shows it
   open.
