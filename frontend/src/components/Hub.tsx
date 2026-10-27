// =============================================================
// Hub — a sidebar entry that groups several pages under path-based tabs.
// Renders a compact tab bar, then the active child route. Child pages keep
// their own headers, so the hub itself adds no second title.
// =============================================================
import { NavLink, Outlet, Navigate, useLocation } from 'react-router-dom'
import { Lock } from 'lucide-react'
import { HUBS, hubTabPath } from '../navigation'
import { useEntitlements } from '../hooks/useEntitlements'
import { useCanModerate } from '../hooks/useCanModerate'
import { TabIndicator } from './kit'

export function Hub({ path }: { path: keyof typeof HUBS }) {
  const hub = HUBS[path]
  const { hasAddon } = useEntitlements()
  const canModerate = useCanModerate()
  const tabs = hub.tabs.filter((t) => !t.platformAdminOnly || canModerate)

  return (
    <div>
      <nav
        aria-label={`${hub.label} sections`}
        className="tabs mb-7 -mt-1"
      >
        <span className="hidden sm:inline text-[10px] font-semibold uppercase tracking-[0.14em] pr-3 mr-1" style={{ color: 'var(--text-dim)' }}>
          {hub.label}
        </span>
        {tabs.map((t) => {
          const locked = t.module ? !hasAddon(t.module) : false
          return (
            <NavLink
              key={t.segment || 'index'}
              to={hubTabPath(path, t.segment)}
              end={t.segment === ''}
              className="tab"
            >
              {({ isActive }) => (
                <span className="contents" data-active={isActive}>
                  <span style={{ color: isActive ? 'var(--text)' : undefined }}>{t.label}</span>
                  {locked && <Lock className="w-3 h-3" style={{ color: 'var(--text-dim)' }} aria-label="Requires add-on" />}
                  {isActive && <TabIndicator id={`hub-${path}`} />}
                </span>
              )}
            </NavLink>
          )
        })}
      </nav>
      <Outlet />
    </div>
  )
}

/** Redirects a retired path to its new home, keeping any query string. */
export function LegacyRedirect({ to }: { to: string }) {
  const { search, hash } = useLocation()
  return <Navigate to={`${to}${search}${hash}`} replace />
}
