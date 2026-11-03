# Billing fix: one subscription, one monthly charge

**Bug:** B3 in [14-review-bugs-improvements-competitors.md](14-review-bugs-improvements-competitors.md), where one failed add-on payment locks the whole account
**Opened:** 2026-11-03 · **Status:** ✅ **Done** (2026-11-03). Code and automated tests are complete. The live Stripe test-mode run is still pending a test key (see step 3 below and owner to-do T2)
**Decision (owner, 2026-11-03):** base plan and add-ons are billed together as **one Stripe subscription and one
charge**. No customer is paying yet and the product is not live, so the old separate add-on subscriptions are
removed rather than migrated.

---

## 1. Findings

### How billing worked
- **Base plan:** $99/mo, or All Access at $199/mo, which includes every add-on. One Stripe subscription.
- **Add-ons:** $29–$79/mo each, and **each one was its own Stripe subscription** with its own checkout page and its
  own card charge every month.
  - Code: `createAddonSubscriptionCheckoutSession` in `backend/src/services/stripeService.ts`.
- **Free full access:** Lifetime, free-trial and owner/demo firms get every add-on at no cost
  (`entitlementService.ts`). In practice, only $99 base customers buy add-ons.
- **How features are unlocked:** an add-on's features open when its slug is in `ConsultingFirm.purchasedAddons`,
  checked by `requireAddon(slug)`. `AddonSubscription` records each add-on's Stripe status.

### Problems found

| # | Problem | Evidence | Effect |
|---|---------|----------|--------|
| F1 | **One failed add-on payment locks the whole account** | `handleInvoicePaymentFailed` marks *every* subscription of the firm `PAST_DUE` with no check of which invoice failed (`stripeService.ts`, ~line 1187) | A $29 add-on decline blocks the $99 plan the customer paid for (HTTP 402 everywhere) |
| F2 | **Paying the add-on afterwards doesn't unlock the account** | `handleInvoicePaymentSucceeded` only restores when the paid invoice belongs to the *plan* subscription | The firm stays locked until the next monthly base renewal, up to a month |
| F3 | **Possible silent break from Stripe's newer API format** | The Stripe library pins API `2026-03-25.dahlia`. Since 2025-03 Stripe moved `invoice.subscription` to `invoice.parent.subscription_details.subscription`, and `subscription.current_period_end` to each subscription item. The code reads only the old fields | If the webhook endpoint uses a recent API version, successful payments never unlock a past-due account and renewal dates are guessed (always "now + 31 days") |
| F4 | **Add-ons can be bought without a base plan** | The add-on checkout never checks for an active base plan | The customer pays for a module they can't open (`requireActiveBase` blocks every page) |
| F5 | **Several charges a month** | One Stripe subscription per add-on | A messier bill, and the conditions for F1 and F2 |

## 2. Plan

### Target behaviour
- **One subscription:** a firm has one Stripe subscription. The base plan is one line, and each add-on is another line.
  There is one invoice and one charge a month. For example, $99 + $29 = **$128**.
- **Adding an add-on** happens in-app with the card already on file, with no Stripe checkout page:
  - the customer sees the price and today's charge (only the days left in the period);
  - they confirm;
  - the charge runs, and access unlocks immediately.

  If the card declines, **nothing changes**: no add-on is added, the account isn't locked, and the customer sees a
  clear error.
- **Cancelling an add-on** removes its line. Credit for unused days goes on the next bill, and the base plan is
  untouched.
- **Add-ons follow the base plan's billing cycle.** A yearly base means yearly add-ons, because Stripe requires every
  line of a subscription to share one cycle.
- **Locking:** only a failed *renewal or sign-up* payment of the subscription locks the account, which is fair
  because then nothing was paid. A failed add-on top-up charge never locks it.
- **Upgrading to All Access** ends the old subscription (with credit); its add-on lines go with it, and every module
  is included.
- **Lifetime, trial and owner firms:** unchanged. They already have every module.

### Changes

| Area | Change |
|------|--------|
| Database | `AddonSubscription`: the Stripe subscription id is no longer unique, because several add-ons share it. Add a unique `stripeSubscriptionItemId` for the add-on's line. Migration via `prisma migrate dev` |
| Stripe products | Each add-on gets a fixed Stripe product id (`bytescon_addon_<slug>`), created automatically the first time it's needed. Prices stay in code |
| Add-on purchase | `POST /api/billing/stripe/checkout/addon` adds a line to the firm's plan subscription. Stripe charges the remaining-days amount immediately, and the change is refused if payment fails. Requires an active paid base plan |
| Price preview | New `GET /api/billing/addons/:slug/preview` returns today's charge and the new monthly total for the confirm dialog |
| Add-on cancel | `DELETE /api/addons/:slug/cancel` removes the line, with a credit on the next bill |
| Webhooks | Every update to the plan subscription re-syncs add-on rows and `purchasedAddons` from its lines. A deleted subscription cancels its add-on rows. Old-style separate add-on events are logged and ignored, so they can never touch the plan |
| Payment failed | Lock only when the invoice belongs to the firm's current plan subscription and is not an add-on top-up |
| Payment succeeded | Unlock when the invoice belongs to the plan subscription |
| Stripe API format | Read both the old and new field locations for the invoice's subscription id and the period end (F3) |
| Removed | Separate add-on checkout, the separate add-on webhook handler, and the All Access sweep of separate add-on subscriptions |
| Billing page | "Add" opens a confirm dialog with the preview, then unlocks without leaving the page. The add-on's own cycle choice is removed |

### How "nothing breaks" will be proven
1. **Automated tests (real test database, fake Stripe)** for these scenarios:
   - buying an add-on (access unlocks, it's tracked, monthly tokens are granted);
   - a buy blocked without a base plan;
   - a declined add-on charge (nothing changes, no lock);
   - cancelling (access removed, the base plan keeps working);
   - a renewal failure, then payment: locks, then unlocks;
   - a failed add-on top-up invoice: no lock;
   - an invoice in the new Stripe format;
   - an upgrade to All Access;
   - subscription deletion;
   - old-style event ignored;
   - duplicate webhook delivery;
   - yearly cycle.
2. **The existing suites stay green:** entitlements, the add-on gates (`requireAddon` / `requireActiveBase`) and webhook
   idempotency, plus the full backend and frontend suites, type-check and lint.
3. **A real end-to-end run in Stripe test mode** with fake cards and the Stripe CLI, once a test secret key is in the
   local `backend/.env`. Until then this step is marked **pending**, not done.

## 3. Progress log
- 2026-11-03: findings and plan recorded.
- 2026-11-03: **resolved.**
  - Every row of the plan's change table is implemented. F1–F5 are all addressed.
  - Migration `20261103120000_addon_subscription_items`.

## 4. Verification results (2026-11-03)

| Check | Result |
|-------|--------|
| New billing tests (`backend/src/services/stripeWebhook.addon.test.ts`, real test DB, Stripe faked) | ✅ 18/18. They cover every scenario in "How nothing breaks", step 1 |
| Tests catch regressions | ✅ Two guards (the decline protection and the "top-up failure doesn't lock" rule) were removed on purpose, and 2 tests failed as expected. Code restored |
| Full backend suite (includes entitlement, add-on gate and webhook-idempotency tests) | ✅ 4,348/4,348 |
| Full frontend suite (Node 24) | ✅ 850/850 |
| Type-check (backend + frontend) | ✅ clean |
| Frontend lint | ✅ 0 errors, 237 warnings (limit 241; none in changed lines) |
| Real Stripe test-mode run (fake cards) | ⏳ **Pending.** Needs a test secret key (`sk_test_…`) in local `backend/.env`. Owner to-do T2 |

### How to test it yourself (once T2 is done)
1. In Billing, subscribe to Core with test card `4242 4242 4242 4242`.
2. Click **Add** on an add-on. The dialog shows today's charge and the new single total. Confirm, and the module
   unlocks without leaving the page.
3. In Stripe test mode → Subscriptions, there is **one** subscription with two lines.
4. Change the card to `4000 0000 0000 0341` (it attaches but declines charges), then add another add-on. You get an
   error, nothing is added, and the rest of the app still works.
5. Cancel an add-on. It disappears, and the base plan keeps working.

## 5. Re-validation and review fixes (2026-11-04)

**Live check** through the real webhook endpoint with **signed** Stripe events, checking access on a real
add-on-gated route after each step:

| Step | Result |
|---|---|
| Forged signature | ✅ Rejected (400) |
| Add-on line added to the plan | ✅ Module unlocked and tracked |
| Failed add-on top-up | ✅ Account **not** locked |
| Failed renewal | ✅ Locked (402) |
| Renewal paid | ✅ Unlocked |
| Retired separate add-on event | ✅ Ignored |
| Line removed | ✅ Module off; base plan still works |
| Plan deleted | ✅ Locked |

An independent review confirmed that B3 itself is fixed. It found four gaps in the rewrite, all confirmed in the code
and **fixed on 2026-11-04**:

| # | Gap | Fix |
|---|-----|-----|
| R1 | A plan switch (e.g. monthly → annual) arrives as a new subscription and dropped every add-on, a regression from the separate-subscription design | Add-ons on the old subscription are carried over to the new base plan at the new cycle's price. All Access needs none |
| R2 | Stripe doesn't deliver events in order, so a late snapshot could re-grant a removed add-on (or revoke a paid one) | The webhook re-reads the subscription from Stripe before syncing. If Stripe can't be reached it falls back to the snapshot and logs it |
| R3 | A double click or retry could add the same module twice (billed twice) | One idempotency key per subscription state and module. An in-flight duplicate gets a clear 409. The row save is an upsert, so it can't race the webhook |
| R4 | Rows from the retired separate-subscription design couldn't be cancelled in Stripe, and their lapse was ignored | Cancel now cancels that separate subscription (never the plan). A lapse or deletion removes the module; it never grants one |

**Also added:**
- **Truncated item lists:** if Stripe truncates the item list (`has_more`), no add-on is cancelled on that pass.
- **Clearer error text:** a failed payment that isn't a decline (for example, one needing bank confirmation) is
  explained correctly.

**Tests:**
- 5 new tests, bringing the billing file to 23/23.
- Full backend suite: 4,357/4,357.
- Frontend: 850/850.
- Type-check and lint: clean.

**Known, not changed (minor):**
- **Annual price on the button:** it shows the monthly price even on an annual plan. The confirm dialog shows the
  right amount.
- **Preview total:** it ignores discounts and tax.
- **Losing an add-on:** an add-on granted another way (owner or legacy grant) is removed if the same module's paid
  line is removed.
