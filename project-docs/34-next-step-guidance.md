# 34 — Status and next step on every opportunity

Who this is for: founders and developers. It covers how Bytescon tells a user, after every action on an opportunity, what was done, where it stands and where to check it, and what to do next and where.

Code wins if it disagrees with this page. Main places:
- **Backend:**
  - `backend/src/services/opportunityJourney.ts` (the rules);
  - `backend/src/services/pursuitProgress.ts` (keeping the stage true);
  - `GET /api/opportunities/:id/journey[?clientCompanyId=]`.
- **Frontend:**
  - `frontend/src/components/journey/JourneyBar.tsx` (the status bar);
  - `frontend/src/hooks/useNextStep.ts` (the pop-up);
  - `frontend/src/components/Toast.tsx` (pop-ups can carry a detail line and a link).

Scope: from a notice being identified to the award (won or lost), including no-bid. Contracts already won (contract management) are not covered yet.

---

## 1. What the user sees

**On the opportunity page**, under the header, a status bar shows:
- **The journey:** Identified → Qualify → Capture → Proposal → Submitted → Award. Done steps are ticked, the current one is marked, and steps after a no-bid are struck through.
- **Done:** the last thing done, e.g. "Decision recorded: Bid."
- **Status now:** where it stands, with a link to where to check it, e.g. "Capture: you are bidding, proposal not started. See it in Pipeline → Capture".
- **Next step:** what to do next, with a button to the page where it's done, e.g. "Start the proposal… [Open the proposal workspace]".
- **Outcome:** once submitted, **Mark as won / Mark as lost** buttons (admins).
- **Deadline warning:** a warning when the response deadline has passed before submission.

**After every action**, a pop-up says what was done, then "Now: … Next: …", with a link to where the next step is done. It stays up 12 seconds. Actions covered:

| Where | Actions |
|---|---|
| Qualify panel and the full qualification page | start scorecard, record a decision, change a decision |
| To qualify list | quick no-bid |
| Pipeline | stage change |
| Proposal workspace | proposal started |
| Pricing workspace | workspace created; submit for review, approve, and the other workspace actions |
| Submission workspace | package created, submission recorded |
| Status bar | marked as won or lost |

## 2. The rules (`buildJourney`)

The next step is the first thing still missing for the current stage:

| Stage | Done | Next step → where |
|---|---|---|
| Not in pipeline | — | Check eligibility and score it → Qualify panel |
| Identified | Identified and added to the pipeline | Start the scorecard → Qualify panel |
| Qualification | Scorecard started (N/100) | Score the N remaining required criteria, then decide → Qualify panel. Conditional: resolve the conditions. Deferred: come back before the deadline |
| Capture | Decision: Bid | Start the proposal → Proposal workspace |
| Proposal | Proposal started / N of M sections approved | In order: outline and draft sections → approve them (Proposal) → build the price → get it approved (Pricing) → set up the submission package → finish the checklist and record the submission (Submission) |
| Submitted | Submitted on DATE | Record won or lost (buttons on the bar) |
| Won | Recorded as won | Set up the contract → Contracts |
| Lost | Recorded as lost | Ask for a debrief |
| No-bid | Decided not to bid, with the reason | Nothing; change the decision in the Qualify panel if things change |
| Archived | Archived | Reopen from the Pipeline |

"Where to check it" is always the Pipeline stage. For a consulting firm, the decision facts come from the chosen client's scorecard (`?clientCompanyId=`, or `?client=` on the page), otherwise the most recently updated one.

## 3. The stage follows the work (`advancePursuit`)

So the status is never stale, two actions now move the pipeline stage forward on their own:
- **Starting a proposal** → **Proposal**;
- **Recording a submission** → **Submitted**.

The stage only moves forward, one legal step at a time. Each hop is recorded like a manual move: a `PURSUIT_STAGE_CHANGED` event in the same transaction, plus an audit row "Stage X → Y: proposal started".

It never moves a pursuit that is closed, already at or past the target, or No-bid or Archived. It never fails the action that triggered it.

Already automatic before this: starting a scorecard → Qualification, and a decision → Capture or No-bid ([33](33-qualification-flow.md)).

## 4. Not done (yet)

- **Won contracts:** after the award (contract management) is not covered.
- **Some smaller actions** don't show a pop-up yet: saving scores, editing proposal sections, adding pricing lines and checklist items. The status bar still updates when the page reloads.
- **Pipeline link:** "See it in Pipeline" opens the Pipeline page, not a filtered column.
