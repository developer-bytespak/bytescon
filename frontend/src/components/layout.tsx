import { useCallback, useEffect, useRef, useState } from 'react'
import { Outlet, Link, useLocation } from 'react-router-dom'
import { useAuth } from '../hooks/useAuth'
import { useRecentlyViewed } from '../hooks/useRecentlyViewed'
import { useFavorites } from '../hooks/useFavorites'
import { useBranding } from '../hooks/useBranding'
import { useEntitlements } from '../hooks/useEntitlements'
import { useCanModerate } from '../hooks/useCanModerate'
import { useTheme } from '../hooks/useTheme'
import { FirstLoginBanner } from './FirstLoginBanner'
import { CommandPalette, useCommandPalette } from './CommandPalette'
import { useUnreadNotifications } from './NotificationPopups'
import { NAV_SECTIONS, HUBS } from '../navigation'
import {
  LogOut, ExternalLink, Clock, Star, ChevronDown, ChevronRight, X, Lock, Search, Bell, Sun, Moon,
  Menu, Settings as SettingsIcon, CreditCard,
} from 'lucide-react'
import { AnimatePresence, motion } from 'framer-motion'
import { useCardSpotlight } from './kit'

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

const COLLAPSED_KEY = 'bytescon_sidebar_collapsed'

function loadCollapsed(): boolean {
  try { return localStorage.getItem(COLLAPSED_KEY) === '1' } catch { return false }
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
  const { theme, toggle: toggleTheme } = useTheme()
  const unreadCount = useUnreadNotifications().data?.data?.unreadCount ?? 0
  useCardSpotlight()

  const [favOpen, setFavOpen] = useState(true)
  const [recentOpen, setRecentOpen] = useState(false)
  const [groups, setGroups] = useState<Record<string, boolean>>(loadGroups)
  // Desktop: icon-only rail. Mobile: off-canvas drawer.
  const [collapsed, setCollapsed] = useState<boolean>(loadCollapsed)
  const [mobileOpen, setMobileOpen] = useState(false)
  const [menuOpen, setMenuOpen] = useState(false)
  const menuRef = useRef<HTMLDivElement>(null)


  const toggleCollapsed = useCallback(() => {
    setCollapsed((c) => {
      try { localStorage.setItem(COLLAPSED_KEY, c ? '0' : '1') } catch { /* private mode */ }
      return !c
    })
  }, [])

  // ☰ in the top bar: folds the sidebar to an icon rail on desktop, opens the drawer on smaller screens.
  const onHamburger = useCallback(() => {
    if (window.matchMedia?.('(min-width: 1024px)').matches) toggleCollapsed()
    else setMobileOpen(true)
  }, [toggleCollapsed])

  // The drawer and the account menu close whenever the route changes.
  useEffect(() => { setMobileOpen(false); setMenuOpen(false) }, [pathname])
  useEffect(() => {
    if (!menuOpen) return
    const onDown = (e: MouseEvent) => { if (!menuRef.current?.contains(e.target as Node)) setMenuOpen(false) }
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') setMenuOpen(false) }
    document.addEventListener('mousedown', onDown)
    window.addEventListener('keydown', onKey)
    return () => { document.removeEventListener('mousedown', onDown); window.removeEventListener('keydown', onKey) }
  }, [menuOpen])
  useEffect(() => {
    if (!mobileOpen) return
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') setMobileOpen(false) }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [mobileOpen])

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

  // Top bar title: the matching nav entry, plus the hub tab when inside a hub.
  const current = NAV_SECTIONS.flatMap((s) => s.items).filter((i) => matches(i.to)).sort((a, b) => b.to.length - a.to.length)[0]
  const hub = current?.to && HUBS[current.to]
  const tabSeg = hub ? pathname.slice(current!.to.length + 1).split('/')[0] : ''
  const tab = hub ? hub.tabs.find((t) => t.segment === tabSeg) : undefined
  const initials = `${user?.firstName?.[0] ?? ''}${user?.lastName?.[0] ?? ''}`.toUpperCase() || (user?.email?.[0] ?? 'B').toUpperCase()

  // The rail only applies on desktop; the mobile drawer is always full width.
  const rail = collapsed && !mobileOpen

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

      {/* Mobile drawer backdrop */}
      <div
        className={`fixed inset-0 z-40 lg:hidden transition-opacity duration-200 ${mobileOpen ? 'opacity-100' : 'opacity-0 pointer-events-none'}`}
        style={{ background: 'rgba(11,11,15,0.5)', backdropFilter: 'blur(4px)' }}
        onClick={() => setMobileOpen(false)}
        aria-hidden="true"
      />

      {/* ============================================================
          SIDEBAR
          ============================================================ */}
      <aside
        aria-label="Primary navigation"
        className={`sidebar fixed inset-y-0 left-0 z-50 lg:static lg:z-auto flex-shrink-0 flex flex-col overflow-y-auto overflow-x-hidden
          transition-[transform,width] duration-[240ms] ease-[cubic-bezier(0.22,1,0.36,1)]
          ${mobileOpen ? 'translate-x-0' : '-translate-x-full'} lg:translate-x-0`}
        style={{
          width: rail ? 'var(--sidebar-w-collapsed)' : 'var(--sidebar-w)',
          background: 'var(--bg-2)',
          borderRight: '1px solid var(--line)',
          boxShadow: mobileOpen ? 'var(--shadow-3)' : undefined,
        }}
      >
        {/* ---- Brand + workspace ---- */}
        <div className={`${rail ? 'px-3' : 'px-3.5'} pt-4 pb-4 flex-shrink-0`} style={{ borderBottom: '1px solid var(--line)' }}>
          <div className={`flex items-center gap-2.5 ${rail ? 'justify-center' : 'px-1'}`}>
            <span className="brand-tile" aria-hidden="true"><BrandMark size={22} /></span>
            {!rail && (
              <p className="font-display text-[1.05rem] leading-tight flex-1 min-w-0 line-clamp-2" style={{ color: 'var(--text)' }}>
                {branding.displayName}
              </p>
            )}
            <button
              type="button"
              onClick={() => setMobileOpen(false)}
              className="lg:hidden p-1.5 rounded-md hover:bg-ink/5"
              style={{ color: 'var(--text-muted)' }}
              aria-label="Close navigation"
            >
              <X className="w-4 h-4" />
            </button>
          </div>
          {!rail && (
            <div className="workspace-card mt-4">
              <span className="ws-avatar" aria-hidden="true">
                {(firm?.name ?? 'B').split(/\s+/).map((w) => w[0]).slice(0, 2).join('').toUpperCase()}
              </span>
              <div className="min-w-0">
                <p className="text-[13px] font-semibold truncate leading-tight" style={{ color: 'var(--text)' }}>{firm?.name}</p>
                <p className="text-[11px] truncate mt-0.5" style={{ color: 'var(--text-faint)' }}>{user?.email}</p>
              </div>
            </div>
          )}
          <button
            type="button"
            onClick={() => palette.setOpen(true)}
            className={`mt-3 w-full flex items-center gap-2 ${rail ? 'justify-center px-0' : 'px-3'} py-2 rounded-lg text-[12px] transition-colors hover:bg-ink/5`}
            style={{ border: '1px solid var(--line-strong)', color: 'var(--text-muted)', background: 'var(--surface)' }}
            aria-label="Search pages (Ctrl+K)"
            title="Go to… (Ctrl K)"
          >
            <Search className="w-3.5 h-3.5" />
            {!rail && (
              <>
                <span className="flex-1 text-left">Go to…</span>
                <kbd className="kbd">Ctrl K</kbd>
              </>
            )}
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
            // On the rail every item shows as an icon; groups only fold when expanded.
            const open = rail || section.pinned || isOpen(section.label)

            return (
              <div key={section.label} className={section.pinned ? '' : 'mt-1'}>
                {!section.pinned && (rail ? (
                  <div className="mx-3 my-2" style={{ height: 1, background: 'var(--line)' }} aria-hidden="true" />
                ) : (
                  <button
                    type="button"
                    onClick={() => setGroup(section.label, !open)}
                    aria-expanded={open}
                    className={`${sideLabel} w-full flex items-center justify-between px-3 py-2 rounded-md transition-colors hover:bg-ink/5`}
                    style={{ color: open ? 'var(--text-muted)' : 'var(--text-dim)' }}
                  >
                    <span>{section.label}</span>
                    <ChevronDown className={`w-3 h-3 opacity-60 transition-transform duration-200 ${open ? '' : '-rotate-90'}`} />
                  </button>
                ))}
                <AnimatePresence initial={false}>
                  {open && (
                    <motion.div
                      key="items"
                      initial={{ opacity: 0, height: 0 }}
                      animate={{ opacity: 1, height: 'auto' }}
                      exit={{ opacity: 0, height: 0 }}
                      transition={{ duration: 0.2, ease: [0.22, 1, 0.36, 1] }}
                      style={{ overflow: 'hidden' }}
                    >
                      {visibleItems.map((item) => {
                        const active = isActive(item.to)
                        const locked = item.module ? !hasAddon(item.module) : false
                        return (
                          <Link
                            key={item.to}
                            to={item.to}
                            className={`nav-item isolate${active ? ' active' : ''}${rail ? ' justify-center !px-0' : ''}`}
                            aria-current={active ? 'page' : undefined}
                            aria-label={rail ? item.label : undefined}
                            title={rail ? item.label : undefined}
                          >
                            {active && (
                              <motion.span
                                layoutId="nav-active"
                                className="nav-active-bg"
                                transition={{ type: 'spring', stiffness: 520, damping: 42 }}
                                aria-hidden="true"
                              />
                            )}
                            <item.icon className="w-4 h-4 flex-shrink-0" strokeWidth={active ? 2 : 1.75} />
                            {!rail && <span className="truncate">{item.label}</span>}
                            {!rail && (
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
                            )}
                          </Link>
                        )
                      })}
                    </motion.div>
                  )}
                </AnimatePresence>
              </div>
            )
          })}
        </nav>

        {!rail && (
          <>
            <div className="mx-4 my-1" style={{ height: 1, background: 'var(--line)' }} />

            {/* ---- Pinned ---- */}
            <div className="flex-shrink-0 px-2">
              <button
                onClick={() => setFavOpen((o) => !o)}
                aria-expanded={favOpen}
                className={`${sideLabel} flex items-center justify-between w-full px-3 py-2 rounded-md transition-colors hover:bg-ink/5`}
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
                          className="flex-1 min-w-0 flex items-center gap-2 px-3 py-1.5 rounded-md text-[12px] transition-colors hover:bg-ink/5"
                          style={{ color: 'var(--text-2)' }}
                        >
                          <span className="truncate">{fav.title}</span>
                          {fmtDeadline(fav.deadline)}
                        </Link>
                        <button
                          onClick={() => removeFavorite(fav.id)}
                          className="opacity-0 group-hover:opacity-100 focus-visible:opacity-100 p-1 transition-opacity flex-shrink-0 hover:text-red-400"
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
                aria-expanded={recentOpen}
                className={`${sideLabel} flex items-center justify-between w-full px-3 py-2 rounded-md transition-colors hover:bg-ink/5`}
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
                          className="flex items-center gap-2 px-3 py-1.5 rounded-md text-[12px] transition-colors hover:bg-ink/5"
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
          </>
        )}

        <div className="flex-1" />

        {/* ---- Footer actions ---- */}
        <div className="px-2 py-2 flex-shrink-0" style={{ borderTop: '1px solid var(--line)' }}>
          <a
            href="/client-login"
            target="_blank"
            rel="noopener noreferrer"
            className={`nav-item text-[12px]${rail ? ' justify-center !px-0' : ''}`}
            aria-label={rail ? 'Client portal' : undefined}
            title={rail ? 'Client portal' : undefined}
          >
            <ExternalLink className="w-3.5 h-3.5" />
            {!rail && 'Client portal'}
          </a>
          <button
            onClick={logout}
            className={`nav-item w-full text-[12px] hover:!text-red-300${rail ? ' justify-center !px-0' : ''}`}
            aria-label={rail ? 'Sign out' : undefined}
            title={rail ? 'Sign out' : undefined}
          >
            <LogOut className="w-3.5 h-3.5" />
            {!rail && 'Sign out'}
          </button>
        </div>
      </aside>

      {/* ============================================================
          MAIN CONTENT
          ============================================================ */}
      <div className="relative isolate flex-1 min-w-0 overflow-auto flex flex-col" style={{ background: 'var(--bg)' }}>
        {/* Decorative ambient light + dot grid behind the top of every page. */}
        <div className="app-ambient" aria-hidden="true" />
        {/* ---- Top bar ---- */}
        <header className="topbar">
          <div className="w-full px-4 sm:px-6 lg:px-8 h-16 flex items-center gap-3">
            {/* Left: menu + breadcrumb */}
            <div className="flex items-center gap-3 min-w-0 flex-1 basis-0">
              <button
                type="button"
                onClick={onHamburger}
                className="hamburger flex-shrink-0"
                aria-label={mobileOpen || !collapsed ? 'Collapse navigation' : 'Expand navigation'}
                aria-expanded={mobileOpen || !collapsed}
                title="Menu"
              >
                <Menu className="w-[18px] h-[18px]" />
              </button>
              <nav aria-label="Breadcrumb" className="flex items-center gap-2 min-w-0">
                {currentSection && currentSection !== 'Home' && (
                  <>
                    <span className="hidden xl:inline text-[13px]" style={{ color: 'var(--text-faint)' }}>{currentSection}</span>
                    <ChevronRight className="hidden xl:inline w-3.5 h-3.5 flex-shrink-0" style={{ color: 'var(--text-dim)' }} aria-hidden="true" />
                  </>
                )}
                {current?.icon && <span className="tile tile-accent tile-sm hidden sm:inline-grid"><current.icon /></span>}
                <p className="text-sm font-semibold truncate" style={{ color: 'var(--text)' }}>{current?.label ?? 'Bytescon'}</p>
                {tab && (
                  <>
                    <ChevronRight className="w-3.5 h-3.5 flex-shrink-0" style={{ color: 'var(--text-dim)' }} aria-hidden="true" />
                    <p className="text-sm truncate" style={{ color: 'var(--text-muted)' }}>{tab.label}</p>
                  </>
                )}
              </nav>
            </div>

            {/* Center: search */}
            <button type="button" onClick={() => palette.setOpen(true)} className="search-bar hidden md:flex" aria-label="Search (Ctrl+K)">
              <span className="search-bar-icon"><Search className="w-4 h-4" /></span>
              <span className="flex-1 text-left truncate">Search or jump to…</span>
              <kbd className="kbd">Ctrl K</kbd>
            </button>

            {/* Right: actions + account */}
            <div className="flex items-center justify-end gap-2 flex-1 basis-0">
              <button type="button" onClick={() => palette.setOpen(true)} className="icon-btn md:hidden" aria-label="Search (Ctrl+K)" title="Search · Ctrl K">
                <Search className="w-4 h-4" />
              </button>
              <button type="button" onClick={toggleTheme} className="icon-btn" aria-label={theme === 'dark' ? 'Switch to light mode' : 'Switch to dark mode'} title={theme === 'dark' ? 'Light mode' : 'Dark mode'}>
                <AnimatePresence mode="wait" initial={false}>
                  <motion.span
                    key={theme}
                    initial={{ opacity: 0, rotate: -60, scale: 0.7 }}
                    animate={{ opacity: 1, rotate: 0, scale: 1 }}
                    exit={{ opacity: 0, rotate: 60, scale: 0.7 }}
                    transition={{ duration: 0.18 }}
                    className="grid place-items-center"
                  >
                    {theme === 'dark' ? <Sun className="w-4 h-4" /> : <Moon className="w-4 h-4" />}
                  </motion.span>
                </AnimatePresence>
              </button>
              <Link to="/notifications" className="icon-btn relative" aria-label={unreadCount > 0 ? `Notifications (${unreadCount} unread)` : 'Notifications'} title="Notifications">
                <Bell className="w-4 h-4" />
                {unreadCount > 0 && (
                  <span
                    className="absolute -top-1 -right-1 min-w-[16px] h-4 px-1 rounded-full text-[10px] font-semibold leading-4 text-center tabular-nums"
                    style={{ background: 'var(--danger)', color: '#fff' }}
                    aria-hidden="true"
                  >
                    {unreadCount > 9 ? '9+' : unreadCount}
                  </span>
                )}
              </Link>

              <span className="hidden sm:block w-px h-6 mx-1" style={{ background: 'var(--line-strong)' }} aria-hidden="true" />

              <div className="relative" ref={menuRef}>
                <button
                  type="button"
                  onClick={() => setMenuOpen((o) => !o)}
                  className="account-btn"
                  aria-haspopup="menu"
                  aria-expanded={menuOpen}
                  aria-label="Account menu"
                >
                  <span className="avatar-ring"><span className="avatar">{initials}</span><span className="avatar-status" aria-hidden="true" /></span>
                  <span className="hidden sm:block text-left leading-tight min-w-0">
                    <span className="block text-[13px] font-semibold truncate max-w-[9rem]" style={{ color: 'var(--text)' }}>{user?.firstName ? `${user.firstName} ${user.lastName ?? ''}`.trim() : user?.email}</span>
                    <span className="block text-[11px] truncate max-w-[9rem]" style={{ color: 'var(--text-faint)' }}>{firm?.name}</span>
                  </span>
                  <ChevronDown className={`hidden sm:block w-3.5 h-3.5 transition-transform duration-200 ${menuOpen ? 'rotate-180' : ''}`} style={{ color: 'var(--text-faint)' }} />
                </button>

                <AnimatePresence>
                  {menuOpen && (
                    <motion.div
                      role="menu"
                      initial={{ opacity: 0, y: -6, scale: 0.97 }}
                      animate={{ opacity: 1, y: 0, scale: 1 }}
                      exit={{ opacity: 0, y: -6, scale: 0.97, transition: { duration: 0.12 } }}
                      transition={{ duration: 0.18, ease: [0.22, 1, 0.36, 1] }}
                      className="account-menu"
                    >
                      <div className="flex items-center gap-3 px-3 pt-3 pb-3" style={{ borderBottom: '1px solid var(--line)' }}>
                        <span className="avatar !w-10 !h-10 !text-[0.8rem]">{initials}</span>
                        <div className="min-w-0">
                          <p className="text-sm font-semibold truncate" style={{ color: 'var(--text)' }}>{user?.firstName ? `${user.firstName} ${user.lastName ?? ''}`.trim() : user?.email}</p>
                          <p className="text-xs truncate" style={{ color: 'var(--text-faint)' }}>{user?.email}</p>
                          {user?.role && <span className="chip chip-accent mt-1.5 !text-[10px] !py-0.5">{user.role}</span>}
                        </div>
                      </div>
                      <div className="p-1.5">
                        <Link role="menuitem" to="/settings" className="account-item"><SettingsIcon className="w-4 h-4" /> Settings</Link>
                        <Link role="menuitem" to="/billing" className="account-item"><CreditCard className="w-4 h-4" /> Billing</Link>
                        <a role="menuitem" href="/client-login" target="_blank" rel="noopener noreferrer" className="account-item"><ExternalLink className="w-4 h-4" /> Client portal</a>
                      </div>
                      <div className="p-1.5" style={{ borderTop: '1px solid var(--line)' }}>
                        <button role="menuitem" type="button" onClick={logout} className="account-item account-item-danger w-full"><LogOut className="w-4 h-4" /> Sign out</button>
                      </div>
                    </motion.div>
                  )}
                </AnimatePresence>
              </div>
            </div>
          </div>
        </header>

        <main id="main-content" tabIndex={-1} className="flex-1 w-full px-4 py-6 sm:px-6 sm:py-8 lg:px-10 max-w-[1360px] mx-auto min-w-0">
          <FirstLoginBanner />
          <div key={pathname} className="page-enter">
            <Outlet />
          </div>
        </main>
        <footer className="w-full px-4 sm:px-6 lg:px-10 py-4 flex items-center justify-between max-w-[1360px] mx-auto" style={{ borderTop: '1px solid var(--line)' }}>
          <p className="text-[11px]" style={{ color: 'var(--text-dim)' }}>
            © {new Date().getFullYear()} Bytes Platform
          </p>
          <Link to="/trust" className="text-[11px] transition-colors hover:text-slate-300" style={{ color: 'var(--text-dim)' }}>
            Trust &amp; Security
          </Link>
        </footer>
      </div>

      <CommandPalette open={palette.open} onClose={() => palette.setOpen(false)} />
    </div>
  )
}
