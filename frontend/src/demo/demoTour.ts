import { driver, type DriveStep } from 'driver.js'
import 'driver.js/dist/driver.css'

// A short walk through the main areas of the product. Steps point at the sidebar,
// so they keep working as pages change. A step whose target isn't on screen, such
// as on a phone where the sidebar is closed, shows in the middle of the page.
const STEPS: DriveStep[] = [
  {
    popover: {
      title: 'Welcome to Bytescon',
      description: 'A quick look at how a federal contract goes from first sighting to delivery. It takes about a minute.',
    },
  },
  {
    element: 'a[href="/dashboard"]',
    popover: { title: 'Dashboard', description: 'Your day at a glance: top opportunities, upcoming deadlines and pipeline value.' },
  },
  {
    element: 'a[href="/opportunities"]',
    popover: { title: 'Find opportunities', description: 'Federal contracts, each scored for how well they fit your clients. Open one to see why it scored that way.' },
  },
  {
    element: 'a[href="/decisions"]',
    popover: { title: 'Decide what to bid', description: 'A bid or no-bid recommendation with the reasons behind it. People make the final call.' },
  },
  {
    element: 'a[href="/pipeline"]',
    popover: { title: 'Track your pursuits', description: 'Every pursuit by stage, with owners and next steps. Your demo has some already in progress.' },
  },
  {
    element: '[data-tour-section="Clients"]',
    popover: { title: 'Clients and partners', description: 'The companies you advise, plus the partners you team with.' },
  },
  {
    element: '[data-tour-section="Proposals"]',
    popover: { title: 'Write proposals', description: 'AI-assisted drafts built from your own approved content. A person always reviews them.' },
  },
  {
    element: '[data-tour-section="Delivery"]',
    popover: { title: 'Deliver the work', description: 'After the award: contracts, deliverables, timekeeping and invoicing.' },
  },
  {
    popover: {
      title: 'You’re ready',
      description: 'Try anything you like. You can replay this tour from the bar at the top of the page.',
    },
  },
]

export function startDemoTour(): void {
  driver({
    showProgress: true,
    allowClose: true,
    nextBtnText: 'Next',
    prevBtnText: 'Back',
    doneBtnText: 'Finish',
    steps: STEPS,
  }).drive()
}
