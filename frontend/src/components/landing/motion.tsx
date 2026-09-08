// =============================================================
// Bytescon landing motion language (framer-motion + Lenis).
//
//   MotionProvider  — lazy DOM animation features, respects reduced motion
//   SmoothScroll    — Lenis inertia scrolling (off under reduced motion / jsdom)
//   Rise            — "ink rise": content wipes up out of its own baseline
//   Stagger/Item    — staggered ink-rise children
//   RiseWords       — word-by-word rise out of a masked line (headlines)
//   Parallax        — scroll-linked drift through motion values
//   Aperture        — scroll-scrubbed figure reveal: the frame opens like a lens
//   Sheet           — a light section settles on top of the dark one below it
//   Tilt            — pointer-driven tilt for a single floating element
//   NumberTicker    — counts up in view, re-animates when the value changes
//   Roll            — value change rolls vertically like a split-flap display
//   Marquee         — pure-CSS ticker
//   useActiveSection— which section is on screen (header indicator)
// =============================================================
import { useEffect, useRef, useState, type CSSProperties, type PointerEvent, type ReactNode } from 'react'
import {
  LazyMotion, MotionConfig, domAnimation, m, animate, AnimatePresence,
  useScroll, useTransform, useMotionValue, useSpring, useReducedMotion, useInView,
} from 'framer-motion'
import Lenis from 'lenis'

export const EASE = [0.22, 1, 0.36, 1] as const

export function MotionProvider({ children }: { children: ReactNode }) {
  return (
    <LazyMotion features={domAnimation} strict>
      <MotionConfig reducedMotion="user">{children}</MotionConfig>
    </LazyMotion>
  )
}

/* ---------- Smooth scroll ---------- */
let lenis: Lenis | null = null

export function scrollToId(id: string, offset = -72) {
  if (typeof document === 'undefined') return
  const el = document.getElementById(id)
  if (!el) return
  if (lenis) { lenis.scrollTo(el, { offset }); return }
  const reduce = typeof window.matchMedia === 'function' && window.matchMedia('(prefers-reduced-motion: reduce)').matches
  window.scrollTo({ top: el.getBoundingClientRect().top + window.scrollY + offset, behavior: reduce ? 'auto' : 'smooth' })
}

export function SmoothScroll({ children }: { children: ReactNode }) {
  useEffect(() => {
    if (typeof window === 'undefined' || /jsdom/i.test(navigator.userAgent)) return
    if (typeof window.matchMedia === 'function' && window.matchMedia('(prefers-reduced-motion: reduce)').matches) return
    let instance: Lenis
    try { instance = new Lenis({ lerp: 0.09, syncTouch: false }) } catch { return }
    lenis = instance
    let raf = requestAnimationFrame(function loop(t) { instance.raf(t); raf = requestAnimationFrame(loop) })
    return () => { cancelAnimationFrame(raf); instance.destroy(); lenis = null }
  }, [])
  return <>{children}</>
}

type Tag = 'div' | 'li' | 'ol' | 'ul' | 'span' | 'p' | 'section' | 'article' | 'figure'
const tag = (t: Tag) => (m as unknown as Record<string, typeof m.div>)[t] ?? m.div

/* ---------- Ink rise ---------- */
const RISE_HIDDEN = { opacity: 0, y: 26, clipPath: 'inset(0% 0% 100% 0%)' }
const RISE_SHOWN = { opacity: 1, y: 0, clipPath: 'inset(-2% 0% -2% 0%)' }

export function Rise({ children, className, delay = 0, as = 'div', once = true, amount = 0.2, style, id }: {
  children: ReactNode; className?: string; delay?: number; as?: Tag; once?: boolean; amount?: number; style?: CSSProperties; id?: string
}) {
  const T = tag(as)
  // The observed element stays unclipped: IntersectionObserver honours
  // clip-path, so a fully clipped box would never count as visible. The
  // inner element carries the animation.
  return (
    <T id={id} className={className} style={style} initial="hidden" whileInView="visible" viewport={{ once, amount }}>
      <m.div variants={{ hidden: RISE_HIDDEN, visible: { ...RISE_SHOWN, transition: { duration: 0.85, delay: delay / 1000, ease: EASE } } }}>
        {children}
      </m.div>
    </T>
  )
}

export function Stagger({ children, className, stagger = 0.09, delay = 0, once = true, amount = 0.15, as = 'div' }: {
  children: ReactNode; className?: string; stagger?: number; delay?: number; once?: boolean; amount?: number; as?: Tag
}) {
  const T = tag(as)
  return (
    <T className={className} initial="hidden" whileInView="visible" viewport={{ once, amount }} variants={{ hidden: {}, visible: { transition: { staggerChildren: stagger, delayChildren: delay } } }}>
      {children}
    </T>
  )
}

export function StaggerItem({ children, className, as = 'div' }: { children: ReactNode; className?: string; as?: Tag }) {
  const T = tag(as)
  return (
    <T className={className} variants={{ hidden: RISE_HIDDEN, visible: { ...RISE_SHOWN, transition: { duration: 0.75, ease: EASE } } }}>
      {children}
    </T>
  )
}

/** Each word rises out of its own masked line. Words start at opacity 0.001 so the LCP element still counts as painted. */
export function RiseWords({ text, className, wordClassName = '', stagger = 0.07, delay = 0, trigger = 'view' }: {
  text: string; className?: string; wordClassName?: string; stagger?: number; delay?: number; trigger?: 'mount' | 'view'
}) {
  const words = text.split(' ')
  return (
    <m.span
      className={className}
      aria-label={text}
      initial="hidden"
      {...(trigger === 'mount' ? { animate: 'visible' } : { whileInView: 'visible', viewport: { once: true, amount: 0.5 } })}
      variants={{ hidden: {}, visible: { transition: { staggerChildren: stagger, delayChildren: delay } } }}
    >
      {words.map((word, i) => (
        <span key={`${word}-${i}`} aria-hidden>
          {/* The space lives outside the overflow-hidden wrapper, where it still renders. */}
          <span className="lp-word-wrap">
            <m.span
              className={`inline-block ${wordClassName}`}
              variants={{
                hidden: { opacity: 0.001, y: '112%', rotate: 4 },
                visible: { opacity: 1, y: 0, rotate: 0, transition: { duration: 0.9, ease: EASE } },
              }}
            >
              {word}
            </m.span>
          </span>
          {' '}
        </span>
      ))}
      {' '}
    </m.span>
  )
}

/* ---------- Parallax ---------- */
export function Parallax({ children, speed = 0.2, className, style }: { children: ReactNode; speed?: number; className?: string; style?: CSSProperties }) {
  const ref = useRef<HTMLDivElement>(null)
  const { scrollYProgress } = useScroll({ target: ref, offset: ['start end', 'end start'] })
  const y = useTransform(scrollYProgress, [0, 1], [speed * 120, speed * -120])
  return <m.div ref={ref} className={className} style={{ ...style, y }}>{children}</m.div>
}

/* ---------- Aperture: the frame opens like a lens as it scrolls in ---------- */
export function Aperture({ children, className, radius = 28 }: { children: ReactNode; className?: string; radius?: number }) {
  const ref = useRef<HTMLDivElement>(null)
  const reduced = useReducedMotion()
  const { scrollYProgress } = useScroll({ target: ref, offset: ['start 95%', 'start 40%'] })
  const clipPath = useTransform(scrollYProgress, [0, 1], [`inset(14% 22% 14% 22% round ${radius}px)`, `inset(0% 0% 0% 0% round ${radius}px)`])
  const scale = useTransform(scrollYProgress, [0, 1], [1.08, 1])
  if (reduced) return <div ref={ref} className={className}>{children}</div>
  return <m.div ref={ref} className={className} style={{ clipPath, scale }}>{children}</m.div>
}

/* ---------- Sheet: a light section settles onto the page ---------- */
export function Sheet({ children, className = '', id }: { children: ReactNode; className?: string; id?: string }) {
  const ref = useRef<HTMLElement>(null)
  const reduced = useReducedMotion()
  const { scrollYProgress } = useScroll({ target: ref, offset: ['start end', 'start 20%'] })
  const scale = useTransform(scrollYProgress, [0, 1], [0.965, 1])
  const y = useTransform(scrollYProgress, [0, 1], [36, 0])
  return (
    <m.section ref={ref} id={id} className={`lp-sheet ${className}`} style={reduced ? undefined : { scale, y, transformOrigin: '50% 0%' }}>
      {children}
    </m.section>
  )
}

/* ---------- Tilt: pointer-driven tilt for one floating element ---------- */
export function Tilt({ children, className, maxTilt = 8 }: { children: ReactNode; className?: string; maxTilt?: number }) {
  const reduced = useReducedMotion()
  const rectRef = useRef<DOMRect | null>(null)
  const rx = useMotionValue(0)
  const ry = useMotionValue(0)
  const sx = useSpring(rx, { stiffness: 200, damping: 20 })
  const sy = useSpring(ry, { stiffness: 200, damping: 20 })
  const isMouse = (e: PointerEvent) => e.pointerType === 'mouse' && !reduced
  return (
    <div style={{ perspective: 900 }} className={className}>
      <m.div
        style={{ rotateX: sx, rotateY: sy, transformStyle: 'preserve-3d' }}
        onPointerEnter={(e) => { if (isMouse(e)) rectRef.current = e.currentTarget.getBoundingClientRect() }}
        onPointerMove={(e) => {
          if (!isMouse(e) || !rectRef.current) return
          const r = rectRef.current
          ry.set(((e.clientX - r.left) / r.width - 0.5) * 2 * maxTilt)
          rx.set(-((e.clientY - r.top) / r.height - 0.5) * 2 * maxTilt)
        }}
        onPointerLeave={() => { rx.set(0); ry.set(0) }}
      >
        {children}
      </m.div>
    </div>
  )
}

/* ---------- NumberTicker ---------- */
export function NumberTicker({ value, prefix = '', suffix = '', decimals = 0, duration = 1.4, className }: {
  value: number; prefix?: string; suffix?: string; decimals?: number; duration?: number; className?: string
}) {
  const ref = useRef<HTMLSpanElement>(null)
  const inView = useInView(ref, { once: true, margin: '-40px' })
  const reduced = useReducedMotion()
  const mv = useMotionValue(0)
  const text = useTransform(mv, (v) => `${prefix}${v.toLocaleString('en-US', { minimumFractionDigits: decimals, maximumFractionDigits: decimals })}${suffix}`)
  useEffect(() => {
    if (!inView) return
    if (reduced) { mv.set(value); return }
    const c = animate(mv, value, { duration, ease: 'easeOut' })
    return () => c.stop()
  }, [inView, value, reduced, duration, mv])
  return <m.span ref={ref} className={className} style={{ fontVariantNumeric: 'tabular-nums' }}>{text}</m.span>
}

/* ---------- Roll: value changes roll vertically ---------- */
export function Roll({ value, className }: { value: string | number; className?: string }) {
  return (
    <span className={`lp-roll ${className ?? ''}`}>
      <AnimatePresence mode="popLayout" initial={false}>
        <m.span
          key={String(value)}
          className="inline-block"
          initial={{ y: '0.7em', opacity: 0 }}
          animate={{ y: 0, opacity: 1 }}
          exit={{ y: '-0.7em', opacity: 0 }}
          transition={{ duration: 0.4, ease: EASE }}
        >
          {value}
        </m.span>
      </AnimatePresence>
    </span>
  )
}

/* ---------- Marquee ---------- */
export function Marquee({ children, reverse = false, duration = 48, className = '' }: { children: ReactNode; reverse?: boolean; duration?: number; className?: string }) {
  const reduced = useReducedMotion()
  if (reduced) return <div className={`flex flex-wrap justify-center gap-3 ${className}`}>{children}</div>
  return (
    <div className={`lp-marquee ${className}`}>
      <div className={`lp-marquee-track ${reverse ? 'is-reverse' : ''}`} style={{ '--lp-marquee-duration': `${duration}s` } as CSSProperties}>
        <div className="flex shrink-0 gap-3 pr-3">{children}</div>
        <div className="flex shrink-0 gap-3 pr-3" aria-hidden>{children}</div>
      </div>
    </div>
  )
}

/* ---------- Active section (header indicator) ---------- */
export function useActiveSection(ids: string[]): string | null {
  const [active, setActive] = useState<string | null>(null)
  useEffect(() => {
    if (typeof IntersectionObserver === 'undefined') return
    const els = ids.map((id) => document.getElementById(id)).filter((el): el is HTMLElement => !!el)
    const obs = new IntersectionObserver((entries) => {
      for (const e of entries) if (e.isIntersecting) setActive(e.target.id)
    }, { rootMargin: '-40% 0px -55% 0px' })
    els.forEach((el) => obs.observe(el))
    return () => obs.disconnect()
  }, [ids])
  return active
}
