// =============================================================
// Landing primitives: in-view hook, reveal wrapper, word-by-word
// headline, count-up, brand mark. Everything degrades: no
// IntersectionObserver means "already in view", reduced motion means
// no timers.
// =============================================================
import { useEffect, useRef, useState, type CSSProperties, type ReactNode, type ElementType } from 'react'

export function prefersReducedMotion(): boolean {
  if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return false
  try { return window.matchMedia('(prefers-reduced-motion: reduce)').matches } catch { return false }
}

export function scrollToId(id: string) {
  if (typeof document === 'undefined') return
  const el = document.getElementById(id)
  if (el && typeof el.scrollIntoView === 'function') {
    el.scrollIntoView({ behavior: prefersReducedMotion() ? 'auto' : 'smooth', block: 'start' })
  }
}

export function useInView<T extends HTMLElement = HTMLDivElement>(opts: { once?: boolean; threshold?: number; rootMargin?: string } = {}) {
  const { once = true, threshold = 0.15, rootMargin = '0px 0px -6% 0px' } = opts
  const ref = useRef<T>(null)
  const [inView, setInView] = useState(false)
  useEffect(() => {
    const el = ref.current
    if (!el) return
    if (typeof IntersectionObserver === 'undefined') { setInView(true); return }
    const obs = new IntersectionObserver((entries) => {
      for (const e of entries) {
        if (e.isIntersecting) { setInView(true); if (once) obs.disconnect() } else if (!once) setInView(false)
      }
    }, { threshold, rootMargin })
    obs.observe(el)
    return () => obs.disconnect()
  }, [once, threshold, rootMargin])
  return { ref, inView }
}

interface RevealProps { as?: ElementType; children: ReactNode; className?: string; delay?: number; fx?: 'up' | 'scale' | 'left' | 'right'; id?: string; style?: CSSProperties }

export function Reveal({ as: Tag = 'div', children, className = '', delay = 0, fx = 'up', id, style }: RevealProps) {
  const { ref, inView } = useInView<HTMLElement>()
  return (
    <Tag ref={ref} id={id} data-fx={fx} className={`lp-reveal ${inView ? 'is-in' : ''} ${className}`} style={{ ...style, '--d': `${delay}ms` } as CSSProperties}>
      {children}
    </Tag>
  )
}

/** Timer-driven so it completes even where requestAnimationFrame is throttled. */
export function useCountUp(target: number, active: boolean, duration = 1500): string {
  const [value, setValue] = useState(0)
  useEffect(() => {
    if (!active) return
    if (prefersReducedMotion()) { setValue(target); return }
    const start = Date.now()
    const id = window.setInterval(() => {
      const t = Math.min(1, (Date.now() - start) / duration)
      setValue(target * (1 - Math.pow(1 - t, 3)))
      if (t >= 1) window.clearInterval(id)
    }, 33)
    return () => window.clearInterval(id)
  }, [target, active, duration])
  return value.toFixed(0)
}

/** Per-word slide-up. The class goes on each word (background-clip and
 *  italics need the leaf element) and the space sits outside the clip. */
export function Words({ text, startDelay = 0, step = 70, wordClassName = '' }: { text: string; startDelay?: number; step?: number; wordClassName?: string }) {
  return (
    <>
      {text.split(' ').map((word, i) => (
        <span key={`${word}-${i}`}>
          <span className="lp-word-wrap">
            <span className={`lp-word ${wordClassName}`} style={{ '--d': `${startDelay + i * step}ms` } as CSSProperties}>{word}</span>
          </span>
          {' '}
        </span>
      ))}
    </>
  )
}

export function SectionHeading({ eyebrow, title, sub }: { eyebrow: string; title: ReactNode; sub?: ReactNode }) {
  return (
    <div className="max-w-2xl">
      <Reveal><span className="lp-eyebrow">{eyebrow}</span></Reveal>
      <Reveal delay={90}>
        <h2 className="lp-display mt-5 text-[2.5rem] sm:text-5xl lg:text-[3.5rem]">{title}</h2>
      </Reveal>
      {sub && (
        <Reveal delay={180}>
          <p className="lp-muted mt-5 max-w-xl text-base leading-relaxed sm:text-lg">{sub}</p>
        </Reveal>
      )}
    </div>
  )
}

export function BrandMark({ size = 30, id = 'lp-mark' }: { size?: number; id?: string }) {
  return (
    <svg width={size} height={size} viewBox="0 0 64 64" fill="none" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">
      <defs>
        <linearGradient id={`${id}-g`} x1="0%" y1="0%" x2="100%" y2="100%">
          <stop offset="0%" stopColor="#f0d493" />
          <stop offset="100%" stopColor="#d3a54a" />
        </linearGradient>
      </defs>
      <path d="M12 6 L30 6 L48 32 L30 58 L12 58 L27 32 Z" fill={`url(#${id}-g)`} />
      <path d="M37 12 L45 12 L59 32 L45 52 L37 52 L51 32 Z" fill="#8c9cff" opacity="0.85" />
    </svg>
  )
}
