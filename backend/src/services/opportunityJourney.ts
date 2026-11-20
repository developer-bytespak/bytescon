// =============================================================
// Status and next step for an opportunity — "what's done, where it stands
// and where to check it, what to do next and where to do it".
//
// The journey: Identified → Qualify → Capture → Proposal → Price → Review →
// Package → Submitted → Award (won or lost), with No-bid and Archived as exits.
// Price, Review and Package happen while the pursuit is in the Proposal stage; their ticks
// come from the facts, and writing and pricing can run at the same time. The pipeline stage says
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

export type JourneyStepKey = 'IDENTIFIED' | 'QUALIFY' | 'CAPTURE' | 'PROPOSAL' | 'PRICING' | 'REVIEW' | 'PACKAGE' | 'SUBMITTED' | 'AWARD'
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
  /** Something that can be done alongside the next step (e.g. pricing while writing). */
  also: { text: string; action: Link } | null
  /** Shown next to the next step when a bid has been submitted. */
  outcomeActions: boolean
  /** A warning to show with the status, e.g. a passed deadline. */
  warning: string | null
  /**
   * The step being worked on, in plain words for the step guide: which step
   * (with its place in the journey), what finishing it means, and the button
   * that finishes it (to the page where it's done). Null when nothing is left.
   */
  current: GuideStep | null
  /** The step after it, with a button to open it ahead. Null at the end. */
  then: { step: string; action: Link | null } | null
}

export interface GuideStep {
  step: string
  /** 1-based place in the journey, and how many steps there are. */
  number: number
  of: number
  /** One simple line: what this step is and how to finish it. */
  what: string
  /** Button that finishes the step (goes to where it's done). */
  action: Link | null
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
  /** reviewed: the whole proposal was read in its template and confirmed ready (proposal.reviewedAt). */
  proposal: { sections: number; approved: number; reviewed?: boolean } | null
  pricing: { priced: boolean; approved: boolean } | null
  submission: { status: string; submittedAt: Date | null } | null
  now?: Date
}

const STEPS: Array<{ key: JourneyStepKey; label: string }> = [
  { key: 'IDENTIFIED', label: 'Identified' },
  { key: 'QUALIFY', label: 'Qualify' },
  { key: 'CAPTURE', label: 'Capture' },
  { key: 'PROPOSAL', label: 'Proposal' },
  { key: 'PRICING', label: 'Price' },
  { key: 'REVIEW', label: 'Review' },
  { key: 'PACKAGE', label: 'Package' },
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

/** The Proposal / Price / Review / Package ticks while the pursuit is in the Proposal stage. */
function proposalWork(f: JourneyFacts) {
  const written = !!f.proposal && f.proposal.sections > 0 && f.proposal.approved >= f.proposal.sections
  const priced = !!f.pricing?.approved
  // Reviewing comes once the writing and the price are done.
  const reviewed = written && priced && !!f.proposal?.reviewed
  const packaged = !!f.submission
  return { written, priced, reviewed, packaged }
}

function stepsFor(stage: string | null, f?: JourneyFacts): Journey['steps'] {
  if (!stage) return STEPS.map((s) => ({ ...s, state: 'todo' as StepState }))
  if (stage === 'NO_BID' || stage === 'ARCHIVED') {
    // Stopped after qualifying: the rest of the journey is skipped.
    return STEPS.map((s, i) => ({ ...s, state: (i <= 1 ? 'done' : 'skipped') as StepState }))
  }
  const at = STEPS.findIndex((s) => s.key === STAGE_TO_STEP[stage])
  const finished = stage === 'AWARDED' || stage === 'LOST'
  const steps = STEPS.map((s, i) => ({ ...s, state: (i < at || (finished && i === at) ? 'done' : i === at ? 'current' : 'todo') as StepState }))
  if (stage === 'PROPOSAL' && f) {
    // Writing and pricing run side by side; the package comes once both are done.
    const w = proposalWork(f)
    const set = (key: JourneyStepKey, state: StepState) => { steps.find((s) => s.key === key)!.state = state }
    set('PROPOSAL', w.written ? 'done' : 'current')
    set('PRICING', w.priced ? 'done' : 'current')
    set('REVIEW', w.reviewed ? 'done' : w.written && w.priced ? 'current' : 'todo')
    set('PACKAGE', w.packaged ? 'done' : w.reviewed ? 'current' : 'todo')
  } else if (f?.pricing?.approved && steps.find((s) => s.key === 'PRICING')!.state === 'todo') {
    // Priced early (e.g. during capture): already done.
    steps.find((s) => s.key === 'PRICING')!.state = 'done'
  }
  return steps
}

type Links = { qualify: Link; proposal: Link; pricing: Link; preview: Link; submission: Link; contracts: Link; pipeline: Link }

const guideStep = (key: JourneyStepKey, what: string, action: Link | null): GuideStep => {
  const i = STEPS.findIndex((s) => s.key === key)
  return { step: STEPS[i].label, number: i + 1, of: STEPS.length, what, action }
}

/** The step guide: the step to finish now, and the one after it. */
function guideFor(f: JourneyFacts, stage: string | null, l: Links): Pick<Journey, 'current' | 'then'> {
  const sc = f.scorecard
  const toProposal = { step: 'Proposal', action: l.proposal }
  const toPrice = { step: 'Price', action: l.pricing }
  const toReview = { step: 'Review', action: l.preview }
  const toPackage = { step: 'Package', action: l.submission }
  if (f.isAwardNotice) return { current: null, then: null }
  if (!stage || stage === 'IDENTIFIED') {
    return { current: guideStep('QUALIFY', 'Decide whether to bid: check you can bid, score the opportunity, then choose Bid or No-bid.', { ...l.qualify, label: 'Start qualifying' }), then: toProposal }
  }
  switch (stage) {
    case 'QUALIFICATION': {
      const what = sc?.finalDecision === 'CONDITIONAL' ? 'You chose a conditional bid: sort out its conditions, then choose Bid or No-bid.'
        : sc?.finalDecision === 'DEFERRED' ? `You put the decision off: come back before ${fmtDay(f.responseDeadline)} and choose Bid or No-bid.`
          : sc && sc.unscoredRequired > 0 ? `Score the ${plural(sc.unscoredRequired, 'required question')} left, then choose Bid or No-bid.`
            : 'Check the scores, then choose Bid or No-bid.'
      return { current: guideStep('QUALIFY', what, { ...l.qualify, label: 'Finish qualifying' }), then: toProposal }
    }
    case 'CAPTURE':
      return { current: guideStep('PROPOSAL', 'Start the proposal: it sets itself up with sections from the solicitation, ready to write.', { ...l.proposal, label: 'Start the proposal' }), then: toPrice }
    case 'PROPOSAL': {
      const p = f.proposal
      const w = proposalWork(f)
      if (!w.written) {
        const left = p && p.sections > 0 ? ` (${p.approved} of ${p.sections} approved so far)` : ''
        return { current: guideStep('PROPOSAL', `Write each section and approve it when it reads right${left}.`, { ...l.proposal, label: 'Write and approve sections' }), then: toPrice }
      }
      if (!f.pricing?.priced) return { current: guideStep('PRICING', 'Build your price: add the labour rates and hours for the work.', { ...l.pricing, label: 'Build the price' }), then: toReview }
      if (!f.pricing.approved) return { current: guideStep('PRICING', 'Check the price, send it for review, then approve it.', { ...l.pricing, label: 'Approve the price' }), then: toReview }
      if (!w.reviewed) return { current: guideStep('REVIEW', 'Read the whole proposal in its template, with its price, then confirm it is ready to submit.', { ...l.preview, label: 'Review the proposal' }), then: toPackage }
      if (!f.submission) return { current: guideStep('PACKAGE', 'Prepare the submission: its checklist is made for you from the proposal and requirements.', { ...l.submission, label: 'Prepare the submission' }), then: { step: 'Submitted', action: null } }
      return { current: guideStep('PACKAGE', 'Tick off the checklist, send the bid to the agency, then mark it submitted.', { ...l.submission, label: 'Finish the checklist' }), then: { step: 'Submitted', action: null } }
    }
    case 'SUBMITTED':
      // The Mark as won / lost buttons are on the opportunity page.
      return { current: guideStep('AWARD', 'Wait for the agency to announce the award, then record whether you won or lost.', { label: 'Record won or lost', to: `/opportunities/${f.opportunityId}` }), then: null }
    case 'AWARDED':
      return { current: guideStep('AWARD', 'You won: set up the contract to track its work, invoices and renewals.', { ...l.contracts, label: 'Set up the contract' }), then: null }
    case 'LOST':
      return { current: guideStep('AWARD', 'Ask the contracting officer for a debrief, and note what to change next time.', null), then: null }
    case 'NO_BID':
      return { current: guideStep('QUALIFY', 'You chose not to bid. If things change, change the decision in the Qualify panel.', { ...l.qualify, label: 'Change the decision' }), then: null }
    default:
      return { current: null, then: { step: 'Pipeline', action: l.pipeline } }
  }
}

export function buildJourney(f: JourneyFacts): Journey {
  return { ...buildJourneyCore(f), ...guideFor(f, f.pursuit?.stage ?? null, linksFor(f.opportunityId)) }
}

function linksFor(id: string): Links {
  return {
    qualify: { label: 'Open the Qualify panel', to: `/opportunities/${id}#qualify` },
    proposal: { label: 'Write the proposal', to: `/opportunities/${id}/proposal` },
    pricing: { label: 'Build the price', to: `/opportunities/${id}/pricing` },
    preview: { label: 'Review the proposal', to: `/opportunities/${id}/preview` },
    submission: { label: 'Prepare the submission', to: `/opportunities/${id}/submission` },
    contracts: { label: 'Go to Contracts', to: '/contracts' },
    pipeline: { label: 'Go to Pipeline', to: '/pipeline' },
  }
}

function buildJourneyCore(f: JourneyFacts): Omit<Journey, 'current' | 'then'> {
  const now = f.now ?? new Date()
  const id = f.opportunityId
  const qualify: Link = { label: 'Open the Qualify panel', to: `/opportunities/${id}#qualify` }
  const proposalLink: Link = { label: 'Write the proposal', to: `/opportunities/${id}/proposal` }
  const pricingLink: Link = { label: 'Build the price', to: `/opportunities/${id}/pricing` }
  const submissionLink: Link = { label: 'Prepare the submission', to: `/opportunities/${id}/submission` }
  const stage = f.pursuit?.stage ?? null
  const stageLabel = stage ? STAGE_LABEL[stage] ?? stage : 'Not in your pipeline'
  const where: Link = stage ? { label: `Pipeline → ${stageLabel}`, to: '/pipeline' } : { label: 'Opportunities', to: '/opportunities' }
  const deadlinePassed = f.responseDeadline.getTime() < now.getTime()
  const beforeSubmission = !stage || ['IDENTIFIED', 'QUALIFICATION', 'CAPTURE', 'PROPOSAL'].includes(stage)
  const warning = deadlinePassed && beforeSubmission
    ? `The response deadline passed on ${fmtDay(f.responseDeadline)}.`
    : null

  const base = { pursuitId: f.pursuit?.id ?? null, stage, stageLabel, steps: stepsFor(stage, f), outcomeActions: false, warning, also: null as Journey['also'] }
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
      else if (!proposalWork(f).reviewed) next = { text: 'Read the whole proposal in its template and confirm it is ready.', action: { label: 'Review the proposal', to: `/opportunities/${id}/preview` } }
      else if (!f.submission) next = { text: 'Set up the submission package and its checklist.', action: submissionLink }
      else next = { text: 'Finish the submission checklist, submit to the agency, and record it.', action: submissionLink }
      // While the sections are still being written, pricing can go ahead too.
      const writing = !p || p.sections === 0 || p.approved < p.sections
      const also: Journey['also'] = writing && !f.pricing?.approved
        ? { text: f.pricing?.priced ? 'You can get your price reviewed and approved now.' : 'You can build your price at the same time.', action: pricingLink }
        : null
      return { ...base, lastDone, status: status('Proposal: being written.'), next, also }
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
/**
 * Why a bid can't be moved by hand to a later stage yet: the work that stage
 * stands for isn't done. Null when the move is fine. Moving back, closing
 * (No-bid, Archived), reopening and recording the outcome are never blocked;
 * the work itself still moves a bid forward on its own (a Bid decision, the
 * proposal starting, the submission being recorded).
 */
export function stageMoveBlocker(f: JourneyFacts, to: string): string | null {
  if (to === 'CAPTURE' && f.scorecard?.finalDecision !== 'BID') {
    return 'Record a Bid decision on the scorecard first: that moves it to Capture.'
  }
  if (to === 'PROPOSAL' && !f.proposal) {
    return 'Start the proposal first (Write the proposal): that moves it to Proposal.'
  }
  if (to === 'SUBMITTED') {
    const w = proposalWork(f)
    const missing = [
      !w.written && (f.proposal && f.proposal.sections > 0 ? `approve every proposal section (${f.proposal.approved} of ${f.proposal.sections} approved)` : 'write and approve the proposal'),
      !w.priced && 'approve the price',
      w.written && w.priced && !w.reviewed && 'review the complete proposal',
      !w.packaged && 'prepare the submission',
    ].filter(Boolean)
    if (missing.length) return `Not ready to submit: ${missing.join(', ')} first. Recording the submission then moves it to Submitted.`
  }
  return null
}

export async function loadJourney(consultingFirmId: string, opportunityId: string, clientCompanyId?: string | null): Promise<Journey> {
  return buildJourney(await loadJourneyFacts(consultingFirmId, opportunityId, clientCompanyId))
}

/** The facts the journey is built from: the pursuit, scorecard, proposal, price and submission. */
export async function loadJourneyFacts(consultingFirmId: string, opportunityId: string, clientCompanyId?: string | null): Promise<JourneyFacts> {
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
      select: { reviewedAt: true, sections: { select: { approvedAt: true } } },
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

  return {
    opportunityId,
    responseDeadline: opp.responseDeadline,
    isAwardNotice: (opp.noticeType ?? '').toLowerCase().includes('award'),
    pursuit: pursuit ? { id: pursuit.id, stage: pursuit.pipelineStage, closedAt: pursuit.closedAt } : null,
    scorecard: sc ? {
      status: sc.status, finalDecision: sc.finalDecision, totalScore: sc.totalScore, noBidReason: sc.noBidReason,
      unscoredRequired: sc.criteria.filter((c) => c.required && c.score === null).length,
    } : null,
    proposal: proposal ? { sections: proposal.sections.length, approved: proposal.sections.filter((s) => s.approvedAt).length, reviewed: !!proposal.reviewedAt } : null,
    // An approved price counts as built even when its amounts are still zero.
    pricing: workspace ? { priced: workspace.scenarios.length > 0 || workspace.status === 'APPROVED', approved: workspace.status === 'APPROVED' } : null,
    submission,
  }
}
