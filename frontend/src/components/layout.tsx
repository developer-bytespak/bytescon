import { useCallback, useEffect, useRef, useState } from 'react'
import { Outlet, Link, useLocation } from 'react-router-dom'
import type { LucideIcon } from 'lucide-react'
import { useAuth, useIsContractor } from '../hooks/useAuth'
import { ProfileCompletionCard } from './ProfileCompletionCard'
import { useRecentlyViewed } from '../hooks/useRecentlyViewed'
import { useFavorites } from '../hooks/useFavorites'
import { useEntitlements } from '../hooks/useEntitlements'
import { useCanModerate } from '../hooks/useCanModerate'
import { useTheme } from '../hooks/useTheme'
import { FirstLoginBanner } from './FirstLoginBanner'
import { DemoBanner } from '../demo/DemoBanner'
import { DemoOnboarding } from '../demo/DemoOnboarding'
import { isDemoSite } from '../demo/demoMode'
import { CommandPalette, useCommandPalette } from './CommandPalette'
import { useUnreadNotifications } from './NotificationPopups'
import { NAV_SECTIONS, HUBS, type NavItem, type NavSection } from '../navigation'
import {
  LogOut, ExternalLink, Star, X, Lock, Search, Bell, Sun, Moon, Menu, ChevronRight,
  Settings as SettingsIcon, CreditCard, LayoutDashboard, Users, FileText, Briefcase, BarChart3, Settings,
} from 'lucide-react'
import { useCardSpotlight } from './kit'
import { roleLabel } from '../lib/roleLabels'

/* ----------------------------------------------------------------
   App frame (UI v3). Desktop: V5's dark icon rail; each icon opens a
   fly-out listing that group's pages. Phones: the full menu in a
   drawer. The top bar carries the page name, search, theme, alerts.
   ---------------------------------------------------------------- */

/** The rail icon for each menu group. */
const GROUP_ICONS: Record<string, LucideIcon> = {
  Capture: Search,
  'Companies & Agencies': Users,
  Proposals: FileText,
  Delivery: Briefcase,
  Intelligence: BarChart3,
  System: Settings,
}

type Flyout = { kind: 'group'; label: string } | { kind: 'saved' } | { kind: 'account' } | null

export function Layout() {
  const { pathname } = useLocation()
  const { user, firm, logout } = useAuth()
  const isContractor = useIsContractor()
  const { hasAddon } = useEntitlements()
  const canModerate = useCanModerate()
  const { items: recentItems, clearHistory } = useRecentlyViewed()
  const { favorites, removeFavorite } = useFavorites()
  const palette = useCommandPalette()
  const { theme, toggle: toggleTheme } = useTheme()
  const unreadCount = useUnreadNotifications().data?.data?.unreadCount ?? 0
  useCardSpotlight()

  const [flyout, setFlyout] = useState<Flyout>(null)
  const [mobileOpen, setMobileOpen] = useState(false)
  const flyoutRef = useRef<HTMLDivElement>(null)
  const railRef = useRef<HTMLElement>(null)

  // Fly-outs and the drawer close on navigation, Escape, or a click elsewhere.
  useEffect(() => { setFlyout(null); setMobileOpen(false) }, [pathname])
  useEffect(() => {
    if (!flyout && !mobileOpen) return
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') { setFlyout(null); setMobileOpen(false) } }
    const onDown = (e: MouseEvent) => {
      const t = e.target as Node
      if (flyout && !flyoutRef.current?.contains(t) && !railRef.current?.contains(t)) setFlyout(null)
    }
    window.addEventListener('keydown', onKey)
    document.addEventListener('mousedown', onDown)
    return () => { window.removeEventListener('keydown', onKey); document.removeEventListener('mousedown', onDown) }
  }, [flyout, mobileOpen])
  // Opening a fly-out moves focus into it, so keyboard users land on its first page.
  useEffect(() => {
    if (flyout) flyoutRef.current?.querySelector<HTMLElement>('a, button')?.focus()
  }, [flyout])

  const matches = (to: string) => pathname === to || pathname.startsWith(to + '/')
  const visible = useCallback((item: NavItem) => {
    if (item.adminOnly && user?.role !== 'ADMIN') return false
    if (item.platformAdminOnly && !canModerate) return false
    if (item.hideForContractor && isContractor) return false
    if (item.contractorOnly && !isContractor) return false
    // These pages only send the demo back to the dashboard.
    if (isDemoSite && (item.to === '/billing' || item.to === '/contract-upload')) return false
    return true
  }, [user?.role, canModerate, isContractor])

  const sections = NAV_SECTIONS
    .map((s) => ({ ...s, items: s.items.filter(visible) }))
    .filter((s) => s.items.length > 0)
  const sectionName = (s: NavSection) => (isContractor && s.contractorLabel ? s.contractorLabel : s.label)

  // Highlight only the single most-specific (longest) matching item.
  const bestMatch = sections.flatMap((s) => s.items.map((i) => i.to)).filter(matches).sort((a, b) => b.length - a.length)[0]
  const currentSection = sections.find((s) => s.items.some((i) => i.to === bestMatch))
  const current = sections.flatMap((s) => s.items).find((i) => i.to === bestMatch)
  const hub = current?.to ? HUBS[current.to] : undefined
  const tabSeg = hub && current ? pathname.slice(current.to.length + 1).split('/')[0] : ''
  const tab = hub ? hub.tabs.find((t) => t.segment === tabSeg) : undefined
  const initials = `${user?.firstName?.[0] ?? ''}${user?.lastName?.[0] ?? ''}`.toUpperCase() || (user?.email?.[0] ?? 'B').toUpperCase()
  const fullName = user?.firstName ? `${user.firstName} ${user.lastName ?? ''}`.trim() : user?.email

  const daysLeft = (d?: string) => {
    if (!d) return null
    const days = Math.round((new Date(d).getTime() - Date.now()) / 86400000)
    return days < 0 ? null : days
  }

  const toggleGroup = (label: string) =>
    setFlyout((f) => (f?.kind === 'group' && f.label === label ? null : { kind: 'group', label }))
  const openSection = flyout?.kind === 'group' ? sections.find((s) => s.label === flyout.label) : undefined

  const itemLink = (item: NavItem, onPick?: () => void) => {
    const active = item.to === bestMatch
    const locked = item.module ? !hasAddon(item.module) : false
    return (
      <Link key={item.to} to={item.to} aria-current={active ? 'page' : undefined} onClick={onPick}>
        <item.icon aria-hidden="true" />
        <span className="truncate">{item.label}</span>
        {locked && <Lock className="!w-3.5 !h-3.5 ml-auto" aria-label="Requires add-on" />}
      </Link>
    )
  }

  return (
    <div className="flex min-h-screen" style={{ background: 'var(--bg)' }}>
      <a
        href="#main-content"
        className="sr-only focus:not-sr-only focus:fixed focus:top-2 focus:left-2 focus:z-[200] focus:px-4 focus:py-2 focus:rounded-full focus:font-semibold"
        style={{ background: 'var(--surface)', color: 'var(--text)' }}
      >
        Skip to main content
      </a>

      {/* ============================ Desktop rail ============================ */}
      <nav ref={railRef} aria-label="Primary navigation" className="v3-rail hidden lg:flex">
        <div className="v3-rail-in">
          <Link to="/dashboard" className="v3-rail-logo" aria-label="Bytesgov home">B<i aria-hidden="true" /></Link>

          <Link
            to="/dashboard"
            className="v3-rail-btn"
            data-active={bestMatch === '/dashboard' || undefined}
            aria-current={bestMatch === '/dashboard' ? 'page' : undefined}
            aria-label="Dashboard"
            title="Dashboard"
          >
            <LayoutDashboard aria-hidden="true" />
          </Link>

          {sections.filter((s) => !s.pinned).map((s) => {
            const Icon = GROUP_ICONS[s.label] ?? s.items[0].icon
            const open = flyout?.kind === 'group' && flyout.label === s.label
            return (
              <button
                key={s.label}
                type="button"
                className="v3-rail-btn"
                data-active={currentSection?.label === s.label || undefined}
                aria-expanded={open}
                aria-controls="v3-flyout"
                aria-label={sectionName(s)}
                title={sectionName(s)}
                onClick={() => toggleGroup(s.label)}
              >
                <Icon aria-hidden="true" />
              </button>
            )
          })}

          <span className="v3-rail-sep" aria-hidden="true" />
          <button
            type="button"
            className="v3-rail-btn"
            aria-expanded={flyout?.kind === 'saved'}
            aria-controls="v3-flyout"
            aria-label="Pinned and recent"
            title="Pinned and recent"
            onClick={() => setFlyout((f) => (f?.kind === 'saved' ? null : { kind: 'saved' }))}
          >
            <Star aria-hidden="true" />
          </button>

          <button
            type="button"
            className="v3-rail-me"
            aria-expanded={flyout?.kind === 'account'}
            aria-controls="v3-flyout"
            aria-label="Account menu"
            title={fullName ?? 'Account'}
            onClick={() => setFlyout((f) => (f?.kind === 'account' ? null : { kind: 'account' }))}
          >
            {initials}
          </button>
        </div>
      </nav>

      {/* ============================ Fly-outs ============================ */}
      {flyout && (
        <div ref={flyoutRef} id="v3-flyout" className="v3-flyout hidden lg:block" role="region"
          aria-label={openSection ? sectionName(openSection) : flyout.kind === 'saved' ? 'Pinned and recent' : 'Account'}>
          {openSection && (
            <>
              <h2>{sectionName(openSection)}</h2>
              <div className="flex flex-col gap-0.5">{openSection.items.map((i) => itemLink(i))}</div>
            </>
          )}

          {flyout.kind === 'saved' && (
            <>
              <h2>Pinned</h2>
              {favorites.length === 0 ? (
                <p className="v3-fly-note">Star a contract to pin it here.</p>
              ) : favorites.map((fav) => (
                <div key={fav.id} className="group flex items-center">
                  <Link to={`/opportunities/${fav.id}`} className="flex-1 min-w-0">
                    <span className="truncate">{fav.title}</span>
                    {daysLeft(fav.deadline) != null && <span className="v3-fly-meta">{daysLeft(fav.deadline)}d left</span>}
                  </Link>
                  <button type="button" onClick={() => removeFavorite(fav.id)} aria-label={`Unpin ${fav.title}`}
                    className="p-2 rounded-full opacity-0 group-hover:opacity-100 focus-visible:opacity-100" style={{ color: 'var(--text-dim)' }}>
                    <X className="w-3.5 h-3.5" aria-hidden="true" />
                  </button>
                </div>
              ))}
              <h2 className="mt-4">Recently viewed</h2>
              {recentItems.length === 0 ? (
                <p className="v3-fly-note">Contracts you open appear here.</p>
              ) : (
                <>
                  {recentItems.map((item) => (
                    <Link key={item.id} to={`/opportunities/${item.id}`}>
                      <span className="truncate">{item.title}</span>
                      {daysLeft(item.deadline) != null && <span className="v3-fly-meta">{daysLeft(item.deadline)}d left</span>}
                    </Link>
                  ))}
                  <button type="button" className="v3-fly-item" onClick={clearHistory}>Clear history</button>
                </>
              )}
            </>
          )}

          {flyout.kind === 'account' && (
            <>
              <div className="px-3 pb-3 mb-1" style={{ borderBottom: '1px solid var(--line)' }}>
                <p className="text-[15px] font-semibold truncate" style={{ color: 'var(--text)' }}>{fullName}</p>
                <p className="text-[13px] truncate" style={{ color: 'var(--text-muted)' }}>{firm?.name}</p>
                {user?.role && <p className="text-[13px]" style={{ color: 'var(--text-dim)' }}>{roleLabel(user.role)}</p>}
              </div>
              <Link to="/settings"><SettingsIcon aria-hidden="true" /> Settings</Link>
              {!isDemoSite && <Link to="/billing"><CreditCard aria-hidden="true" /> Billing</Link>}
              {!isContractor && <a href="/client-login" target="_blank" rel="noopener noreferrer"><ExternalLink aria-hidden="true" /> Client portal</a>}
              <button type="button" className="v3-fly-item" onClick={logout}><LogOut aria-hidden="true" /> Sign out</button>
            </>
          )}
        </div>
      )}

      {/* ============================ Phone drawer ============================ */}
      {mobileOpen && (
        <div className="fixed inset-0 z-40 lg:hidden modal-backdrop" onClick={() => setMobileOpen(false)} aria-hidden="true" />
      )}
      {/* Rendered only while open, so its links never take focus when hidden. */}
      {mobileOpen && <aside
        aria-label="Navigation"
        className="sidebar lg:hidden fixed inset-y-0 left-0 z-50 w-[288px] max-w-[85vw] flex flex-col overflow-y-auto"
      >
        <div className="flex items-center justify-between px-5 pt-5 pb-3">
          <span className="text-[20px] font-extrabold tracking-[-0.06em]" style={{ color: 'var(--text)' }}>Bytesgov</span>
          <button type="button" onClick={() => setMobileOpen(false)} className="p-2 rounded-full" style={{ color: 'var(--text-muted)' }} aria-label="Close navigation">
            <X className="w-5 h-5" aria-hidden="true" />
          </button>
        </div>
        <div className="px-3 pb-4">
          {sections.map((s) => (
            <div key={s.label} className="mt-2">
              {!s.pinned && <p className="px-3 pt-3 pb-1 text-[13px] font-medium" style={{ color: 'var(--text-muted)' }}>{sectionName(s)}</p>}
              {s.items.map((item) => {
                const active = item.to === bestMatch
                return (
                  <Link key={item.to} to={item.to} aria-current={active ? 'page' : undefined}
                    className={`nav-item relative flex items-center gap-3 px-3 min-h-[40px]${active ? ' active' : ''}`}>
                    {active && <span className="nav-active-bg absolute inset-0 -z-0" aria-hidden="true" />}
                    <item.icon className="w-4 h-4 relative" aria-hidden="true" />
                    <span className="relative truncate">{item.label}</span>
                  </Link>
                )
              })}
            </div>
          ))}
          <div className="mt-4 pt-3" style={{ borderTop: '1px solid var(--line)' }}>
            {!isContractor && (
              <a href="/client-login" target="_blank" rel="noopener noreferrer" className="nav-item flex items-center gap-3 px-3 min-h-[40px]">
                <ExternalLink className="w-4 h-4" aria-hidden="true" /> Client portal
              </a>
            )}
            <button type="button" onClick={logout} className="nav-item w-full flex items-center gap-3 px-3 min-h-[40px]">
              <LogOut className="w-4 h-4" aria-hidden="true" /> Sign out
            </button>
          </div>
        </div>
      </aside>}

      {/* ============================ Page ============================ */}
      <div className="relative flex-1 min-w-0 flex flex-col">
        <DemoBanner />
        <header className="topbar">
          <div className="w-full px-4 sm:px-6 lg:pl-6 lg:pr-8 h-[76px] flex items-center gap-3">
            <button type="button" onClick={() => setMobileOpen(true)} className="hamburger lg:hidden flex-shrink-0"
              aria-label="Open navigation" aria-expanded={mobileOpen}>
              <Menu className="w-5 h-5" aria-hidden="true" />
            </button>
            <nav aria-label="Breadcrumb" className="v3-crumb flex items-center gap-2 min-w-0 flex-1">
              {currentSection && !currentSection.pinned && (
                <>
                  <span className="hidden xl:inline">{sectionName(currentSection)}</span>
                  <ChevronRight className="hidden xl:inline w-3.5 h-3.5 flex-shrink-0" aria-hidden="true" />
                </>
              )}
              <b className="truncate">{current?.label ?? 'Bytesgov'}</b>
              {tab && (
                <>
                  <ChevronRight className="w-3.5 h-3.5 flex-shrink-0" aria-hidden="true" />
                  <span className="truncate">{tab.label}</span>
                </>
              )}
            </nav>

            <button type="button" onClick={() => palette.setOpen(true)} className="search-bar hidden md:flex" aria-label="Search (Ctrl+K)">
              <span className="search-bar-icon"><Search className="w-4 h-4" aria-hidden="true" /></span>
              <span className="flex-1 text-left truncate">Search pages, bids, clients</span>
              <kbd className="kbd">Ctrl K</kbd>
            </button>
            <button type="button" onClick={() => palette.setOpen(true)} className="icon-btn md:hidden" aria-label="Search (Ctrl+K)">
              <Search className="w-4 h-4" aria-hidden="true" />
            </button>
            <button type="button" onClick={toggleTheme} className="icon-btn" aria-label={theme === 'dark' ? 'Switch to light mode' : 'Switch to dark mode'} title={theme === 'dark' ? 'Light mode' : 'Dark mode'}>
              {theme === 'dark' ? <Sun className="w-4 h-4" aria-hidden="true" /> : <Moon className="w-4 h-4" aria-hidden="true" />}
            </button>
            <Link to="/notifications" className="icon-btn relative" aria-label={unreadCount > 0 ? `Notifications (${unreadCount} unread)` : 'Notifications'} title="Notifications">
              <Bell className="w-4 h-4" aria-hidden="true" />
              {unreadCount > 0 && (
                <span className="absolute -top-0.5 -right-0.5 min-w-[18px] h-[18px] px-1 rounded-full text-[11px] font-semibold leading-[18px] text-center tabular-nums"
                  style={{ background: 'var(--danger)', color: '#fff' }} aria-hidden="true">
                  {unreadCount > 9 ? '9+' : unreadCount}
                </span>
              )}
            </Link>
            {/* Phones have no rail, so the account sits in the bar. */}
            <Link to="/settings" className="account-btn lg:hidden" aria-label="Account settings">
              <span className="avatar w-9 h-9 rounded-full grid place-items-center text-[12px]">{initials}</span>
            </Link>
          </div>
        </header>

        <main id="main-content" tabIndex={-1} className="flex-1 w-full px-4 pt-2 pb-24 sm:px-6 lg:pl-6 lg:pr-8 max-w-[1440px] min-w-0">
          {!isDemoSite && <FirstLoginBanner />}
          <DemoOnboarding />
          <ProfileCompletionCard />
          <div key={pathname} className="page-enter">
            <Outlet />
          </div>
        </main>
        <footer className="w-full px-4 sm:px-6 lg:pl-6 lg:pr-8 py-5 flex items-center justify-between max-w-[1440px]" style={{ borderTop: '1px solid var(--line)' }}>
          <p className="text-[13px]" style={{ color: 'var(--text-dim)' }}>© {new Date().getFullYear()} Bytes Platform</p>
          <Link to="/trust" className="text-[13px] hover:underline" style={{ color: 'var(--text-dim)' }}>Trust &amp; security</Link>
        </footer>
      </div>

      <CommandPalette open={palette.open} onClose={() => palette.setOpen(false)} />
    </div>
  )
}
