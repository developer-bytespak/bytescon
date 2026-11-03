# Fix: team members can't be removed, and seats never free up

**Bug:** B4 in [14-review-bugs-improvements-competitors.md](14-review-bugs-improvements-competitors.md)
**Opened:** 2026-11-04 · **Status:** ✅ **Done** (2026-11-04)

---

## 1. Findings

**Simple version:** when someone leaves a consulting firm, the firm's admin has no way to remove them. Their login
keeps working, and they keep taking up one of the plan's paid seats. Core includes 3, so a firm with normal staff
turnover gets stuck at "all seats in use".

**Technical version:**

| # | Finding | Evidence | Effect |
|---|---------|----------|--------|
| F1 | No deactivate/remove action exists | `backend/src/routes/rbac.ts` has only `GET /users` and `PUT /users/:id`, which change the role or extra permissions. The Team screen (`frontend/src/components/integrations/AccessSettings.tsx`) can only change roles | A former employee keeps access to every client's contracts, proposals and pricing |
| F2 | Seat count includes everyone | `checkUserLimit` in `backend/src/middleware/tierGate.ts` counts all user rows, active or not | Seats never free up, so new staff can't be invited |
| F3 | Open sessions survive account changes | Sessions are signed tokens that last 8 hours. `authenticateJWT` (`backend/src/middleware/auth.ts`) never re-checks the user. The only revocation, a Redis cutoff, is used only by password reset, and it is skipped when Redis is down. Production Redis is on the free plan, which keeps no data | A deactivated user's open session would keep working for up to 8 hours |
| F5 | Adding a member directly skips the seat limit | `POST /api/auth/register-user` creates a user with no `checkUserLimit` check (only `/invite-user` had it) | Found while fixing; the plan's seat limit could be bypassed |
| F4 | The "accept Terms" step skips the active check | `POST /api/auth/complete-agreements` turns the short "accept the Terms first" token into a full session without checking the user is still active | A deactivated user holding that token could get a full session |

**Already correct:**
- Password login, SSO login and the MFA step refuse inactive users.
- Notification and email recipient lists already skip inactive users.
- The "last administrator" rule exists for role changes.

## 2. Plan

| Area | Change |
|------|--------|
| Remove a member | New admin actions `POST /api/rbac/users/:id/deactivate` and `/reactivate`. Rules: same firm only; an admin can't deactivate themselves; the last active admin can't be deactivated. Deactivation ends the person's sessions immediately and cancels their unused invite/reset links. Every change goes in the audit log |
| Bring a member back | Reactivating needs a free seat, so the plan limit can't be bypassed |
| Seats | Only **active** users count toward the plan's seat limit |
| Sessions | `authenticateJWT` also checks the user is still active, with a 30-second in-memory cache to keep it cheap. It doesn't depend on Redis, so deactivation applies within seconds even when Redis is down. The Redis cutoff is still set as well |
| Terms step | `complete-agreements` refuses inactive users |
| Team screen | Each member gets a **Deactivate** / **Reactivate** button with a confirm step. Deactivated members stay listed and are marked "Deactivated" |
| History | Deactivated users are **not deleted**, so their names stay on past audit entries, proposals and notes |

### How "nothing breaks" will be proven
1. **New tests:**
   - deactivation blocks the person's existing session and their login;
   - deactivation frees a seat;
   - reactivation needs a free seat;
   - an admin can't deactivate themselves;
   - the last admin can't be deactivated;
   - another firm's user can't be touched;
   - non-admins can't use these actions;
   - the Terms step refuses inactive users.
2. The full backend and frontend suites, type-check and lint stay green.
3. **Live check in the running app:**
   - invite up to the seat limit;
   - deactivate a member: their open session stops working at once, and a new invite fits;
   - reactivate: blocked when the plan is full.

## 3. Progress log
- 2026-11-04: findings and plan recorded.
- 2026-11-04: **resolved.**
  - New service `backend/src/services/userStanding.ts`.
  - `authenticateJWT` re-checks the account on every request (with a 30 s cache).
  - New `POST /api/rbac/users/:id/deactivate` and `/reactivate`.
  - The seat count only includes active users.
  - `register-user` now enforces seats (F5).
  - `complete-agreements` checks the account first.
  - Re-inviting a deactivated member points the admin to Reactivate.
  - Deactivate/Reactivate buttons in Settings → Access.

## 4. Verification results (2026-11-04)

| Check | Result |
|-------|--------|
| New backend tests `backend/src/routes/rbac.deactivate.integration.test.ts` | ✅ 9/9 |
| Tests catch regressions | ✅ With the session re-check and the active-only seat count removed on purpose, 3 tests failed. This also showed that the Terms-step check was being skipped behind a version check; it was moved first and now blocks on its own. Code restored |
| Two existing security tests | ✅ Updated: a forged or deactivated token is now refused at sign-in (401) instead of at the permission check (403). Still refused |
| New frontend tests (`AccessSettings.test.tsx`) | ✅ 7/7. Buttons shown, the admin's own row has none, cancelling the confirm does nothing |
| Full backend suite | ✅ 4,366/4,366 |
| Full frontend suite (Node 24) | ✅ 852/852 |
| Type-check, frontend lint | ✅ clean; 237 warnings (limit 241) |

**Live check in the running app** (3-seat Core firm: admin + 2 members):

| Step | Result |
|------|--------|
| Member's open session | ✅ 200 |
| Add a 4th member with all 3 seats used | ✅ Refused (`TIER_LIMIT`) |
| Deactivate the member | ✅ 200 |
| Same, still-unexpired session | ✅ **401 at once**; password login 401 |
| Redis revocation key deleted (as free-plan Redis loses it), 31 s later | ✅ Still 401 |
| Add a member now | ✅ Created (seat freed) |
| Reactivate the deactivated member while full | ✅ Refused (`TIER_LIMIT`) |
| Admin deactivates themselves | ✅ Refused (422) |
| Team list | ✅ Shows the member as deactivated |

### How to test it yourself
1. Go to **Settings → Access → Team access**. Each member except you has a **Deactivate** button.
2. Deactivate a member who is signed in somewhere else. Their next click signs them out.
3. Invite someone new. The freed seat makes room.
4. Click **Reactivate** on the deactivated member. If the plan is full, you're told to free a seat or upgrade.

### Known, not changed
- **Firm-wide API/MCP tokens:** tokens a person created stay valid after they're deactivated, because they belong to
  the firm, not the person. Revoke them under Settings → Integrations if needed.
- **Up to 30 seconds on other servers:** on a server instance other than the one that handled the deactivation, it
  can take up to 30 s to apply when Redis is down (in-memory cache). On the same instance, and whenever Redis works,
  it's immediate.

