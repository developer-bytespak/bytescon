import { useEffect, useState } from 'react'
import { Link } from 'react-router-dom'
import { ArrowRight, Menu, X } from 'lucide-react'
import { useAuth } from '../../hooks/useAuth'
import { BrandMark, scrollToId } from './shared'

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

  useEffect(() => {
    const onScroll = () => setScrolled(window.scrollY > 12)
    onScroll()
    window.addEventListener('scroll', onScroll, { passive: true })
    return () => window.removeEventListener('scroll', onScroll)
  }, [])

  const go = (id: string) => { setOpen(false); scrollToId(id) }

  return (
    <header className={`lp-header ${scrolled || open ? 'is-scrolled' : ''}`}>
      <div className="lp-container flex h-16 items-center justify-between">
        <Link to="/" className="flex items-center gap-2.5" aria-label="Bytescon home">
          <BrandMark size={26} id="lp-hdr" />
          <span className="lp-display text-[1.15rem]" style={{ color: 'var(--lp-bone)' }}>Bytescon</span>
        </Link>

        <nav className="hidden items-center gap-8 md:flex" aria-label="Primary">
          {NAV.map((n) => (
            <button key={n.id} type="button" className="lp-nav-link" onClick={() => go(n.id)}>{n.label}</button>
          ))}
          <Link to="/trust" className="lp-nav-link">Trust</Link>
        </nav>

        <div className="hidden items-center gap-2 md:flex">
          {isAuthenticated ? (
            <Link to="/dashboard" className="lp-btn lp-btn-primary lp-btn-sm">Open dashboard <ArrowRight className="h-3.5 w-3.5" /></Link>
          ) : (
            <>
              <Link to="/login" className="lp-btn lp-btn-ghost lp-btn-sm" style={{ borderColor: 'var(--lp-line-dark)', color: 'var(--lp-bone)' }}>Sign in</Link>
              <Link to="/register" className="lp-btn lp-btn-primary lp-btn-sm">Start free trial <ArrowRight className="h-3.5 w-3.5" /></Link>
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

      {open && (
        <div id="lp-mobile-nav" className="lp-mobile-menu md:hidden">
          <div className="lp-container flex flex-col gap-1 py-5">
            {NAV.map((n) => (
              <button key={n.id} type="button" className="lp-nav-link py-2.5 text-left !text-sm" onClick={() => go(n.id)}>{n.label}</button>
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
        </div>
      )}
    </header>
  )
}
