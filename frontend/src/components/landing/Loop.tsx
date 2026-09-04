// =============================================================
// How it works — five stages as an editorial numbered list on the bone
// ground, opposite a parallax figure.
// =============================================================
import { Reveal, SectionHeading } from './shared'

const STEPS = [
  { title: 'Discover', text: 'SAM.gov and FPDS notices land every morning, matched to each client\'s NAICS codes and set-asides.' },
  { title: 'Qualify', text: 'An eight-factor win probability, calibrated to the client\'s own outcomes, with a bid / no-bid call.' },
  { title: 'Comply', text: 'Clause extraction and a FAR / DFARS matrix that stays current through every amendment.' },
  { title: 'Propose', text: 'Outlines, win themes and full drafts, priced against public award history before you submit.' },
  { title: 'Perform', text: 'Deliverables, modifications and receivables after award, so the next bid starts from evidence.' },
]

export function Loop() {
  return (
    <section id="how-it-works" className="lp-light py-24 lg:py-36">
      <div className="lp-container grid items-center gap-16 lg:grid-cols-[minmax(0,1.1fr)_minmax(0,0.9fr)] lg:gap-24">
        <div>
          <SectionHeading
            eyebrow="How it works"
            title={<>From notice to award, <span className="lp-italic">one loop.</span></>}
            sub="Each outcome, won or lost, recalibrates the model. The engine learns where your firm actually wins."
          />
          <ol className="mt-12">
            {STEPS.map((s, i) => (
              <Reveal as="li" key={s.title} delay={i * 80} className="lp-step">
                <span className="lp-step-n">0{i + 1}</span>
                <div>
                  <h3 className="lp-step-t">{s.title}</h3>
                  <p className="lp-muted mt-1.5 text-[15px] leading-relaxed">{s.text}</p>
                </div>
              </Reveal>
            ))}
          </ol>
        </div>

        <Reveal fx="scale" delay={120} className="lp-figure-wrap lg:mt-8">
          <figure className="lp-figure">
            <img src="/landing/loop.jpg" alt="The National Mall at night, drawn as a constellation of agencies connected by light" loading="lazy" decoding="async" />
            <figcaption className="lp-figure-caption">Every agency, one map</figcaption>
          </figure>
        </Reveal>
      </div>
    </section>
  )
}
