import { useState } from 'react'
import { Link } from 'react-router-dom'
import { AnimatePresence, m, useMotionValueEvent, useScroll } from 'framer-motion'
import { ArrowRight, Menu, X } from 'lucide-react'
import { useAuth } from '../../hooks/useAuth'
import { BrandMark } from './shared'
import { scrollToId, EASE, useActiveSection } from './motion'

const SECTION_IDS = ['how-it-works', 'agents', 'platform', 'pricing']

const NAV = [
  { id: 'how-it-works', label: 'How it works' },
  { id: 'agents', label: 'Agents' },
  { id: 'platform', label: 'Platform' },
  { id: 'pricing', label: 'Pricing' },
]

export function LandingHeader() {
  const [scrolled, setScrolled] = useState(false)
  const [open, setOpen] = useState(false)
  const { isAuthenticated } = useAuth()
  const { scrollY } = useScroll()
  const active = useActiveSection(SECTION_IDS)
  useMotionValueEvent(scrollY, 'change', (y) => setScrolled(y > 12))

  const go = (id: string) => { setOpen(false); scrollToId(id) }

  return (
    <m.header
      className={`lp-header ${scrolled || open ? 'is-scrolled' : ''}`}
      initial={{ y: -24, opacity: 0 }}
      animate={{ y: 0, opacity: 1 }}
      transition={{ duration: 0.6, ease: EASE, delay: 0.1 }}
    >
      <div className="lp-container flex h-16 items-center justify-between">
        <Link to="/" className="flex items-center gap-2.5 group" aria-label="Bytescon home">
          <span className="transition-transform duration-500 group-hover:scale-[1.06]"><BrandMark size={26} id="lp-hdr" /></span>
          <span className="lp-display text-[1.15rem]" style={{ color: 'var(--lp-bone)' }}>Bytescon</span>
        </Link>

        {/* A gold indicator slides under whichever section is on screen. */}
        <nav className="hidden items-center gap-8 md:flex" aria-label="Primary">
          {NAV.map((n) => (
            <button key={n.id} type="button" className="lp-nav-link relative" aria-current={active === n.id ? 'true' : undefined} onClick={() => go(n.id)}>
              {n.label}
              {active === n.id && <m.span layoutId="lp-nav-indicator" className="lp-nav-indicator" transition={{ type: 'spring', stiffness: 380, damping: 32 }} />}
            </button>
          ))}
          <Link to="/trust" className="lp-nav-link">Trust</Link>
        </nav>

        <div className="hidden items-center gap-2 md:flex">
          {isAuthenticated ? (
            <Link to="/dashboard" className="lp-btn lp-btn-primary lp-btn-sm lp-shine">Open dashboard <ArrowRight className="h-3.5 w-3.5" /></Link>
          ) : (
            <>
              <Link to="/login" className="lp-btn lp-btn-ghost lp-btn-sm" style={{ borderColor: 'var(--lp-line-dark)', color: 'var(--lp-bone)' }}>Sign in</Link>
              <Link to="/register" className="lp-btn lp-btn-primary lp-btn-sm lp-shine">Start free trial <ArrowRight className="h-3.5 w-3.5" /></Link>
            </>
          )}
        </div>

        {/* Wrapper carries md:hidden — .lp-btn sets display itself and would override the utility. */}
        <div className="md:hidden">
          <button
            type="button"
            className="lp-btn lp-btn-ghost lp-btn-sm"
            style={{ borderColor: 'var(--lp-line-dark)', color: 'var(--lp-bone)' }}
            aria-expanded={open}
            aria-controls="lp-mobile-nav"
            aria-label={open ? 'Close menu' : 'Open menu'}
            onClick={() => setOpen((o) => !o)}
          >
            {open ? <X className="h-4 w-4" /> : <Menu className="h-4 w-4" />}
          </button>
        </div>
      </div>

      <AnimatePresence>
        {open && (
          <m.div
            id="lp-mobile-nav"
            className="lp-mobile-menu md:hidden"
            initial={{ opacity: 0, y: -10 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: -8 }}
            transition={{ duration: 0.25, ease: 'easeOut' }}
          >
            <div className="lp-container flex flex-col gap-1 py-5">
              {NAV.map((n, i) => (
                <m.button
                  key={n.id}
                  type="button"
                  className="lp-nav-link py-2.5 text-left !text-sm"
                  initial={{ opacity: 0, x: -12 }}
                  animate={{ opacity: 1, x: 0 }}
                  transition={{ duration: 0.3, delay: 0.05 + i * 0.05, ease: 'easeOut' }}
                  onClick={() => go(n.id)}
                >
                  {n.label}
                </m.button>
              ))}
              <Link to="/trust" className="lp-nav-link py-2.5 !text-sm" onClick={() => setOpen(false)}>Trust &amp; Security</Link>
              <div className="mt-4 flex gap-2">
                {isAuthenticated ? (
                  <Link to="/dashboard" className="lp-btn lp-btn-primary flex-1">Open dashboard</Link>
                ) : (
                  <>
                    <Link to="/login" className="lp-btn lp-btn-ghost flex-1" style={{ borderColor: 'var(--lp-line-dark)', color: 'var(--lp-bone)' }}>Sign in</Link>
                    <Link to="/register" className="lp-btn lp-btn-primary flex-1">Start free trial</Link>
                  </>
                )}
              </div>
            </div>
          </m.div>
        )}
      </AnimatePresence>
    </m.header>
  )
}
