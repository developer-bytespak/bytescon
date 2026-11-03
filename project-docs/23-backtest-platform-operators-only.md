# Fix: any customer's admin could run the platform-wide model test

**Bug:** B8 in [14-review-bugs-improvements-competitors.md](14-review-bugs-improvements-competitors.md)
**Opened:** 2026-11-04 · **Status:** ✅ **Done** (2026-11-04)

---

## 1. Findings

**Simple version:** Bytescon has a behind-the-scenes "model test" that checks how well win scores predict real
awards and tunes the scoring curve. That curve is shared by **every** firm. The test area only checked "is this
person an admin of their own firm?". So any paying customer's admin could start a long test that uses the
platform's data allowance, see test runs started by other firms, and reload the scoring curve that all customers
use.

**Technical version:**

| # | Finding | Evidence | Effect |
|---|---------|----------|--------|
| F1 | Wrong gate on the whole area | `backend/src/routes/backtest.ts` used `requireRole('ADMIN')` (firm admin) on every route. The platform-operator gate `requirePlatformAdmin` already existed and is used for template approval and platform metrics | Any firm admin could reach it |
| F2 | Cross-firm data | `GET /runs` and `/runs/:id` list every firm's runs, with no firm filter (by design, the data is platform-wide); `/who-wins/status` shows the platform model | One customer could see another's activity |
| F3 | Global effect | `POST /calibration/refresh` reloads the scoring curve used for all firms; `POST /run` holds a server connection for 5–30 minutes | One customer could affect every customer and tie up the server |

The frontend never linked to these routes, so this was reachable only by calling the API directly.

## 2. Change

The whole `/api/admin/backtest` area now also requires `requirePlatformAdmin`: the person's email must be on the
`PLATFORM_ADMIN_EMAILS` list. If that list is empty, **nobody** can use it. That's the safe default, the same as
template approval.

**Owner action (part of T7):** set `PLATFORM_ADMIN_EMAILS` on Render to the Bytescon operators who should run
model tests, e.g. your own address. This is a different setting from `PLATFORM_ADMIN_EMAIL`, which is where alert
emails go.

## 3. Verification results (2026-11-04)

| Check | Result |
|-------|--------|
| New tests `backend/src/routes/backtest.platformAdmin.integration.test.ts` | ✅ 9/9: a firm admin is refused on all 6 routes; nobody gets in when the list is empty; an operator can read status and runs and refresh the curve |
| Tests catch regressions | ✅ With the new check removed, 7 of 9 failed. Code restored |
| Test app | Now mounts `/api/admin/backtest` like production, so these routes are covered |
| Full backend suite | ✅ 4,402/4,402. One earlier run had an unrelated one-off timing failure in `publicApiV1`; it passed alone and on the re-run |
| Type-check | ✅ clean. No frontend change |

While testing on purpose without the check, one small model test ran in the **test** database. It was deleted
afterwards; nothing else was written.

### How to check it yourself
Signed in as a firm admin whose email is **not** on `PLATFORM_ADMIN_EMAILS`, open
`/api/admin/backtest/calibration/status` on the API. It answers **403 "Platform administrator access required."**
With your email on the list, it answers 200.
