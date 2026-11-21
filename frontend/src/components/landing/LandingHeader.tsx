import { useState } from 'react'
import { Link } from 'react-router-dom'
import { AnimatePresence, m, useMotionValueEvent, useScroll } from 'framer-motion'
import { Menu, X } from 'lucide-react'
import { useAuth } from '../../hooks/useAuth'
import { Wordmark } from './shared'
import { scrollToId, useActiveSection } from './motion'

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
    <header className={`lp-header ${scrolled || open ? 'is-scrolled' : ''}`}>
      <div className="lp-container flex h-[72px] items-center justify-between gap-4">
        <Wordmark />

        {/* A short ink line sits under whichever section is on screen. */}
        <nav className="hidden items-center gap-1 md:flex" aria-label="Primary">
          {NAV.map((n) => (
            <button key={n.id} type="button" className="lp-nav-link" aria-current={active === n.id ? 'true' : undefined} onClick={() => go(n.id)}>
              {n.label}
              {active === n.id && <m.span layoutId="lp-nav-indicator" className="lp-nav-indicator" transition={{ type: 'spring', stiffness: 420, damping: 40 }} />}
            </button>
          ))}
          <Link to="/trust" className="lp-nav-link">Trust</Link>
        </nav>

        <div className="hidden items-center gap-2 md:flex">
          {isAuthenticated ? (
            <Link to="/dashboard" className="lp-btn lp-btn-dark lp-btn-sm">Open dashboard</Link>
          ) : (
            <>
              <Link to="/login" className="lp-btn lp-btn-light lp-btn-sm">Sign in</Link>
              <Link to="/register" className="lp-btn lp-btn-dark lp-btn-sm">Start free trial</Link>
            </>
          )}
        </div>

        {/* Wrapper carries md:hidden — .lp-btn sets display itself and would override the utility. */}
        <div className="md:hidden">
          <button
            type="button"
            className="lp-btn lp-btn-light lp-btn-sm !px-3"
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
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            transition={{ duration: 0.18, ease: 'easeOut' }}
          >
            <div className="lp-container flex flex-col gap-1 py-4">
              {NAV.map((n) => (
                <button key={n.id} type="button" className="lp-nav-link text-left" onClick={() => go(n.id)}>
                  {n.label}
                </button>
              ))}
              <Link to="/trust" className="lp-nav-link" onClick={() => setOpen(false)}>Trust and security</Link>
              <div className="mt-3 flex gap-2">
                {isAuthenticated ? (
                  <Link to="/dashboard" className="lp-btn lp-btn-dark flex-1">Open dashboard</Link>
                ) : (
                  <>
                    <Link to="/login" className="lp-btn lp-btn-light flex-1">Sign in</Link>
                    <Link to="/register" className="lp-btn lp-btn-dark flex-1">Start free trial</Link>
                  </>
                )}
              </div>
            </div>
          </m.div>
        )}
      </AnimatePresence>
    </header>
  )
}
