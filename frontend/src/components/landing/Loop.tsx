// =============================================================
// How it works — the five stages from notice to award. This is a real
// sequence, so the steps are numbered. Beside it, an example of where a
// firm's notices sit across those stages.
// =============================================================
import { SectionHeading } from './shared'
import { Rise, Stagger, StaggerItem } from './motion'

const STEPS = [
  { title: 'Discover', text: 'SAM.gov and FPDS notices land every morning, matched to each client\'s NAICS codes and set-asides.' },
  { title: 'Qualify', text: 'An eight-factor win probability, calibrated to the client\'s own outcomes, with a bid or no-bid call.' },
  { title: 'Comply', text: 'Clause extraction and a FAR and DFARS matrix that stays current through every amendment.' },
  { title: 'Propose', text: 'Outlines, win themes and full drafts, priced against public award history before you submit.' },
  { title: 'Perform', text: 'Deliverables, modifications and receivables after award, so the next bid starts from evidence.' },
]

// Illustrative counts for one firm's month.
const FUNNEL = [
  { stage: 'Notices matched', n: 412 },
  { stage: 'Qualified to bid', n: 38 },
  { stage: 'Compliance matrix built', n: 14 },
  { stage: 'Proposals submitted', n: 9 },
  { stage: 'Awards in delivery', n: 3 },
]

export function Loop() {
  const max = FUNNEL[0].n
  return (
    <section id="how-it-works" className="lp-container py-20 lg:py-28">
      <SectionHeading
        title="From notice to award, one loop."
        sub="Each outcome, won or lost, recalibrates the model. The engine learns where your firm actually wins."
      />
      <div className="mt-12 grid gap-4 lg:grid-cols-[minmax(0,1.15fr)_minmax(0,1fr)]">
        <div className="lp-surface">
          <Stagger as="ol" className="lp-rule-list" stagger={0.06} amount={0.1}>
            {STEPS.map((s, i) => (
              <StaggerItem as="li" key={s.title} className="lp-step">
                <span className="lp-step-n" aria-hidden="true">{i + 1}</span>
                <div>
                  <h3 className="lp-step-t">{s.title}</h3>
                  <p className="lp-muted mt-1 text-[15px] leading-[23px]">{s.text}</p>
                </div>
              </StaggerItem>
            ))}
          </Stagger>
        </div>

        <Rise className="lp-surface flex flex-col">
          <figure className="flex h-full flex-col">
            <div role="img" aria-label="Example month for one firm: 412 notices matched, 38 qualified, 14 compliance matrices, 9 proposals submitted, 3 awards in delivery">
              <h3 className="lp-h3">One firm, one month</h3>
              <div className="lp-rule-list mt-6">
                {FUNNEL.map((f) => (
                  <div key={f.stage} className="py-4">
                    <div className="flex items-baseline justify-between gap-4">
                      <span className="text-[15px]" style={{ color: 'var(--text-2)' }}>{f.stage}</span>
                      <span className="lp-num text-xl font-semibold tracking-[-0.02em]">{f.n}</span>
                    </div>
                    <div className="lp-bar mt-2.5"><i style={{ width: `${Math.max(2, (f.n / max) * 100)}%` }} /></div>
                  </div>
                ))}
              </div>
            </div>
            <figcaption className="lp-muted mt-auto pt-6 text-[13px]">Illustrative figures.</figcaption>
          </figure>
        </Rise>
      </div>
    </section>
  )
}
