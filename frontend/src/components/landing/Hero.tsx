// =============================================================
// Hero — one idea: know your odds before you bid. The headline sits in
// a white surface; beside it, a blue surface shows what that means in the
// product (a calibrated score on a real-looking notice). A row of three
// sourced figures follows.
// =============================================================
import { Link } from 'react-router-dom'
import { Rise, NumberTicker, scrollToId } from './motion'

interface StatDef { value: number; prefix?: string; suffix?: string; label: string; source?: string }
const STATS: StatDef[] = [
  { value: 179, prefix: '$', suffix: 'B', label: 'in prime contracts awarded to small businesses in FY2025', source: 'SBA FY2025 Small Business Procurement Scorecard' },
  { value: 28, suffix: '%', label: 'of every federal prime contract dollar went to a small firm', source: 'SBA FY2025 Small Business Procurement Scorecard' },
  { value: 9, label: 'opt-in agents, each one writing to your audit trail' },
]

const FACTORS = [
  { name: 'NAICS and past performance', pct: 82 },
  { name: 'Set-aside eligibility', pct: 100 },
  { name: 'Incumbent strength', pct: 46 },
]

export function Hero() {
  return (
    <section id="top" className="lp-container pt-4 pb-4 lg:pt-8">
      <div className="grid gap-4 lg:grid-cols-[minmax(0,1.45fr)_minmax(0,1fr)]">
        <div className="lp-surface flex flex-col justify-between gap-12" style={{ padding: 'clamp(28px, 4.5vw, 56px)' }}>
          <div>
            <h1 className="lp-display lp-hero-title max-w-[11ch]">Know your odds before you bid.</h1>
            <p className="lp-lede mt-7 max-w-xl">
              Bytesgov scores every federal solicitation, builds the compliance matrix and drafts the proposal,
              with the reasoning shown at every step.
            </p>
          </div>
          <div>
            <div className="flex flex-col gap-3 sm:flex-row sm:items-center">
              <Link to="/register" className="lp-btn lp-btn-dark lp-btn-lg">Start free trial</Link>
              <button type="button" className="lp-btn lp-btn-light lp-btn-lg" onClick={() => scrollToId('how-it-works')}>
                How it works
              </button>
            </div>
            <p className="lp-muted mt-5 text-sm">14 days free, no card, every module unlocked.</p>
          </div>
        </div>

        {/* What "your odds" looks like in the product. Illustrative numbers. */}
        <figure className="lp-surface lp-surface-blue flex flex-col justify-between gap-10" style={{ padding: 'clamp(28px, 3.5vw, 44px)' }}>
          <div role="img" aria-label="Example: a USACE solicitation scored at 71% win probability, with a recommendation to bid">
            <div className="flex flex-wrap gap-2">
              <span className="lp-tag">W912DY-26-R-0041</span>
              <span className="lp-tag">USACE</span>
              <span className="lp-tag">541330</span>
            </div>
            <p className="lp-figure-n mt-10"><NumberTicker value={71} duration={1.2} /><small>%</small></p>
            <p className="mt-3 text-[17px] font-medium">Win probability, calibrated to your firm's outcomes</p>
            <div className="lp-rule-list mt-8">
              {FACTORS.map((f) => (
                <div key={f.name} className="py-3">
                  <div className="flex items-baseline justify-between gap-4 text-sm">
                    <span>{f.name}</span>
                    <span className="lp-num" style={{ color: 'rgba(255,255,255,0.78)' }}>{f.pct}%</span>
                  </div>
                  <div className="lp-bar mt-2"><i style={{ width: `${f.pct}%` }} /></div>
                </div>
              ))}
            </div>
          </div>
          <figcaption className="flex items-center justify-between gap-4 text-sm" style={{ color: 'rgba(255,255,255,0.78)' }}>
            <span>Recommendation: bid</span>
            <span>Example score</span>
          </figcaption>
        </figure>
      </div>

      <div className="mt-4 grid gap-4 sm:grid-cols-3">
        {STATS.map((s, i) => (
          <Rise key={s.label} delay={i * 80} className="lp-surface" style={{ minWidth: 0 }}>
            <p className="lp-stat-n" title={s.source}>
              <NumberTicker value={s.value} prefix={s.prefix ?? ''} />{s.suffix}
            </p>
            <p className="lp-muted mt-4 max-w-[18rem] text-[15px] leading-[22px]">{s.label}</p>
          </Rise>
        ))}
      </div>
    </section>
  )
}
