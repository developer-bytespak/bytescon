import type { ReactNode } from 'react'
import { Link } from 'react-router-dom'

/* Signed-out frame in the v3 look: lavender canvas, the "B." wordmark,
   one white 24px surface for the form, and an optional dark panel beside it
   for the page's one idea. Used by sign-in, sign-up, password, portal and
   error pages so they all match the app. */

/** Ink "B" with a small electric-blue dot, as in the app rail. */
export function Wordmark({ to = '/', name = 'Bytesgov', className = '' }: { to?: string; name?: string; className?: string }) {
  return (
    <Link to={to} className={`inline-flex items-center gap-2.5 w-fit rounded-xl ${className}`} aria-label={`${name} home`}>
      <span aria-hidden="true" style={{ fontSize: 24, lineHeight: 1, fontWeight: 800, letterSpacing: '-0.06em', color: 'var(--text)' }}>
        B<i style={{ display: 'inline-block', width: 6, height: 6, borderRadius: 999, background: 'var(--v3-blue)', marginLeft: 1 }} />
      </span>
      <span style={{ fontSize: 16, fontWeight: 600, letterSpacing: '-0.01em', color: 'var(--text)' }}>{name}</span>
    </Link>
  )
}

/** Error, warning or success message inside a signed-out form. */
export function AuthNotice({ tone = 'danger', children }: { tone?: 'danger' | 'success' | 'info'; children: ReactNode }) {
  const style = tone === 'danger'
    ? { background: 'var(--danger-bg)', color: 'var(--danger-text)' }
    : tone === 'success'
      ? { background: 'var(--success-bg)', color: 'var(--success-text)' }
      : { background: 'var(--surface-2)', color: 'var(--text-2)', border: '1px solid var(--line)' }
  return (
    <div role={tone === 'danger' ? 'alert' : 'status'} className="text-sm rounded-2xl px-4 py-3" style={style}>
      {children}
    </div>
  )
}

export function AuthShell({
  children,
  aside,
  headerRight,
  footer,
  wide = false,
  wordmarkTo = '/',
  name,
  brand,
}: {
  children: ReactNode
  /** Optional dark panel shown beside the form on wide screens. */
  aside?: ReactNode
  /** Optional link or button at the top right (e.g. "Sign in"). */
  headerRight?: ReactNode
  /** Small print under the surface. */
  footer?: ReactNode
  /** Wider form surface (registration, agreements). */
  wide?: boolean
  wordmarkTo?: string
  name?: string
  /** Replaces the Bytesgov wordmark (white-labelled portals show the firm's own name). */
  brand?: ReactNode
}) {
  const formWidth = wide ? 560 : 440
  return (
    <div className="min-h-screen flex flex-col" style={{ background: 'var(--bg)', color: 'var(--text)' }}>
      <header className="flex items-center justify-between gap-4 px-5 sm:px-10 pt-6">
        {brand ?? <Wordmark to={wordmarkTo} name={name} />}
        {headerRight}
      </header>
      <main className="flex-1 flex items-center justify-center px-4 sm:px-8 py-10">
        <div
          className={`w-full grid gap-4 ${aside ? 'lg:grid-cols-[minmax(0,1fr)_var(--auth-form-w)]' : ''}`}
          style={{ maxWidth: aside ? 1080 : formWidth, ['--auth-form-w' as string]: `${formWidth}px` }}
        >
          {aside && (
            <aside className="v3-surface v3-surface-night hidden lg:flex flex-col justify-between gap-10" style={{ padding: 40 }}>
              {aside}
            </aside>
          )}
          <section className="v3-surface animate-fade-up" style={{ padding: 'clamp(24px, 4vw, 40px)' }}>
            {children}
          </section>
        </div>
      </main>
      {footer && (
        <footer className="px-5 sm:px-10 pb-8 text-center text-[13px]" style={{ color: 'var(--text-muted)' }}>
          {footer}
        </footer>
      )}
    </div>
  )
}

/** Plain heading block at the top of a signed-out form. */
export function AuthHeading({ title, children }: { title: ReactNode; children?: ReactNode }) {
  return (
    <div className="mb-7">
      <h1 style={{ fontSize: 28, lineHeight: '34px', fontWeight: 600, letterSpacing: '-0.03em', color: 'var(--text)' }}>{title}</h1>
      {children && <p className="mt-2 text-[15px] leading-[22px]" style={{ color: 'var(--text-muted)' }}>{children}</p>}
    </div>
  )
}

/** Small print shared by the sign-in and sign-up pages. */
export function AuthTrustLine() {
  return (
    <>
      Tenant-isolated, encrypted at rest and audited. Veteran owned and operated.{' '}
      <Link to="/trust" className="underline" style={{ color: 'var(--text-2)' }}>Trust and security</Link>
    </>
  )
}
