// =============================================================
// Closing image band with one line and one action, then a minimal footer.
// =============================================================
import { Link } from 'react-router-dom'
import { ArrowRight } from 'lucide-react'
import { BrandMark, Reveal, scrollToId } from './shared'

type FooterLink = { label: string; id: string; to?: undefined } | { label: string; to: string; id?: undefined }

const LINKS: FooterLink[] = [
  { label: 'How it works', id: 'how-it-works' },
  { label: 'Agents', id: 'agents' },
  { label: 'Pricing', id: 'pricing' },
  { label: 'Trust & Security', to: '/trust' },
  { label: 'Client portal', to: '/client-login' },
  { label: 'Partner portal', to: '/partner/login' },
]

export function Footer() {
  return (
    <>
      <section className="lp-cta lp-dark">
        <img src="/landing/cta.jpg" alt="" loading="lazy" decoding="async" />
        <div className="lp-cta-shade" aria-hidden="true" />
        <div className="lp-grain" aria-hidden="true" />
        <div className="lp-container relative w-full py-28">
          <Reveal>
            <span className="lp-eyebrow">Start today</span>
          </Reveal>
          <Reveal delay={100}>
            <h2 className="lp-display mt-5 max-w-[14ch] text-[2.75rem] sm:text-6xl lg:text-7xl">
              Your next bid decision should be <span className="lp-italic">defensible.</span>
            </h2>
          </Reveal>
          <Reveal delay={200} className="mt-10 flex flex-col gap-3 sm:flex-row sm:items-center">
            <Link to="/register" className="lp-btn lp-btn-primary lp-btn-lg">Start free trial <ArrowRight className="h-4 w-4" /></Link>
            <Link to="/login" className="lp-btn lp-btn-ghost lp-btn-lg" style={{ borderColor: 'var(--lp-line-dark)' }}>Sign in</Link>
          </Reveal>
        </div>
      </section>

      <footer className="lp-dark border-t border-[var(--lp-line-dark)]">
        <div className="lp-container flex flex-col gap-8 py-10 md:flex-row md:items-center md:justify-between">
          <div className="flex items-center gap-2.5">
            <BrandMark size={24} id="lp-ftr" />
            <span className="lp-display text-lg">Bytescon</span>
            <span className="lp-mono ml-2" style={{ color: 'var(--lp-dim)' }}>by Bytes Platform</span>
          </div>
          <nav className="flex flex-wrap gap-x-6 gap-y-2" aria-label="Footer">
            {LINKS.map((l) => l.to !== undefined
              ? <Link key={l.label} to={l.to} className="lp-footer-link">{l.label}</Link>
              : <button key={l.label} type="button" className="lp-footer-link" onClick={() => scrollToId(l.id)}>{l.label}</button>)}
          </nav>
        </div>
        <div className="lp-container pb-8">
          <p className="lp-mono" style={{ color: 'var(--lp-dim)' }}>
            © {new Date().getFullYear()} Bytes Platform · Award figures from the SBA FY2025 scorecard · Example score is illustrative
          </p>
        </div>
      </footer>
    </>
  )
}
