// =============================================================
// Hero — full-bleed cinematic image, one serif headline, one sentence,
// two actions. A single floating score chip stands in for the product.
// Followed by a hairline stat strip.
// =============================================================
import type { CSSProperties } from 'react'
import { Link } from 'react-router-dom'
import { ArrowRight, ArrowDown } from 'lucide-react'
import { Words, useInView, useCountUp, scrollToId } from './shared'

interface StatDef { value: number; prefix?: string; suffix?: string; label: string; source?: string }
const STATS: StatDef[] = [
  { value: 179, prefix: '$', suffix: 'B', label: 'in prime contracts awarded to small businesses in FY2025', source: 'SBA FY2025 Small Business Procurement Scorecard' },
  { value: 28, suffix: '%', label: 'of every federal prime contract dollar went to a small firm', source: 'SBA FY2025 Small Business Procurement Scorecard' },
  { value: 9, label: 'opt-in agents, each one writing to your audit trail' },
]

function Stat({ stat, delay }: { stat: StatDef; delay: number }) {
  const { ref, inView } = useInView<HTMLDivElement>({ threshold: 0.5 })
  const n = useCountUp(stat.value, inView)
  return (
    <div ref={ref} className={`lp-reveal py-8 ${inView ? 'is-in' : ''}`} style={{ '--d': `${delay}ms` } as CSSProperties} title={stat.source}>
      <p className="lp-stat-n">{stat.prefix}{n}<b>{stat.suffix}</b></p>
      <p className="lp-muted mt-3 max-w-[18rem] text-sm leading-relaxed">{stat.label}</p>
    </div>
  )
}

export function Hero() {
  return (
    <>
      <section id="top" className="lp-hero lp-dark">
        <img src="/landing/hero.jpg" alt="" className="lp-hero-img" decoding="async" />
        <div className="lp-hero-shade" aria-hidden="true" />
        <div className="lp-grain" aria-hidden="true" />

        <div className="lp-container relative w-full pb-20 pt-44 lg:pb-28 lg:pt-52">
          <p className="lp-eyebrow lp-fade-up" style={{ '--d': '0ms' } as CSSProperties}>Federal contracting intelligence</p>
          <h1 className="lp-display mt-7 max-w-[11ch] text-[3.1rem] sm:text-[4.6rem] lg:text-[6.2rem]">
            <Words text="Know your odds" startDelay={120} />
            <Words text="before you bid." startDelay={420} wordClassName="lp-italic" />
          </h1>
          <p className="lp-fade-up mt-8 max-w-md text-base leading-relaxed sm:text-lg" style={{ '--d': '950ms', color: 'var(--lp-fog)' } as CSSProperties}>
            Bytescon scores every federal solicitation, builds the compliance matrix and drafts the proposal,
            with the reasoning shown at every step.
          </p>
          <div className="lp-fade-up mt-10 flex flex-col gap-3 sm:flex-row sm:items-center" style={{ '--d': '1100ms' } as CSSProperties}>
            <Link to="/register" className="lp-btn lp-btn-primary lp-btn-lg">Start free trial <ArrowRight className="h-4 w-4" /></Link>
            <button type="button" className="lp-btn lp-btn-ghost lp-btn-lg lp-beam" style={{ borderColor: 'var(--lp-line-dark)' }} onClick={() => scrollToId('how-it-works')}>
              How it works <ArrowDown className="h-4 w-4" />
            </button>
          </div>
          <p className="lp-mono lp-fade-up mt-8" style={{ '--d': '1250ms', color: 'var(--lp-dim)' } as CSSProperties}>14 days free · no card · every module unlocked</p>
        </div>

        <aside className="lp-hero-chip hidden lg:block" aria-label="Example calibrated score">
          <p className="lp-mono" style={{ color: 'var(--lp-fog)' }}>W912DY-26-R-0041 · USACE</p>
          <p className="lp-display mt-3 text-[3.4rem] leading-none">71<span className="lp-italic text-4xl">%</span></p>
          <p className="lp-mono mt-2" style={{ color: 'var(--lp-gold-2)' }}>P(win) · calibrated · bid</p>
          <div className="lp-chip-bar mt-4"><i style={{ '--p': 0.71 } as CSSProperties} /></div>
        </aside>
      </section>

      <div className="lp-dark">
        <div className="lp-container">
          <div className="grid gap-x-10 border-t border-[var(--lp-line-dark)] sm:grid-cols-3">
            {STATS.map((s, i) => <Stat key={s.label} stat={s} delay={i * 120} />)}
          </div>
        </div>
      </div>
    </>
  )
}
