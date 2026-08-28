import { useState } from 'react'
import type { LucideIcon } from 'lucide-react'
import { Outlet, Link, useLocation } from 'react-router-dom'
import { useAuth } from '../hooks/useAuth'
import { useQuery } from '@tanstack/react-query'
import { clientDocumentsApi } from '../services/api'
import { useRecentlyViewed } from '../hooks/useRecentlyViewed'
import { useFavorites } from '../hooks/useFavorites'
import { useBranding } from '../hooks/useBranding'
import { useEntitlements } from '../hooks/useEntitlements'
import { FirstLoginBanner } from './FirstLoginBanner'
import {
  LayoutDashboard,
  Search,
  Radar,
  PieChart,
  Library,
  Contact,
  GraduationCap,
  Bot,
  Users,
  FileText,
  FileSignature,
  DollarSign,
  Settings,
  LogOut,
  ClipboardList,
  ExternalLink,
  BarChart3,
  Scale,
  ShieldCheck,
  BookMarked,
  Gift,
  Clock,
  Star,
  ChevronDown,
  ChevronRight,
  X,
  CreditCard,
  MapPin,
  GitBranch,
  Inbox,
  Percent,
  BookOpen,
  Award,
  FileSpreadsheet,
  Calculator,
  UploadCloud,
  Zap,
  Building2,
  Compass,
  ScanSearch,
  Network,
  Lock,
  Wallet,
  KanbanSquare,
  Bell,
  Plug,
} from 'lucide-react'

/* ----------------------------------------------------------------
   Navigation structure — grouped into sections
   ---------------------------------------------------------------- */
interface NavItem {
  to: string
  icon: LucideIcon
  label: string
  adminOnly?: boolean
  adminOptional?: boolean
  platformAdminOnly?: boolean
  badge?: string
  /** Add-on module slug this item belongs to. Items stay visible for
   *  discoverability; a lock icon shows when the firm lacks the module
   *  (the backend + page gates do the actual enforcement). */
  module?: string
}

const navSections: { label: string; items: NavItem[] }[] = [
  {
    label: 'Core',
    items: [
      { to: '/', icon: LayoutDashboard, label: 'Dashboard' },
      { to: '/notifications', icon: Bell, label: 'Notifications' },
      { to: '/opportunities', icon: Search, label: 'Opportunities' },
      { to: '/discovery', icon: Radar, label: 'Discovery', badge: 'New' },
      { to: '/clients', icon: Users, label: 'Clients' },
      { to: '/decisions', icon: Scale, label: 'Bid Decisions' },
    ],
  },
  {
    label: 'Pipeline',
    items: [
      { to: '/pipeline', icon: KanbanSquare, label: 'Pipeline', badge: 'New' },
      { to: '/portfolio', icon: PieChart, label: 'Portfolio Value', badge: 'New' },
      { to: '/document-library', icon: Library, label: 'Document Library', badge: 'New' },
      { to: '/capability-library', icon: BookOpen, label: 'Capability Library', badge: 'New' },
      { to: '/past-performance-library', icon: Award, label: 'Past Performance', badge: 'New' },
      { to: '/crm', icon: Contact, label: 'Relationships', badge: 'New' },
      { to: '/knowledge', icon: GraduationCap, label: 'Knowledge', badge: 'New' },
      { to: '/integrations', icon: Plug, label: 'Integrations', badge: 'New' },
      { to: '/signatures', icon: FileSignature, label: 'Signatures', badge: 'New' },
      { to: '/agents', icon: Bot, label: 'Agent Operations', badge: 'New' },
      { to: '/submissions', icon: FileText, label: 'Submissions' },
      { to: '/registration', icon: ShieldCheck, label: 'Registration', badge: 'New' },
      { to: '/contracts', icon: FileSignature, label: 'Contracts', badge: 'New' },
      { to: '/timekeeping', icon: Clock, label: 'Timekeeping', badge: 'New' },
      { to: '/receivables', icon: Wallet, label: 'Receivables', badge: 'New' },
      { to: '/indirect-rates', icon: Percent, label: 'Indirect Rates', badge: 'New' },
      { to: '/audit-readiness', icon: FileSpreadsheet, label: 'Audit Readiness', badge: 'New' },
      { to: '/subcontracting', icon: GitBranch, label: 'Subcontracting', module: 'teaming_suite' },
      { to: '/subcontracting/contacts', icon: Building2, label: 'Prime Contacts', module: 'teaming_suite' },
      { to: '/teaming', icon: Network, label: 'Teaming', badge: 'New', module: 'teaming_suite' },
      { to: '/partner-submissions', icon: Inbox, label: 'Partner Submissions', badge: 'New' },
      { to: '/state-municipal', icon: MapPin, label: 'State & Municipal', badge: 'Soon', module: 'state_municipal' },
      { to: '/penalties', icon: DollarSign, label: 'Penalties', module: 'contract_analysis' },
    ],
  },
  {
    label: 'Intelligence',
    items: [
      { to: '/analytics', icon: BarChart3, label: 'Analytics', module: 'market_intel' },
      { to: '/agency', icon: Building2, label: 'Agency View', badge: 'New', module: 'market_intel' },
      { to: '/platform-onboarding', icon: Compass, label: 'Onboarding', badge: 'New' },
      { to: '/set-aside', icon: ScanSearch, label: 'Set-Aside Intel', badge: 'New', module: 'setaside_intel' },
      { to: '/roi-calculator', icon: Calculator, label: 'ROI Calculator' },
      { to: '/rewards', icon: Gift, label: 'Rewards' },
    ],
  },
  {
    label: 'Resources',
    items: [
      { to: '/templates', icon: FileText, label: 'Templates', module: 'proposal_studio' },
      { to: '/template-library', icon: BookMarked, label: 'Template Library', module: 'proposal_studio' },
      { to: '/doc-requirements', icon: ClipboardList, label: 'Doc Requirements', module: 'contract_analysis' },
      { to: '/contract-upload', icon: UploadCloud, label: 'Upload Contract', module: 'contract_analysis' },
    ],
  },
  {
    label: 'Admin',
    items: [
      { to: '/billing', icon: CreditCard, label: 'Billing', adminOptional: true },
      { to: '/compliance', icon: ShieldCheck, label: 'Compliance', adminOnly: true },
      { to: '/admin/backtest', icon: BarChart3, label: 'Model Backtest', adminOnly: true },
      { to: '/template-moderation', icon: ShieldCheck, label: 'Template Review', platformAdminOnly: true },
      { to: '/platform/margin', icon: DollarSign, label: 'Fleet Margin', platformAdminOnly: true },
      { to: '/platform/metrics', icon: BarChart3, label: 'Platform Metrics', platformAdminOnly: true },
      { to: '/settings', icon: Settings, label: 'Settings' },
    ],
  },
]

export function Layout() {
  const { pathname } = useLocation()
  const { user, firm, logout } = useAuth()
  const { hasAddon } = useEntitlements()
  const { data: modData } = useQuery({
    queryKey: ['can-moderate-templates'],
    queryFn: () => clientDocumentsApi.canModerateTemplates(),
    staleTime: 5 * 60 * 1000,
  })
  const canModerate = !!modData?.data?.canModerate
  const { items: recentItems, clearHistory } = useRecentlyViewed()
  const { favorites, removeFavorite } = useFavorites()
  const { branding } = useBranding(firm?.id)

  const [recentOpen, setRecentOpen] = useState(true)
  const [favOpen, setFavOpen] = useState(true)

  const fmtDeadline = (d?: string) => {
    if (!d) return null
    const days = Math.round((new Date(d).getTime() - Date.now()) / 86400000)
    if (days < 0) return null
    return days <= 7 ? (
      <span className="text-red-400 text-[9px] font-mono font-bold">{days}d</span>
    ) : days <= 20 ? (
      <span className="text-cyan-400 text-[9px] font-mono font-bold">{days}d</span>
    ) : (
      <span className="text-slate-600 text-[9px] font-mono">{days}d</span>
    )
  }

  // Highlight only the single most-specific (longest) matching nav item, so a
  // parent path (e.g. /subcontracting) doesn't also light up when a child
  // route (/subcontracting/contacts) is active.
  const bestMatch = navSections
    .flatMap((s) => s.items.map((i) => i.to))
    .filter((to) => (to === '/' ? pathname === '/' : pathname === to || pathname.startsWith(to + '/')))
    .sort((a, b) => b.length - a.length)[0]
  const isActive = (to: string) => to === bestMatch

  return (
    <div className="flex h-screen overflow-hidden" style={{ background: '#061019' }}>
      {/* Skip-link — first focusable element so keyboard users can jump
          past the sidebar nav. Visible only when focused. */}
      <a
        href="#main-content"
        className="sr-only focus:not-sr-only focus:fixed focus:top-2 focus:left-2 focus:z-[200] focus:px-3 focus:py-2 focus:bg-cyan-500 focus:text-slate-900 focus:rounded focus:font-semibold"
      >
        Skip to main content
      </a>

      {/* ============================================================
          SIDEBAR
          ============================================================ */}
      <aside
        aria-label="Primary navigation"
        className="w-60 flex-shrink-0 flex flex-col overflow-y-auto"
        style={{
          background: 'linear-gradient(180deg, #050e1e 0%, #071120 40%, #060f1c 100%)',
          borderRight: '1px solid rgba(26,46,74,0.7)',
        }}
      >
        {/* ---- Brand ---- */}
        <div
          className="px-4 pt-5 pb-4 flex-shrink-0"
          style={{ borderBottom: '1px solid rgba(26,46,74,0.6)' }}
        >
          {/* Logo row */}
          <div className="flex items-center gap-2.5 mb-3">
            <div className="flex-shrink-0 animate-float">
              <svg width="34" height="34" viewBox="0 0 64 64" fill="none" xmlns="http://www.w3.org/2000/svg">
                <defs>
                  <linearGradient id="sbCanopy" x1="0%" y1="0%" x2="100%" y2="100%">
                    <stop offset="0%" stopColor="#22d3ee"/>
                    <stop offset="100%" stopColor="#06b6d4"/>
                  </linearGradient>
                  <filter id="logoGlow">
                    <feGaussianBlur stdDeviation="1.5" result="blur"/>
                    <feMerge><feMergeNode in="blur"/><feMergeNode in="SourceGraphic"/></feMerge>
                  </filter>
                </defs>
                <path d="M12 6 L30 6 L48 32 L30 58 L12 58 L27 32 Z" fill="url(#sbCanopy)" filter="url(#logoGlow)"/>
                <path d="M37 12 L45 12 L59 32 L45 52 L37 52 L51 32 Z" fill="#22d3ee" opacity="0.5"/>
              </svg>
            </div>
            <div className="min-w-0">
              <p
                className="text-sm font-black tracking-widest leading-none"
                style={{
                  background: `linear-gradient(90deg, ${branding.primaryColor}, ${branding.secondaryColor})`,
                  WebkitBackgroundClip: 'text',
                  WebkitTextFillColor: 'transparent',
                  letterSpacing: '0.08em',
                }}
              >
                {branding.displayName}
              </p>
              <p className="text-[9px] text-slate-600 tracking-[0.15em] uppercase mt-0.5">
                {branding.tagline}
              </p>
            </div>
          </div>

          {/* Veteran badge + live indicator */}
          <div className="flex items-center justify-between">
            <span className="veteran-badge">★ Veteran Owned</span>
            <div className="flex items-center gap-1.5">
              <div className="live-dot" />
              <span className="text-[9px] text-emerald-600 font-medium tracking-wide">LIVE</span>
            </div>
          </div>

          {/* User info */}
          <div
            className="mt-3 pt-3"
            style={{ borderTop: '1px solid rgba(26,46,74,0.5)' }}
          >
            <p className="text-[13px] font-semibold text-slate-100 truncate leading-tight">
              {firm?.name}
            </p>
            <p className="text-[11px] text-slate-600 truncate mt-0.5">{user?.email}</p>
            <div className="flex items-center gap-2 mt-2">
              <span
                className="text-[10px] px-2 py-0.5 rounded-full font-bold tracking-wide"
                style={{
                  background: `${branding.secondaryColor}17`,
                  border: `1px solid ${branding.secondaryColor}39`,
                  color: branding.secondaryColor,
                  letterSpacing: '0.06em',
                }}
              >
                {user?.role}
              </span>
            </div>
          </div>
        </div>

        {/* ---- Navigation ---- */}
        <nav className="px-2 py-2 flex-shrink-0">
          {navSections.map((section) => {
            const visibleItems = section.items.filter((item) => {
              if (item.adminOnly && user?.role !== 'ADMIN') return false
              if (item.platformAdminOnly && !canModerate) return false
              return true
            })
            if (visibleItems.length === 0) return null

            return (
              <div key={section.label}>
                <p className="nav-section-label">{section.label}</p>
                {visibleItems.map((item) => {
                  const active = isActive(item.to)
                  const locked = item.module ? !hasAddon(item.module) : false
                  return (
                    <Link
                      key={item.to}
                      to={item.to}
                      className={`nav-item${active ? ' active' : ''}`}
                    >
                      <item.icon className="w-4 h-4 flex-shrink-0" strokeWidth={active ? 2 : 1.75} />
                      <span>{item.label}</span>
                      <span className="ml-auto flex items-center gap-1">
                        {locked && (
                          <Lock className="w-3 h-3 text-slate-600" aria-label="Requires add-on" />
                        )}
                        {item.badge && (
                          <span className="text-[9px] font-bold uppercase tracking-wider px-1.5 py-0.5 rounded"
                            style={{ background: `${branding.secondaryColor}26`, color: branding.secondaryColor, border: `1px solid ${branding.secondaryColor}40` }}>
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

        {/* ---- Divider ---- */}
        <div className="mx-3">
          <div className="divider-gold" style={{ margin: '0.25rem 0' }} />
        </div>

        {/* ---- Favorites ---- */}
        <div className="flex-shrink-0 px-2">
          <button
            onClick={() => setFavOpen((o) => !o)}
            className="flex items-center justify-between w-full px-2 py-1.5 text-[10px] font-bold uppercase tracking-widest transition-colors rounded-md hover:bg-white/5"
            style={{ color: 'rgba(34,211,238,0.6)' }}
          >
            <div className="flex items-center gap-1.5">
              <Star className="w-3 h-3" fill="currentColor" />
              <span>Pinned</span>
              {favorites.length > 0 && (
                <span
                  className="text-[9px] px-1.5 py-0.5 rounded-full font-bold"
                  style={{
                    background: 'rgba(6,182,212,0.15)',
                    color: '#06b6d4',
                    border: '1px solid rgba(6,182,212,0.25)',
                  }}
                >
                  {favorites.length}
                </span>
              )}
            </div>
            {favOpen
              ? <ChevronDown className="w-3 h-3 opacity-50" />
              : <ChevronRight className="w-3 h-3 opacity-50" />
            }
          </button>

          {favOpen && (
            <div className="pb-1 space-y-px">
              {favorites.length === 0 ? (
                <p className="text-[10px] text-slate-700 px-3 py-1 italic">
                  Star any contract to pin it here
                </p>
              ) : (
                favorites.map((fav) => (
                  <div key={fav.id} className="group flex items-center gap-1">
                    <Link
                      to={`/opportunities/${fav.id}`}
                      className="flex-1 min-w-0 flex items-center gap-1.5 px-2 py-1.5 rounded-md text-[11px] text-slate-500 hover:text-cyan-300 hover:bg-white/5 transition-all"
                    >
                      <Star className="w-2.5 h-2.5 text-cyan-500/60 flex-shrink-0" fill="currentColor" />
                      <span className="truncate">{fav.title}</span>
                      {fmtDeadline(fav.deadline)}
                    </Link>
                    <button
                      onClick={() => removeFavorite(fav.id)}
                      className="opacity-0 group-hover:opacity-100 p-0.5 text-slate-700 hover:text-red-400 transition-all flex-shrink-0"
                    >
                      <X className="w-2.5 h-2.5" />
                    </button>
                  </div>
                ))
              )}
            </div>
          )}
        </div>

        {/* ---- Recently Viewed ---- */}
        <div className="flex-shrink-0 px-2">
          <button
            onClick={() => setRecentOpen((o) => !o)}
            className="flex items-center justify-between w-full px-2 py-1.5 text-[10px] font-bold uppercase tracking-widest transition-colors rounded-md hover:bg-white/5"
            style={{ color: 'rgba(34,211,238,0.5)' }}
          >
            <div className="flex items-center gap-1.5">
              <Clock className="w-3 h-3" />
              <span>Recent</span>
            </div>
            {recentOpen
              ? <ChevronDown className="w-3 h-3 opacity-50" />
              : <ChevronRight className="w-3 h-3 opacity-50" />
            }
          </button>

          {recentOpen && (
            <div className="pb-1 space-y-px">
              {recentItems.length === 0 ? (
                <p className="text-[10px] text-slate-700 px-3 py-1 italic">No contracts viewed yet</p>
              ) : (
                <>
                  {recentItems.map((item) => (
                    <Link
                      key={item.id}
                      to={`/opportunities/${item.id}`}
                      className="flex items-center gap-1.5 px-2 py-1.5 rounded-md text-[11px] text-slate-600 hover:text-slate-200 hover:bg-white/5 transition-all"
                    >
                      <Clock className="w-2.5 h-2.5 flex-shrink-0 text-cyan-900" />
                      <span className="truncate flex-1">{item.title}</span>
                      {fmtDeadline(item.deadline)}
                    </Link>
                  ))}
                  <button
                    onClick={clearHistory}
                    className="text-[10px] text-slate-700 hover:text-slate-500 px-3 pt-1 transition-colors"
                  >
                    Clear history
                  </button>
                </>
              )}
            </div>
          )}
        </div>

        {/* ---- Spacer ---- */}
        <div className="flex-1" />

        {/* ---- Footer actions ---- */}
        <div
          className="px-2 py-2.5 flex-shrink-0"
          style={{ borderTop: '1px solid rgba(26,46,74,0.5)' }}
        >
          <a
            href="/client-login"
            target="_blank"
            rel="noopener noreferrer"
            className="flex items-center gap-2.5 px-3 py-2 text-[11px] text-slate-600 hover:text-sky-400 w-full rounded-lg hover:bg-white/5 transition-all font-medium"
          >
            <ExternalLink className="w-3.5 h-3.5" />
            Client Portal
          </a>
          <button
            onClick={logout}
            className="flex items-center gap-2.5 px-3 py-2 text-[11px] text-slate-600 hover:text-red-400 w-full rounded-lg hover:bg-white/5 transition-all font-medium"
          >
            <LogOut className="w-3.5 h-3.5" />
            Sign Out
          </button>
        </div>
      </aside>

      {/* ============================================================
          MAIN CONTENT
          ============================================================ */}
      <main className="flex-1 overflow-auto" style={{ background: '#061019' }}>
        {/* Subtle dot grid background */}
        <div
          className="fixed inset-0 pointer-events-none"
          style={{
            backgroundImage: 'radial-gradient(circle, rgba(26,46,74,0.35) 1px, transparent 1px)',
            backgroundSize: '28px 28px',
            zIndex: 0,
          }}
        />

        {/* Content */}
        <main id="main-content" tabIndex={-1} className="relative z-10 p-8 max-w-[1400px] mx-auto">
          <FirstLoginBanner />
          <Outlet />
        </main>

        {/* Brand footer */}
        <div
          className="relative z-10 px-8 py-3 flex items-center justify-between"
          style={{ borderTop: '1px solid rgba(26,46,74,0.4)' }}
        >
          <p className="text-[10px] text-slate-800 tracking-widest">
            © {new Date().getFullYear()} BYTES PLATFORM · All Rights Reserved
          </p>
          <div className="flex items-center gap-4">
            <Link
              to="/trust"
              className="text-[10px] text-slate-700 hover:text-cyan-500 transition-colors tracking-wide"
            >
              Trust &amp; Security
            </Link>
            <div className="flex items-center gap-1.5">
              <Zap className="w-2.5 h-2.5 text-amber-800" />
              <p className="text-[10px] text-slate-800">Bytescon — Advisory Intelligence</p>
            </div>
          </div>
        </div>
      </main>
    </div>
  )
}
