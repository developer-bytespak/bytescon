// =============================================================
// How it works — a gold "loop" line draws down the list as you scroll,
// lighting each step's number as it passes; the figure opens like a lens.
// The section settles onto the page as a sheet.
// =============================================================
import { useRef } from 'react'
import { m, useScroll, useTransform, type MotionValue } from 'framer-motion'
import { SectionHeading } from './shared'
import { Sheet, Stagger, StaggerItem, Aperture, Parallax } from './motion'

const STEPS = [
  { title: 'Discover', text: 'SAM.gov and FPDS notices land every morning, matched to each client\'s NAICS codes and set-asides.' },
  { title: 'Qualify', text: 'An eight-factor win probability, calibrated to the client\'s own outcomes, with a bid / no-bid call.' },
  { title: 'Comply', text: 'Clause extraction and a FAR / DFARS matrix that stays current through every amendment.' },
  { title: 'Propose', text: 'Outlines, win themes and full drafts, priced against public award history before you submit.' },
  { title: 'Perform', text: 'Deliverables, modifications and receivables after award, so the next bid starts from evidence.' },
]

function StepNumber({ index, progress }: { index: number; progress: MotionValue<number> }) {
  const n = STEPS.length
  const color = useTransform(progress, [index / n, (index + 0.5) / n], ['#8f8a99', '#3d5afe'])
  const scale = useTransform(progress, [index / n, (index + 0.5) / n], [1, 1.18])
  return <m.span className="lp-step-n" style={{ color, scale, transformOrigin: 'left center' }}>0{index + 1}</m.span>
}

export function Loop() {
  const listRef = useRef<HTMLOListElement>(null)
  const { scrollYProgress } = useScroll({ target: listRef, offset: ['start 75%', 'end 55%'] })

  return (
    <Sheet id="how-it-works" className="lp-light py-24 lg:py-36">
      <div className="lp-container grid items-center gap-16 lg:grid-cols-[minmax(0,1.1fr)_minmax(0,0.9fr)] lg:gap-24">
        <div>
          <SectionHeading
            eyebrow="How it works"
            title={<>From notice to award, <span className="lp-italic">one loop.</span></>}
            sub="Each outcome, won or lost, recalibrates the model. The engine learns where your firm actually wins."
          />
          <div className="relative mt-12">
            {/* The loop line: grows with scroll along the numbers column. */}
            <div className="lp-loop-track" aria-hidden="true">
              <m.i style={{ scaleY: scrollYProgress }} />
            </div>
            <Stagger as="ol" className="relative" stagger={0.09} amount={0.1}>
              <ol ref={listRef} className="contents">
                {STEPS.map((s, i) => (
                  <StaggerItem as="li" key={s.title} className="lp-step">
                    <StepNumber index={i} progress={scrollYProgress} />
                    <div>
                      <h3 className="lp-step-t">{s.title}</h3>
                      <p className="lp-muted mt-1.5 text-[15px] leading-relaxed">{s.text}</p>
                    </div>
                  </StaggerItem>
                ))}
              </ol>
            </Stagger>
          </div>
        </div>

        <Aperture className="lp-figure-wrap lg:mt-8">
          <Parallax speed={0.12}>
            <figure className="lp-figure">
              <img src="/landing/loop.jpg" alt="The National Mall at night, drawn as a constellation of agencies connected by light" loading="lazy" decoding="async" />
              <figcaption className="lp-figure-caption">Every agency, one map</figcaption>
            </figure>
          </Parallax>
        </Aperture>
      </div>
    </Sheet>
  )
}
