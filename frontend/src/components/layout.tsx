import { useCallback, useEffect, useState } from 'react'
import { Outlet, Link, useLocation } from 'react-router-dom'
import { useAuth } from '../hooks/useAuth'
import { useRecentlyViewed } from '../hooks/useRecentlyViewed'
import { useFavorites } from '../hooks/useFavorites'
import { useBranding } from '../hooks/useBranding'
import { useEntitlements } from '../hooks/useEntitlements'
import { useCanModerate } from '../hooks/useCanModerate'
import { FirstLoginBanner } from './FirstLoginBanner'
import { CommandPalette, useCommandPalette } from './CommandPalette'
import { NAV_SECTIONS } from '../navigation'
import {
  LogOut, ExternalLink, Clock, Star, ChevronDown, ChevronRight, X, Lock, Search,
} from 'lucide-react'

/* ----------------------------------------------------------------
   Collapsible nav groups. The open/closed choice is remembered per
   browser; a group opens on its own when you navigate into it.
   ---------------------------------------------------------------- */
const GROUPS_KEY = 'bytescon_nav_groups'
const DEFAULT_OPEN = new Set(['Capture'])

function loadGroups(): Record<string, boolean> {
  try { return JSON.parse(localStorage.getItem(GROUPS_KEY) || '{}') } catch { return {} }
}

function BrandMark({ size = 28 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 64 64" fill="none" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">
      <defs>
        <linearGradient id="sbMark" x1="0%" y1="0%" x2="100%" y2="100%">
          <stop offset="0%" stopColor="#f0d493" />
          <stop offset="100%" stopColor="#d3a54a" />
        </linearGradient>
      </defs>
      <path d="M12 6 L30 6 L48 32 L30 58 L12 58 L27 32 Z" fill="url(#sbMark)" />
      <path d="M37 12 L45 12 L59 32 L45 52 L37 52 L51 32 Z" fill="#8c9cff" opacity="0.85" />
    </svg>
  )
}

export function Layout() {
  const { pathname } = useLocation()
  const { user, firm, logout } = useAuth()
  const { hasAddon } = useEntitlements()
  const canModerate = useCanModerate()
  const { items: recentItems, clearHistory } = useRecentlyViewed()
  const { favorites, removeFavorite } = useFavorites()
  const { branding } = useBranding(firm?.id)
  const palette = useCommandPalette()

  const [favOpen, setFavOpen] = useState(true)
  const [recentOpen, setRecentOpen] = useState(false)
  const [groups, setGroups] = useState<Record<string, boolean>>(loadGroups)

  const matches = (to: string) => pathname === to || pathname.startsWith(to + '/')
  const currentSection = NAV_SECTIONS.find((s) => s.items.some((i) => matches(i.to)))?.label

  const isOpen = (label: string) => groups[label] ?? (DEFAULT_OPEN.has(label) || label === currentSection)
  const setGroup = useCallback((label: string, open: boolean) => {
    setGroups((g) => {
      const next = { ...g, [label]: open }
      try { localStorage.setItem(GROUPS_KEY, JSON.stringify(next)) } catch { /* private mode */ }
      return next
    })
  }, [])

  // Navigating into a collapsed group opens it, so the active item is never hidden.
  useEffect(() => {
    if (currentSection && groups[currentSection] === false) setGroup(currentSection, true)
  }, [currentSection, groups, setGroup])

  const fmtDeadline = (d?: string) => {
    if (!d) return null
    const days = Math.round((new Date(d).getTime() - Date.now()) / 86400000)
    if (days < 0) return null
    const color = days <= 7 ? 'var(--danger)' : days <= 20 ? 'var(--warning)' : 'var(--text-dim)'
    return <span className="text-[10px] font-mono tabular-nums" style={{ color }}>{days}d</span>
  }

  // Highlight only the single most-specific (longest) matching nav item.
  const bestMatch = NAV_SECTIONS
    .flatMap((s) => s.items.map((i) => i.to))
    .filter(matches)
    .sort((a, b) => b.length - a.length)[0]
  const isActive = (to: string) => to === bestMatch

  const sideLabel = 'text-[10px] font-semibold uppercase tracking-[0.14em]'

  return (
    <div className="flex h-screen overflow-hidden" style={{ background: 'var(--bg)' }}>
      {/* Skip-link — first focusable element so keyboard users can jump
          past the sidebar nav. Visible only when focused. */}
      <a
        href="#main-content"
        className="sr-only focus:not-sr-only focus:fixed focus:top-2 focus:left-2 focus:z-[200] focus:px-3 focus:py-2 focus:bg-blue-500 focus:text-white focus:rounded focus:font-semibold"
      >
        Skip to main content
      </a>

      {/* ============================================================
          SIDEBAR
          ============================================================ */}
      <aside
        aria-label="Primary navigation"
        className="w-60 flex-shrink-0 flex flex-col overflow-y-auto"
        style={{ background: 'var(--bg-2)', borderRight: '1px solid var(--line)' }}
      >
        {/* ---- Brand + account ---- */}
        <div className="px-4 pt-5 pb-4 flex-shrink-0" style={{ borderBottom: '1px solid var(--line)' }}>
          <div className="flex items-center gap-2.5">
            <BrandMark />
            <p className="font-display text-[1.05rem] leading-none truncate" style={{ color: 'var(--text)' }}>
              {branding.displayName}
            </p>
          </div>
          <div className="mt-4">
            <p className="text-[13px] font-medium truncate leading-tight" style={{ color: 'var(--text)' }}>{firm?.name}</p>
            <p className="text-[11px] truncate mt-0.5" style={{ color: 'var(--text-faint)' }}>{user?.email}</p>
          </div>
          <button
            type="button"
            onClick={() => palette.setOpen(true)}
            className="mt-4 w-full flex items-center gap-2 px-3 py-2 rounded-lg text-[12px] transition-colors hover:bg-white/5"
            style={{ border: '1px solid var(--line-strong)', color: 'var(--text-muted)' }}
            aria-label="Search pages (Ctrl+K)"
          >
            <Search className="w-3.5 h-3.5" />
            <span className="flex-1 text-left">Go to…</span>
            <kbd className="text-[10px] font-mono" style={{ color: 'var(--text-dim)' }}>Ctrl K</kbd>
          </button>
        </div>

        {/* ---- Navigation ---- */}
        <nav className="px-2 py-2 flex-shrink-0">
          {NAV_SECTIONS.map((section) => {
            const visibleItems = section.items.filter((item) => {
              if (item.adminOnly && user?.role !== 'ADMIN') return false
              if (item.platformAdminOnly && !canModerate) return false
              return true
            })
            if (visibleItems.length === 0) return null
            const open = section.pinned || isOpen(section.label)

            return (
              <div key={section.label} className={section.pinned ? '' : 'mt-1'}>
                {!section.pinned && (
                  <button
                    type="button"
                    onClick={() => setGroup(section.label, !open)}
                    aria-expanded={open}
                    className={`${sideLabel} w-full flex items-center justify-between px-3 py-2 rounded-md transition-colors hover:bg-white/5`}
                    style={{ color: open ? 'var(--text-muted)' : 'var(--text-dim)' }}
                  >
                    <span>{section.label}</span>
                    {open ? <ChevronDown className="w-3 h-3 opacity-60" /> : <ChevronRight className="w-3 h-3 opacity-60" />}
                  </button>
                )}
                {open && visibleItems.map((item) => {
                  const active = isActive(item.to)
                  const locked = item.module ? !hasAddon(item.module) : false
                  return (
                    <Link
                      key={item.to}
                      to={item.to}
                      className={`nav-item${active ? ' active' : ''}`}
                    >
                      <item.icon className="w-4 h-4 flex-shrink-0" strokeWidth={active ? 2 : 1.75} />
                      <span className="truncate">{item.label}</span>
                      <span className="ml-auto flex items-center gap-1.5">
                        {locked && (
                          <Lock className="w-3 h-3" style={{ color: 'var(--text-dim)' }} aria-label="Requires add-on" />
                        )}
                        {item.badge && (
                          <span
                            className="text-[9px] font-semibold uppercase tracking-wider px-1.5 py-0.5 rounded-full"
                            style={{ background: 'var(--surface-3)', color: 'var(--text-muted)' }}
                          >
                            {item.badge}
                          </span>
                        )}
                      </span>
                    </Link>
                  )
                })}
              </div>
            )
          })}
        </nav>

        <div className="mx-4 my-1" style={{ height: 1, background: 'var(--line)' }} />

        {/* ---- Pinned ---- */}
        <div className="flex-shrink-0 px-2">
          <button
            onClick={() => setFavOpen((o) => !o)}
            className={`${sideLabel} flex items-center justify-between w-full px-3 py-2 rounded-md transition-colors hover:bg-white/5`}
            style={{ color: 'var(--text-faint)' }}
          >
            <span className="flex items-center gap-1.5">
              <Star className="w-3 h-3" style={{ color: 'var(--gold)' }} fill="currentColor" />
              Pinned
              {favorites.length > 0 && <span className="font-mono normal-case tracking-normal" style={{ color: 'var(--text-dim)' }}>{favorites.length}</span>}
            </span>
            {favOpen ? <ChevronDown className="w-3 h-3 opacity-60" /> : <ChevronRight className="w-3 h-3 opacity-60" />}
          </button>

          {favOpen && (
            <div className="pb-1">
              {favorites.length === 0 ? (
                <p className="text-[11px] px-3 py-1" style={{ color: 'var(--text-dim)' }}>Star a contract to pin it here.</p>
              ) : (
                favorites.map((fav) => (
                  <div key={fav.id} className="group flex items-center gap-1">
                    <Link
                      to={`/opportunities/${fav.id}`}
                      className="flex-1 min-w-0 flex items-center gap-2 px-3 py-1.5 rounded-md text-[12px] transition-colors hover:bg-white/5"
                      style={{ color: 'var(--text-2)' }}
                    >
                      <span className="truncate">{fav.title}</span>
                      {fmtDeadline(fav.deadline)}
                    </Link>
                    <button
                      onClick={() => removeFavorite(fav.id)}
                      className="opacity-0 group-hover:opacity-100 p-1 transition-opacity flex-shrink-0 hover:text-red-400"
                      style={{ color: 'var(--text-dim)' }}
                      aria-label={`Unpin ${fav.title}`}
                    >
                      <X className="w-3 h-3" />
                    </button>
                  </div>
                ))
              )}
            </div>
          )}
        </div>

        {/* ---- Recently viewed ---- */}
        <div className="flex-shrink-0 px-2">
          <button
            onClick={() => setRecentOpen((o) => !o)}
            className={`${sideLabel} flex items-center justify-between w-full px-3 py-2 rounded-md transition-colors hover:bg-white/5`}
            style={{ color: 'var(--text-faint)' }}
          >
            <span className="flex items-center gap-1.5">
              <Clock className="w-3 h-3" />
              Recent
            </span>
            {recentOpen ? <ChevronDown className="w-3 h-3 opacity-60" /> : <ChevronRight className="w-3 h-3 opacity-60" />}
          </button>

          {recentOpen && (
            <div className="pb-1">
              {recentItems.length === 0 ? (
                <p className="text-[11px] px-3 py-1" style={{ color: 'var(--text-dim)' }}>No contracts viewed yet.</p>
              ) : (
                <>
                  {recentItems.map((item) => (
                    <Link
                      key={item.id}
                      to={`/opportunities/${item.id}`}
                      className="flex items-center gap-2 px-3 py-1.5 rounded-md text-[12px] transition-colors hover:bg-white/5"
                      style={{ color: 'var(--text-muted)' }}
                    >
                      <span className="truncate flex-1">{item.title}</span>
                      {fmtDeadline(item.deadline)}
                    </Link>
                  ))}
                  <button
                    onClick={clearHistory}
                    className="text-[11px] px-3 pt-1 transition-colors hover:text-slate-300"
                    style={{ color: 'var(--text-dim)' }}
                  >
                    Clear history
                  </button>
                </>
              )}
            </div>
          )}
        </div>

        <div className="flex-1" />

        {/* ---- Footer actions ---- */}
        <div className="px-2 py-2 flex-shrink-0" style={{ borderTop: '1px solid var(--line)' }}>
          <a
            href="/client-login"
            target="_blank"
            rel="noopener noreferrer"
            className="nav-item text-[12px]"
          >
            <ExternalLink className="w-3.5 h-3.5" />
            Client portal
          </a>
          <button onClick={logout} className="nav-item w-full text-[12px] hover:!text-red-300">
            <LogOut className="w-3.5 h-3.5" />
            Sign out
          </button>
        </div>
      </aside>

      {/* ============================================================
          MAIN CONTENT
          ============================================================ */}
      <main className="flex-1 overflow-auto flex flex-col" style={{ background: 'var(--bg)' }}>
        <main id="main-content" tabIndex={-1} className="flex-1 w-full px-8 py-8 lg:px-10 max-w-[1360px] mx-auto">
          <FirstLoginBanner />
          <Outlet />
        </main>
        <div className="w-full px-8 lg:px-10 py-4 flex items-center justify-between max-w-[1360px] mx-auto" style={{ borderTop: '1px solid var(--line)' }}>
          <p className="text-[11px]" style={{ color: 'var(--text-dim)' }}>
            © {new Date().getFullYear()} Bytes Platform
          </p>
          <Link to="/trust" className="text-[11px] transition-colors hover:text-slate-300" style={{ color: 'var(--text-dim)' }}>
            Trust &amp; Security
          </Link>
        </div>
      </main>

      <CommandPalette open={palette.open} onClose={() => palette.setOpen(false)} />
    </div>
  )
}
