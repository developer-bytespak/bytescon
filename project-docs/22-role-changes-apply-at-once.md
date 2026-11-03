# Fix: a demoted admin keeps admin powers for hours

**Bug:** B7 in [14-review-bugs-improvements-competitors.md](14-review-bugs-improvements-competitors.md)
**Opened:** 2026-11-04 · **Status:** ✅ **Done** (2026-11-04)

---

## 1. Findings

**Simple version:** when you sign in, the app gives your browser a pass that lasts 8 hours, and the pass says
what role you have. Most admin pages read the role **from that pass**. So if an admin was changed to Consultant,
their pass still said "Admin" until it expired. For up to 8 hours they could still change billing, API keys,
branding and other admin settings.

While fixing this, a second problem turned up. The pass could only be created for the **Admin** and
**Consultant** roles. The Team screen lets you give someone one of five other roles (BD/Capture, Proposal,
Contracts, Finance or Viewer), but that person then **couldn't sign in at all**.

**Technical version:**

| # | Finding | Evidence | Effect |
|---|---------|----------|--------|
| F1 | Role checks trust the token | `requireRole` and the ~90 other `req.user.role` reads use the role in the JWT, set at sign-in. `requireRole` is on ~230 routes. The 8-hour token is never re-checked for role | A demoted admin keeps admin powers until the token expires |
| F2 | A role change doesn't end sessions | `PUT /api/rbac/users/:id` (`backend/src/routes/rbac.ts`) updates the row only | The person's screens keep showing their old role |
| F3 | Granular roles can't sign in | `buildJwtPayload` (`backend/src/middleware/auth.ts`) threw "Unrecognized user role" for anything except ADMIN and CONSULTANT. Tests didn't catch it because test users get tokens minted directly | Anyone given BD_CAPTURE, PROPOSAL, CONTRACTS, FINANCE or VIEWER was locked out |

**Already correct:**
- `requirePermission` reads the role and extra permissions from the database on each request. Routes using it
  were never affected.
- Since B4, `authenticateJWT` already re-reads the account on each request, with a 30-second cache.

## 2. Plan

| Area | Change |
|------|--------|
| Every request | The B4 account check (`getUserStanding` in `backend/src/services/userStanding.ts`) now also returns the account's **current role**. `authenticateJWT` replaces the token's role with it, so `requireRole` and every `req.user.role` use the role the person holds now. Like B4, this doesn't depend on Redis |
| Role change | `PUT /api/rbac/users/:id` clears the cached check and, when the role changed, ends the person's sessions. They sign in again and see screens for their new role. Changing only extra permissions doesn't sign anyone out |
| Sign-in | `buildJwtPayload` accepts every internal role (`ROLES` in `permissions.ts`). Portal identities (`CLIENT`, `PARTNER`) are still refused |

## 3. Verification results (2026-11-04)

| Check | Result |
|-------|--------|
| New tests `backend/src/routes/rbac.roleChange.integration.test.ts` | ✅ 17/17 |
| Tests catch regressions | ✅ With the token's role trusted again, 3 tests failed. With the sign-out on role change removed, 1 failed. With the old two-role token builder restored, 6 failed. Code restored |
| Full backend suite | ✅ 4,393/4,393 |
| Type-check | ✅ clean. No frontend change |

**Live check in the running app** (real sign-in with password and Terms acceptance):

| Step | Result |
|------|--------|
| New admin signs in, opens an admin-only page (audit-log export) | ✅ 200 |
| Another admin changes them to Consultant | ✅ 200 |
| Their open session | ✅ **401 at once**, signed out |
| Redis sign-out record deleted (as free-plan Redis loses it), 31 s later, old admin token | ✅ Admin page **403**; the app sees them as **CONSULTANT** |
| Changed to Finance, then signs in | ✅ Signs in as **FINANCE** (was impossible before). Admin page 403 |

The test member was removed afterwards.

### How to test it yourself
1. Sign in as yourself in one browser and as a second admin in another, e.g. a private window.
2. In **Settings → Access → Team access**, change the second admin to **Consultant**.
3. In the other browser, click anything. They're signed out. When they sign back in, admin settings are gone.
4. Change someone to **Finance** and have them sign in. It works, and they see finance areas only.

### Known, not changed
- **Same-second sign-in:** if someone signs in during the very second their role is changed, that session isn't
  signed out (the cutoff is in whole seconds). Their new role still applies to every request, so they gain
  nothing.
- **Up to 30 seconds on other servers:** as with B4, another server instance can take up to 30 s to see the new
  role when Redis is down. On the same instance, and whenever Redis works, it's immediate.
- **Your own role:** an admin who changes their own role (when another admin exists) is signed out too.
