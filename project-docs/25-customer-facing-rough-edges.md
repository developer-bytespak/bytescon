# Fix: three rough edges customers could see

**Bugs:** B27, B28 and B14 in [14-review-bugs-improvements-competitors.md](14-review-bugs-improvements-competitors.md)
**Opened:** 2026-11-04 · **Status:** ✅ **Done** (2026-11-04)

---

## 1. Findings and changes

| Bug | What customers saw | Cause | Change |
|-----|--------------------|-------|--------|
| **B27** | The Feedback page said answers go into "the calibration backlog and the investor-pitch traction snapshot" | Internal wording in `frontend/src/pages/Feedback.tsx` | Now says: "Your answers help us decide what to improve next. Only the 0–10 score is required; everything else is optional." |
| **B28** | The Discovery page said SAM.gov "Requires a SAM.gov API key (firm setting or SAM_API_KEY)", while onboarding and Settings say no key is needed | `coverageNote` and the not-configured `reason` in `backend/src/services/discovery/adapters/samGovAdapter.ts` | Now says "Built in: no API key needed", with your own key as an option. Neither message names the internal setting |
| **B14** | Clicking a "Capability narrative" search result opened "page not found" | `sourceRoute` was `/capability-narratives` in `backend/src/services/knowledge/knowledgeSearch.ts`, which was never a page | Links to `/library/capability` |

**B28 was recorded slightly wrong.** The review blamed the Settings page and a banner. In fact Settings already
collapses this section and says "No key needed", and the banner stopped showing on 30 June 2026. The contradiction
that remained was the Discovery text above, so that's what was fixed. Settings is unchanged: adding your own key is
still a valid option.

## 2. Verification results (2026-11-04)

| Check | Result |
|-------|--------|
| New test `backend/src/services/knowledge/knowledgeRoutes.test.ts` | ✅ Every Knowledge search link is compared with the frontend's real routes and redirects, so a broken link fails the build |
| New test in `discovery/adapters/adapters.test.ts` | ✅ SAM.gov text says no key is needed and names no internal setting |
| New test `frontend/src/pages/Feedback.test.tsx` | ✅ No internal wording |
| Tests catch regressions | ✅ With the old code restored, 4 tests failed (3 backend, 1 frontend). Fix restored |
| Full suites | ✅ Backend 4,420/4,420; frontend 853/853 (Node 24) |
| Type-check, frontend lint | ✅ clean; 237 warnings (limit 241) |

**In a real browser (local app, signed in as admin):**

| Page | Result |
|------|--------|
| Feedback | ✅ Shows the new text |
| Discovery → SAM.gov card | ✅ Shows the new text |
| `/library/capability` | ✅ Opens the capability library |
| `/capability-narratives` (the old link) | Shows "Page not found", which confirms what customers hit |

The local firm has no narratives, so the link target and the old 404 were checked directly, not by clicking a real
search result. The route test covers the link itself.

## 3. Still to check or do

- **`SAM_API_KEY` on Render:** "Built in: no API key needed" is only true if the platform key is set in production.
  This wasn't verified here, because setting values aren't read. Without it, the SAM.gov source reports that its data
  isn't available.
- **B29 (new):** several Discovery source descriptions show customers an internal field name,
  `configJson.maxRecords`. Logged in doc 14 and doc 19.
