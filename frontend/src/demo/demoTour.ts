import { driver, type DriveStep, type Driver } from 'driver.js'
import 'driver.js/dist/driver.css'
import { demoApi, type DemoTourData } from './demoApi'

// A walk through the real screens, pointing at the account's own data. Each step
// names the page it lives on; moving between steps changes the page first, then
// waits for the target to appear. A step whose target never appears, such as an
// account with no contract, still shows its words in the middle of the page.
interface TourStep extends DriveStep {
  route: string
}

type Navigate = (to: string) => void
let navigateTo: Navigate | null = null

/** Called by the app's shell, so the tour can change pages without reloading. */
export function registerTourNavigation(navigate: Navigate): void {
  navigateTo = navigate
}

function goTo(route: string): void {
  if (window.location.pathname === route) return
  if (navigateTo) {
    navigateTo(route)
    return
  }
  // Without the shell, the browser's history still drives the app's router.
  window.history.pushState({}, '', route)
  window.dispatchEvent(new PopStateEvent('popstate'))
}

const money = (value: number) => new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 0 }).format(value)
const percent = (value: number) => `${Math.round(value * 100)}%`

function buildSteps(data: DemoTourData): TourStep[] {
  const top = data.topOpportunity
  const recommendation = top?.recommendation === 'BID_SUB' ? 'bidding as a subcontractor' : 'bidding as the prime'
  const steps: TourStep[] = [
    {
      route: '/dashboard',
      popover: {
        title: 'Welcome to Bytescon',
        description: 'A quick look at how a federal contract goes from first sighting to delivery, using the data in this account. It takes about two minutes.',
      },
    },
    {
      route: '/dashboard',
      element: '[data-tour="dashboard-stats"]',
      popover: {
        title: 'Your day at a glance',
        description: `${data.openOpportunities} open opportunities for ${data.clients} clients. Pipeline value, win probability and deadlines are always up to date here.`,
      },
    },
    {
      route: '/opportunities',
      element: '[data-tour="opportunity-row"]',
      popover: {
        title: 'Find opportunities',
        description: top
          ? `Every opportunity is scored for how well it fits your clients. ${top.title} scored ${percent(top.baselineScore)}. Open one to see why.`
          : 'Every opportunity is scored for how well it fits your clients.',
      },
    },
  ]
  if (top) {
    steps.push({
      route: `/opportunities/${top.id}`,
      element: '[data-tour="win-probability"]',
      popover: {
        title: 'Why it scored that way',
        description: `For ${top.client} in particular it comes to ${percent(top.winProbability)}. The score is built from factors such as industry match, set-aside fit, competition and past performance; scroll down for the full breakdown.`,
      },
    })
  }
  steps.push(
    {
      route: '/decisions',
      element: '[data-tour="decision-queue"]',
      popover: {
        title: 'Decide what to bid',
        description: top
          ? `Bytescon recommends ${recommendation} on ${top.title}. Press GO or NO-GO; people make the final call.`
          : 'Each recommendation comes with the reasons behind it. Press GO or NO-GO; people make the final call.',
      },
    },
    {
      route: '/pipeline',
      element: '[data-tour="pipeline-board"]',
      popover: {
        title: 'Track your pursuits',
        description: 'Every pursuit by stage, with owners and next steps. Opening an opportunity adds it under Identified, and cards move along as the work progresses.',
      },
    },
  )
  if (data.proposal) {
    steps.push({
      route: `/opportunities/${data.proposal.opportunityId}/proposal`,
      element: '[data-tour="proposal-tabs"]',
      popover: {
        title: 'Write the proposal',
        description: `${data.proposal.title} has ${data.proposal.sections} sections, drafted with AI from your approved content and reviewed by a person. The Compliance Matrix tab tracks ${data.proposal.verifiedRequirements} verified requirements.`,
      },
    })
  }
  if (data.contract) {
    steps.push({
      route: `/contracts/${data.contract.id}`,
      element: '[data-tour="contract-summary"]',
      popover: {
        title: 'Deliver the work',
        description: `${data.contract.title}${data.contract.awardValue ? `, worth ${money(data.contract.awardValue)}` : ''}. Deliverables, time, invoices and option periods are tracked in the tabs below.`,
      },
    })
  }
  steps.push(
    {
      route: '/analytics',
      element: '[data-tour="conversion-funnel"]',
      popover: {
        title: 'Measure what works',
        description: 'How opportunities become wins, stage by stage, with win rates by agency and a revenue forecast.',
      },
    },
    {
      route: '/dashboard',
      popover: {
        title: 'You’re ready',
        description: 'Try anything you like. You can replay this tour from the bar at the top of the page.',
      },
    },
  )
  return steps
}

async function waitFor(selector: string | undefined, timeoutMs = 8000): Promise<void> {
  if (!selector) return
  const started = Date.now()
  while (Date.now() - started < timeoutMs) {
    if (document.querySelector(selector)) return
    await new Promise((resolve) => window.setTimeout(resolve, 100))
  }
}

async function moveTo(tour: Driver, steps: TourStep[], index: number, forward: boolean): Promise<void> {
  const step = steps[index]
  if (!step) {
    tour.destroy()
    return
  }
  goTo(step.route)
  await waitFor(typeof step.element === 'string' ? step.element : undefined)
  if (forward) tour.moveNext()
  else tour.movePrevious()
}

let starting = false

export async function startDemoTour(): Promise<void> {
  if (starting) return
  starting = true
  let data: DemoTourData
  try {
    data = await demoApi.tour()
  } catch {
    data = { clients: 0, openOpportunities: 0, topOpportunity: null, proposal: null, contract: null }
  } finally {
    starting = false
  }
  const steps = buildSteps(data)
  const tour = driver({
    showProgress: true,
    allowClose: true,
    nextBtnText: 'Next',
    prevBtnText: 'Back',
    doneBtnText: 'Finish',
    steps,
    onNextClick: (_element, _step, { driver: current }) => {
      void moveTo(current, steps, (current.getActiveIndex() ?? 0) + 1, true)
    },
    onPrevClick: (_element, _step, { driver: current }) => {
      void moveTo(current, steps, (current.getActiveIndex() ?? 0) - 1, false)
    },
  })
  goTo(steps[0].route)
  tour.drive()
}
