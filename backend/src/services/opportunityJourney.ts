// =============================================================
// Status and next step for an opportunity — "what's done, where it stands
// and where to check it, what to do next and where to do it".
//
// The journey: Identified → Qualify → Capture → Proposal → Submitted → Award
// (won or lost), with No-bid and Archived as exits. The pipeline stage says
// where the pursuit stands; the facts (scorecard, decision, proposal sections,
// pricing, submission) say what is actually done, so the next step is the
// first thing still missing, with a link to the page where it's done.
//
// Shown on the opportunity page (status bar) and after every action (a
// pop-up with the next step). Pure: `loadJourney` gathers the facts.
// =============================================================
import { prisma } from '../config/database'
import { NotFoundError } from '../utils/errors'
import { NO_BID_REASONS } from './qualificationDecision'

export type JourneyStepKey = 'IDENTIFIED' | 'QUALIFY' | 'CAPTURE' | 'PROPOSAL' | 'SUBMITTED' | 'AWARD'
export type StepState = 'done' | 'current' | 'todo' | 'skipped'

export interface Link { label: string; to: string }

export interface Journey {
  /** The pipeline entry, for actions such as recording the outcome. */
  pursuitId: string | null
  stage: string | null
  stageLabel: string
  steps: Array<{ key: JourneyStepKey; label: string; state: StepState }>
  /** The latest thing done, in a sentence. */
  lastDone: string | null
  /** Where the opportunity stands, and where to see it. */
  status: { text: string; where: Link }
  /** The next thing to do and where to do it; null when nothing is left. */
  next: { text: string; action: Link | null } | null
  /** Shown next to the next step when a bid has been submitted. */
  outcomeActions: boolean
  /** A warning to show with the status, e.g. a passed deadline. */
  warning: string | null
}

export interface JourneyFacts {
  opportunityId: string
  responseDeadline: Date
  isAwardNotice: boolean
  pursuit: { id?: string; stage: string; closedAt: Date | null } | null
  scorecard: {
    status: string
    finalDecision: string | null
    totalScore: number
    unscoredRequired: number
    noBidReason: string | null
  } | null
  proposal: { sections: number; approved: number } | null
  pricing: { priced: boolean; approved: boolean } | null
  submission: { status: string; submittedAt: Date | null } | null
  now?: Date
}

const STEPS: Array<{ key: JourneyStepKey; label: string }> = [
  { key: 'IDENTIFIED', label: 'Identified' },
  { key: 'QUALIFY', label: 'Qualify' },
  { key: 'CAPTURE', label: 'Capture' },
  { key: 'PROPOSAL', label: 'Proposal' },
  { key: 'SUBMITTED', label: 'Submitted' },
  { key: 'AWARD', label: 'Award' },
]
const STAGE_TO_STEP: Record<string, JourneyStepKey> = {
  IDENTIFIED: 'IDENTIFIED', QUALIFICATION: 'QUALIFY', CAPTURE: 'CAPTURE', PROPOSAL: 'PROPOSAL',
  SUBMITTED: 'SUBMITTED', AWARDED: 'AWARD', LOST: 'AWARD',
}
export const STAGE_LABEL: Record<string, string> = {
  IDENTIFIED: 'Identified', QUALIFICATION: 'Qualification', CAPTURE: 'Capture', PROPOSAL: 'Proposal',
  SUBMITTED: 'Submitted', AWARDED: 'Won', LOST: 'Lost', NO_BID: 'No-bid', ARCHIVED: 'Archived',
}

const fmtDay = (d: Date) => d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric', timeZone: 'America/New_York' })
const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? '' : 's'}`

function stepsFor(stage: string | null): Journey['steps'] {
  if (!stage) return STEPS.map((s) => ({ ...s, state: 'todo' as StepState }))
  if (stage === 'NO_BID' || stage === 'ARCHIVED') {
    // Stopped after qualifying: the rest of the journey is skipped.
    return STEPS.map((s, i) => ({ ...s, state: (i <= 1 ? 'done' : 'skipped') as StepState }))
  }
  const at = STEPS.findIndex((s) => s.key === STAGE_TO_STEP[stage])
  const finished = stage === 'AWARDED' || stage === 'LOST'
  return STEPS.map((s, i) => ({ ...s, state: (i < at || (finished && i === at) ? 'done' : i === at ? 'current' : 'todo') as StepState }))
}

export function buildJourney(f: JourneyFacts): Journey {
  const now = f.now ?? new Date()
  const id = f.opportunityId
  const qualify: Link = { label: 'Open the Qualify panel', to: `/opportunities/${id}#qualify` }
  const proposalLink: Link = { label: 'Open the proposal workspace', to: `/opportunities/${id}/proposal` }
  const pricingLink: Link = { label: 'Open the Pricing workspace', to: `/opportunities/${id}/pricing` }
  const submissionLink: Link = { label: 'Open the Submission workspace', to: `/opportunities/${id}/submission` }
  const stage = f.pursuit?.stage ?? null
  const stageLabel = stage ? STAGE_LABEL[stage] ?? stage : 'Not in your pipeline'
  const where: Link = stage ? { label: `Pipeline → ${stageLabel}`, to: '/pipeline' } : { label: 'Opportunities', to: '/opportunities' }
  const deadlinePassed = f.responseDeadline.getTime() < now.getTime()
  const beforeSubmission = !stage || ['IDENTIFIED', 'QUALIFICATION', 'CAPTURE', 'PROPOSAL'].includes(stage)
  const warning = deadlinePassed && beforeSubmission
    ? `The response deadline passed on ${fmtDay(f.responseDeadline)}.`
    : null

  const base = { pursuitId: f.pursuit?.id ?? null, stage, stageLabel, steps: stepsFor(stage), outcomeActions: false, warning }
  const status = (text: string) => ({ text, where })
  const sc = f.scorecard

  if (f.isAwardNotice) {
    return { ...base, lastDone: null, status: { text: 'This is an award notice: there is nothing to bid on.', where }, next: null }
  }
  if (!stage) {
    return {
      ...base, lastDone: null,
      status: { text: 'Not in your pipeline yet.', where },
      next: deadlinePassed ? null : { text: 'Check eligibility and score it to decide whether to bid.', action: qualify },
    }
  }

  switch (stage) {
    case 'IDENTIFIED':
      return {
        ...base,
        lastDone: 'Opportunity identified and added to your pipeline.',
        status: status('Identified: not qualified yet.'),
        next: { text: 'Check eligibility and start the scorecard to decide whether to bid.', action: qualify },
      }

    case 'QUALIFICATION': {
      if (sc?.finalDecision === 'CONDITIONAL') {
        return {
          ...base,
          lastDone: 'Decision recorded: Conditional bid.',
          status: status('Qualification: a conditional bid, waiting on its conditions.'),
          next: { text: 'Resolve the conditions, then record a final Bid or No-bid.', action: qualify },
        }
      }
      if (sc?.finalDecision === 'DEFERRED') {
        return {
          ...base,
          lastDone: 'Decision deferred.',
          status: status('Qualification: decision deferred.'),
          next: { text: `Come back to it before the deadline (${fmtDay(f.responseDeadline)}) and record Bid or No-bid.`, action: qualify },
        }
      }
      return {
        ...base,
        lastDone: sc ? `Scorecard started (${sc.totalScore}/100 so far).` : 'Moved to qualification.',
        status: status('Qualification: deciding whether to bid.'),
        next: {
          text: sc && sc.unscoredRequired > 0
            ? `Score the ${plural(sc.unscoredRequired, 'remaining required criterion').replace('criterions', 'criteria')}, then record Bid or No-bid.`
            : sc ? 'Review the scores and record Bid or No-bid.' : 'Start the scorecard and record Bid or No-bid.',
          action: qualify,
        },
      }
    }

    case 'CAPTURE':
      return {
        ...base,
        lastDone: 'Decision recorded: Bid.',
        status: status('Capture: you are bidding, proposal not started.'),
        next: { text: 'Start the proposal: outline, draft and approve its sections.', action: proposalLink },
      }

    case 'PROPOSAL': {
      const p = f.proposal
      const lastDone = p && p.approved > 0
        ? `${p.approved} of ${plural(p.sections, 'proposal section')} approved.`
        : 'Proposal started.'
      let next: Journey['next']
      if (!p || p.sections === 0) next = { text: 'Outline the proposal and draft its sections.', action: proposalLink }
      else if (p.approved < p.sections) next = { text: `Draft and approve the remaining ${plural(p.sections - p.approved, 'section')}.`, action: proposalLink }
      else if (!f.pricing?.priced) next = { text: 'Build your price for this bid.', action: pricingLink }
      else if (!f.pricing.approved) next = { text: 'Send your price for review and get it approved.', action: pricingLink }
      else if (!f.submission) next = { text: 'Set up the submission package and its checklist.', action: submissionLink }
      else next = { text: 'Finish the submission checklist, submit to the agency, and record it.', action: submissionLink }
      return { ...base, lastDone, status: status('Proposal: being written.'), next }
    }

    case 'SUBMITTED':
      return {
        ...base,
        lastDone: f.submission?.submittedAt ? `Proposal submitted on ${fmtDay(f.submission.submittedAt)}.` : 'Proposal submitted.',
        status: status('Submitted: waiting for the agency\'s decision.'),
        next: { text: 'When the agency announces the award, record whether you won or lost.', action: null },
        outcomeActions: true,
      }

    case 'AWARDED':
      return {
        ...base,
        lastDone: 'Recorded as won.',
        status: status('Won.'),
        next: { text: 'Set up the contract to track deliverables, invoices and renewals.', action: { label: 'Go to Contracts', to: '/contracts' } },
      }

    case 'LOST':
      return {
        ...base,
        lastDone: 'Recorded as lost.',
        status: status('Lost.'),
        next: { text: 'Ask the contracting officer for a debrief and note what to do differently next time.', action: null },
      }

    case 'NO_BID': {
      const why = sc?.noBidReason && sc.noBidReason in NO_BID_REASONS ? NO_BID_REASONS[sc.noBidReason as keyof typeof NO_BID_REASONS] : null
      return {
        ...base,
        lastDone: why ? `Decided not to bid: ${why}.` : 'Decided not to bid.',
        status: status('No-bid: closed.'),
        next: { text: 'Nothing more to do. If things change, change the decision in the Qualify panel.', action: qualify },
      }
    }

    case 'ARCHIVED':
    default:
      return {
        ...base,
        lastDone: 'Archived.',
        status: status('Archived.'),
        next: { text: 'Reopen it from the Pipeline if you want to pursue it again.', action: { label: 'Go to Pipeline', to: '/pipeline' } },
      }
  }
}

/**
 * The journey for one opportunity, for the company that would bid: a
 * consulting firm's client when given (its scorecard), otherwise the most
 * recently updated scorecard on the pursuit.
 */
export async function loadJourney(consultingFirmId: string, opportunityId: string, clientCompanyId?: string | null): Promise<Journey> {
  const opp = await prisma.opportunity.findFirst({
    where: { id: opportunityId, consultingFirmId },
    select: { id: true, responseDeadline: true, noticeType: true },
  })
  if (!opp) throw new NotFoundError('Opportunity')

  const [pursuit, proposal, workspace, submission] = await Promise.all([
    prisma.bidPursuit.findUnique({
      where: { consultingFirmId_opportunityId: { consultingFirmId, opportunityId } },
      select: {
        id: true, pipelineStage: true, closedAt: true,
        scorecards: {
          where: clientCompanyId ? { clientCompanyId } : {},
          orderBy: { updatedAt: 'desc' }, take: 1,
          select: { status: true, finalDecision: true, totalScore: true, noBidReason: true, criteria: { select: { required: true, score: true } } },
        },
      },
    }),
    prisma.proposal.findFirst({
      where: { consultingFirmId, opportunityId, status: 'ACTIVE' },
      orderBy: { createdAt: 'desc' },
      select: { sections: { select: { approvedAt: true } } },
    }),
    prisma.pricingWorkspace.findFirst({
      where: { consultingFirmId, opportunityId, isArchived: false, status: { notIn: ['SUPERSEDED', 'ARCHIVED'] } },
      orderBy: { version: 'desc' },
      select: { status: true, scenarios: { where: { isArchived: false, totalPrice: { gt: 0 } }, select: { id: true }, take: 1 } },
    }),
    prisma.proposalSubmission.findFirst({
      where: { consultingFirmId, opportunityId, isArchived: false },
      orderBy: { updatedAt: 'desc' },
      select: { status: true, submittedAt: true },
    }),
  ])
  const sc = pursuit?.scorecards[0] ?? null

  return buildJourney({
    opportunityId,
    responseDeadline: opp.responseDeadline,
    isAwardNotice: (opp.noticeType ?? '').toLowerCase().includes('award'),
    pursuit: pursuit ? { id: pursuit.id, stage: pursuit.pipelineStage, closedAt: pursuit.closedAt } : null,
    scorecard: sc ? {
      status: sc.status, finalDecision: sc.finalDecision, totalScore: sc.totalScore, noBidReason: sc.noBidReason,
      unscoredRequired: sc.criteria.filter((c) => c.required && c.score === null).length,
    } : null,
    proposal: proposal ? { sections: proposal.sections.length, approved: proposal.sections.filter((s) => s.approvedAt).length } : null,
    pricing: workspace ? { priced: workspace.scenarios.length > 0, approved: workspace.status === 'APPROVED' } : null,
    submission,
  })
}
