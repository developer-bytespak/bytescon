// =============================================================
// Hero — the image is unveiled by a curtain on load, drifts with the
// pointer for depth and with scroll for parallax; the serif headline rises
// word by word out of masked lines; the score chip floats and tilts.
// Followed by a stat strip with number tickers and a signal ticker.
// =============================================================
import { useRef, type CSSProperties, type PointerEvent } from 'react'
import { Link } from 'react-router-dom'
import { m, useMotionValue, useReducedMotion, useScroll, useSpring, useTransform } from 'framer-motion'
import { ArrowRight, ArrowDown } from 'lucide-react'
import { EASE, RiseWords, NumberTicker, Tilt, Marquee, Rise, scrollToId } from './motion'

interface StatDef { value: number; prefix?: string; suffix?: string; label: string; source?: string }
const STATS: StatDef[] = [
  { value: 179, prefix: '$', suffix: 'B', label: 'in prime contracts awarded to small businesses in FY2025', source: 'SBA FY2025 Small Business Procurement Scorecard' },
  { value: 28, suffix: '%', label: 'of every federal prime contract dollar went to a small firm', source: 'SBA FY2025 Small Business Procurement Scorecard' },
  { value: 9, label: 'opt-in agents, each one writing to your audit trail' },
]

const SIGNALS = ['USACE', 'VA', 'DHS', 'GSA', 'NIH', 'USAF', 'NAVSEA', 'DLA', 'SDVOSB', '8(a)', 'HUBZone', 'WOSB', 'FAR', 'DFARS', 'SAM.gov', 'FPDS', 'USAspending']

const rise = (delay: number) => ({
  initial: { opacity: 0.001, y: 22, clipPath: 'inset(0% 0% 100% 0%)' },
  animate: { opacity: 1, y: 0, clipPath: 'inset(-2% 0% -2% 0%)' },
  transition: { duration: 0.85, delay, ease: EASE },
})

export function Hero() {
  const heroRef = useRef<HTMLElement>(null)
  const reduced = useReducedMotion()

  // Scroll parallax: the image sinks and grows, the copy lifts and fades.
  const { scrollYProgress } = useScroll({ target: heroRef, offset: ['start start', 'end start'] })
  const imgY = useTransform(scrollYProgress, [0, 1], ['0%', '18%'])
  const imgScale = useTransform(scrollYProgress, [0, 1], [1.06, 1.18])
  const copyY = useTransform(scrollYProgress, [0, 1], [0, -70])
  const copyOpacity = useTransform(scrollYProgress, [0, 0.55], [1, 0])

  // Pointer depth: image and chip move in opposite directions.
  const px = useMotionValue(0)
  const py = useMotionValue(0)
  const sx = useSpring(px, { stiffness: 60, damping: 20 })
  const sy = useSpring(py, { stiffness: 60, damping: 20 })
  const imgX = useTransform(sx, [-1, 1], [14, -14])
  const imgPointerY = useTransform(sy, [-1, 1], [10, -10])
  const chipX = useTransform(sx, [-1, 1], [-18, 18])
  const chipY = useTransform(sy, [-1, 1], [-12, 12])
  const onMove = (e: PointerEvent<HTMLElement>) => {
    if (reduced || e.pointerType !== 'mouse') return
    const r = e.currentTarget.getBoundingClientRect()
    px.set(((e.clientX - r.left) / r.width) * 2 - 1)
    py.set(((e.clientY - r.top) / r.height) * 2 - 1)
  }
  const onLeave = () => { px.set(0); py.set(0) }

  return (
    <>
      <section id="top" ref={heroRef} className="lp-hero lp-dark" onPointerMove={onMove} onPointerLeave={onLeave}>
        {/* Curtain: the image is unveiled from the bottom edge upward on load. */}
        <m.div
          className="absolute inset-0 overflow-hidden"
          initial={{ clipPath: 'inset(100% 0% 0% 0%)' }}
          animate={{ clipPath: 'inset(0% 0% 0% 0%)' }}
          transition={{ duration: 1.4, ease: EASE }}
        >
          <m.img src="/landing/hero.jpg" alt="" className="lp-hero-img" decoding="async" style={{ y: imgY, x: imgX, scale: imgScale }} />
          <m.div className="absolute inset-0" style={{ y: imgPointerY }} aria-hidden="true" />
        </m.div>
        <div className="lp-hero-shade" aria-hidden="true" />
        <div className="lp-grain" aria-hidden="true" />

        <m.div className="lp-container relative w-full pb-20 pt-44 lg:pb-28 lg:pt-52" style={{ y: copyY, opacity: copyOpacity }}>
          <m.p className="lp-eyebrow" {...rise(0.5)}>Federal contracting intelligence</m.p>
          <h1 className="lp-display mt-7 max-w-[11ch] text-[3.1rem] sm:text-[4.6rem] lg:text-[6.2rem]">
            <RiseWords text="Know your odds" trigger="mount" delay={0.65} />
            <RiseWords text="before you bid." trigger="mount" delay={0.95} wordClassName="lp-italic" />
          </h1>
          <m.p className="mt-8 max-w-md text-base leading-relaxed sm:text-lg" style={{ color: 'var(--lp-fog)' }} {...rise(1.35)}>
            Bytescon scores every federal solicitation, builds the compliance matrix and drafts the proposal,
            with the reasoning shown at every step.
          </m.p>
          <m.div className="mt-10 flex flex-col gap-3 sm:flex-row sm:items-center" {...rise(1.5)}>
            <Link to="/register" className="lp-btn lp-btn-primary lp-btn-lg lp-shine">Start free trial <ArrowRight className="h-4 w-4" /></Link>
            <button type="button" className="lp-btn lp-btn-ghost lp-btn-lg lp-beam" style={{ borderColor: 'var(--lp-line-dark)' }} onClick={() => scrollToId('how-it-works')}>
              How it works <ArrowDown className="h-4 w-4 lp-bounce-y" />
            </button>
          </m.div>
          <m.p className="lp-mono mt-8" style={{ color: 'var(--lp-dim)' }} {...rise(1.65)}>14 days free · no card · every module unlocked</m.p>
        </m.div>

        <m.div
          className="lp-hero-chip-pos hidden lg:block"
          style={{ x: chipX, y: chipY }}
          initial={{ opacity: 0, y: 30, clipPath: 'inset(0% 0% 100% 0% round 24px)' }}
          animate={{ opacity: 1, y: 0, clipPath: 'inset(0% 0% 0% 0% round 24px)' }}
          transition={{ duration: 0.9, delay: 1.7, ease: EASE }}
        >
          <Tilt maxTilt={9}>
            <aside className="lp-hero-chip lp-float" aria-label="Example calibrated score">
              <p className="lp-mono" style={{ color: 'var(--lp-fog)' }}>W912DY-26-R-0041 · USACE</p>
              <p className="lp-display mt-3 text-[3.4rem] leading-none"><NumberTicker value={71} duration={1.8} /><span className="lp-italic text-4xl">%</span></p>
              <p className="lp-mono mt-2" style={{ color: 'var(--lp-gold-2)' }}>P(win) · calibrated · bid</p>
              <div className="lp-chip-bar mt-4"><i style={{ '--p': 0.71 } as CSSProperties} /></div>
            </aside>
          </Tilt>
        </m.div>
      </section>

      <div className="lp-dark">
        <div className="lp-container">
          <div className="grid gap-x-10 border-t border-[var(--lp-line-dark)] sm:grid-cols-3">
            {STATS.map((s, i) => (
              <Rise key={s.label} delay={i * 120} className="py-8" style={{ minWidth: 0 }}>
                <p className="lp-stat-n" title={s.source}>
                  <NumberTicker value={s.value} prefix={s.prefix ?? ''} />
                  <b>{s.suffix}</b>
                </p>
                <p className="lp-muted mt-3 max-w-[18rem] text-sm leading-relaxed">{s.label}</p>
              </Rise>
            ))}
          </div>
        </div>
        <div className="border-y border-[var(--lp-line-dark)] py-4">
          <Marquee duration={64}>
            {SIGNALS.map((s) => (
              <span key={s} className="lp-mono rounded-full px-3.5 py-1.5" style={{ color: 'var(--lp-fog)', border: '1px solid var(--lp-line-dark)' }}>{s}</span>
            ))}
          </Marquee>
        </div>
      </div>
    </>
  )
}
