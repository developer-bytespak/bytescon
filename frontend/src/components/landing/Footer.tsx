// =============================================================
// Closing call to action on one blue surface, then a plain footer.
// =============================================================
import { Link } from 'react-router-dom'
import { Wordmark } from './shared'
import { Rise, scrollToId } from './motion'

type FooterLink = { label: string; id: string; to?: undefined } | { label: string; to: string; id?: undefined }

const LINKS: FooterLink[] = [
  { label: 'How it works', id: 'how-it-works' },
  { label: 'Agents', id: 'agents' },
  { label: 'Pricing', id: 'pricing' },
  { label: 'Trust and security', to: '/trust' },
  { label: 'Client portal', to: '/client-login' },
  { label: 'Partner portal', to: '/partner/login' },
]

export function Footer() {
  return (
    <>
      <section className="lp-container pb-4">
        <Rise>
          <div className="lp-surface lp-surface-night" style={{ padding: 'clamp(32px, 6vw, 72px)' }}>
            <h2 className="lp-display max-w-[16ch] text-[2.5rem] sm:text-6xl" style={{ color: '#f0f1fa' }}>
              Your next bid decision should be defensible.
            </h2>
            <div className="mt-10 flex flex-col gap-3 sm:flex-row sm:items-center">
              <Link to="/register" className="lp-btn lp-btn-white lp-btn-lg">Start free trial</Link>
              <Link to="/login" className="lp-btn lp-btn-ghost-white lp-btn-lg">Sign in</Link>
            </div>
          </div>
        </Rise>
      </section>

      <footer className="lp-container">
        <div className="flex flex-col gap-6 py-10 md:flex-row md:items-center md:justify-between">
          <div className="flex items-center gap-3">
            <Wordmark />
            <span className="text-[13px]" style={{ color: 'var(--text-dim)' }}>by Bytes Platform</span>
          </div>
          <nav className="flex flex-wrap gap-x-6 gap-y-2" aria-label="Footer">
            {LINKS.map((l) => l.to !== undefined
              ? <Link key={l.label} to={l.to} className="lp-footer-link">{l.label}</Link>
              : <button key={l.label} type="button" className="lp-footer-link" onClick={() => scrollToId(l.id)}>{l.label}</button>)}
          </nav>
        </div>
        <p className="pb-10 text-[13px]" style={{ color: 'var(--text-dim)', borderTop: '1px solid var(--line)', paddingTop: 20 }}>
          © {new Date().getFullYear()} Bytes Platform · Award figures from the SBA FY2025 scorecard · Example scores are illustrative
        </p>
      </footer>
    </>
  )
}
