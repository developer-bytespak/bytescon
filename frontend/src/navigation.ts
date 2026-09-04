// =============================================================
// Single source of truth for in-app navigation.
//
// The sidebar, the command palette and the hub tab bars all read from
// here, so a page moves in one place. Sections follow the capture
// workflow (Home → Capture → Clients → Proposals → Delivery →
// Intelligence → System) instead of the old Core / Pipeline split.
//
// Hubs group several pages under one sidebar entry with path-based tabs
// (`/library/documents`, `/finance/receivables`, …). LEGACY_REDIRECTS keeps
// every pre-hub URL working, including links inside pages and bookmarks.
// =============================================================
import type { LucideIcon } from 'lucide-react'
import {
  LayoutDashboard, Bell, Search, Radar, Scale, KanbanSquare, PieChart, MapPin,
  Users, Contact, Network,
  FileText, FileSignature, Library, ClipboardList, UploadCloud, Send,
  Briefcase, ShieldCheck, Wallet,
  BarChart3, Building2, ScanSearch, Calculator, Compass,
  Bot, Plug, CreditCard, Settings, Gift, Lock,
} from 'lucide-react'

export interface HubTab {
  /** Path segment under the hub, e.g. "documents" → /library/documents. */
  segment: string
  label: string
  /** Add-on module slug this tab belongs to; shows a lock when missing. */
  module?: string
  /** Only platform admins (template moderators) can see this tab. */
  platformAdminOnly?: boolean
}

export interface NavItem {
  to: string
  icon: LucideIcon
  label: string
  /** Extra words the command palette should match on. */
  keywords?: string
  adminOnly?: boolean
  platformAdminOnly?: boolean
  badge?: string
  module?: string
  /** Present when this entry is a hub with tabs. */
  tabs?: HubTab[]
}

export interface NavSection {
  label: string
  /** Home has no heading and can't be collapsed. */
  pinned?: boolean
  items: NavItem[]
}

export const HUBS: Record<string, { label: string; tabs: HubTab[] }> = {
  '/library': {
    label: 'Library',
    tabs: [
      { segment: 'documents', label: 'Documents' },
      { segment: 'capability', label: 'Capability' },
      { segment: 'past-performance', label: 'Past performance' },
      { segment: 'knowledge', label: 'Knowledge' },
    ],
  },
  '/finance': {
    label: 'Finance',
    tabs: [
      { segment: 'timekeeping', label: 'Timekeeping' },
      { segment: 'receivables', label: 'Receivables' },
      { segment: 'indirect-rates', label: 'Indirect rates' },
      { segment: 'audit-readiness', label: 'Audit readiness' },
      { segment: 'penalties', label: 'Penalties', module: 'contract_analysis' },
    ],
  },
  '/templates': {
    label: 'Templates',
    tabs: [
      { segment: '', label: 'My templates' },
      { segment: 'library', label: 'Template library' },
    ],
  },
  '/partners': {
    label: 'Partners',
    tabs: [
      { segment: 'teaming', label: 'Teaming', module: 'teaming_suite' },
      { segment: 'subcontracting', label: 'Subcontracting', module: 'teaming_suite' },
      { segment: 'contacts', label: 'Prime contacts', module: 'teaming_suite' },
      { segment: 'submissions', label: 'Partner submissions' },
    ],
  },
  '/admin': {
    label: 'Admin',
    tabs: [
      { segment: 'compliance', label: 'Compliance log' },
      { segment: 'backtest', label: 'Model backtest' },
      { segment: 'template-review', label: 'Template review', platformAdminOnly: true },
      { segment: 'fleet-margin', label: 'Fleet margin', platformAdminOnly: true },
      { segment: 'metrics', label: 'Platform metrics', platformAdminOnly: true },
    ],
  },
}

export const NAV_SECTIONS: NavSection[] = [
  {
    label: 'Home',
    pinned: true,
    items: [
      { to: '/dashboard', icon: LayoutDashboard, label: 'Dashboard', keywords: 'home overview' },
      { to: '/notifications', icon: Bell, label: 'Notifications', keywords: 'alerts inbox' },
    ],
  },
  {
    label: 'Capture',
    items: [
      { to: '/opportunities', icon: Search, label: 'Opportunities', keywords: 'sam.gov contracts solicitations' },
      { to: '/discovery', icon: Radar, label: 'Discovery', keywords: 'monitoring profiles matches' },
      { to: '/decisions', icon: Scale, label: 'Bid Decisions', keywords: 'bid no-bid qualification' },
      { to: '/pipeline', icon: KanbanSquare, label: 'Pipeline', keywords: 'pursuits board kanban' },
      { to: '/portfolio', icon: PieChart, label: 'Portfolio Value', keywords: 'expected value forecast' },
      { to: '/state-municipal', icon: MapPin, label: 'State & Municipal', badge: 'Soon', module: 'state_municipal' },
    ],
  },
  {
    label: 'Clients',
    items: [
      { to: '/clients', icon: Users, label: 'Clients', keywords: 'companies portfolio' },
      { to: '/crm', icon: Contact, label: 'Relationships', keywords: 'crm contacts agencies' },
      { to: '/partners', icon: Network, label: 'Partners', keywords: 'teaming subcontracting prime contacts partner submissions', tabs: HUBS['/partners'].tabs },
    ],
  },
  {
    label: 'Proposals',
    items: [
      { to: '/templates', icon: FileText, label: 'Templates', module: 'proposal_studio', keywords: 'template library', tabs: HUBS['/templates'].tabs },
      { to: '/submissions', icon: Send, label: 'Submissions', keywords: 'submitted proposals' },
      { to: '/signatures', icon: FileSignature, label: 'Signatures', keywords: 'e-sign' },
      { to: '/library', icon: Library, label: 'Library', keywords: 'documents capability past performance knowledge', tabs: HUBS['/library'].tabs },
      { to: '/doc-requirements', icon: ClipboardList, label: 'Doc Requirements', module: 'contract_analysis', keywords: 'compliance matrix requirements' },
      { to: '/contract-upload', icon: UploadCloud, label: 'Upload Contract', module: 'contract_analysis', keywords: 'clause extraction solicitation upload' },
    ],
  },
  {
    label: 'Delivery',
    items: [
      { to: '/contracts', icon: Briefcase, label: 'Contracts', keywords: 'awarded deliverables modifications' },
      { to: '/registration', icon: ShieldCheck, label: 'Registration', keywords: 'sam registration certifications' },
      { to: '/finance', icon: Wallet, label: 'Finance', keywords: 'timekeeping receivables invoices indirect rates audit penalties', tabs: HUBS['/finance'].tabs },
    ],
  },
  {
    label: 'Intelligence',
    items: [
      { to: '/analytics', icon: BarChart3, label: 'Analytics', module: 'market_intel', keywords: 'market forecast win loss' },
      { to: '/agency', icon: Building2, label: 'Agency View', module: 'market_intel', keywords: 'agency profile spend' },
      { to: '/set-aside', icon: ScanSearch, label: 'Set-Aside Intel', module: 'setaside_intel', keywords: 'sdvosb 8a hubzone wosb' },
      { to: '/roi-calculator', icon: Calculator, label: 'ROI Calculator' },
      { to: '/platform-onboarding', icon: Compass, label: 'Onboarding', keywords: 'vehicles platforms' },
    ],
  },
  {
    label: 'System',
    items: [
      { to: '/agents', icon: Bot, label: 'Agent Operations', keywords: 'automation schedules runs' },
      { to: '/integrations', icon: Plug, label: 'Integrations', keywords: 'api mcp claude sso' },
      { to: '/billing', icon: CreditCard, label: 'Billing', keywords: 'subscription plan tokens invoices' },
      { to: '/rewards', icon: Gift, label: 'Rewards', keywords: 'referrals' },
      { to: '/settings', icon: Settings, label: 'Settings', keywords: 'profile security branding team' },
      { to: '/admin', icon: Lock, label: 'Admin', adminOnly: true, keywords: 'compliance log backtest moderation fleet margin metrics', tabs: HUBS['/admin'].tabs },
    ],
  },
]

/** Old path → new path. Query strings are preserved by the redirect component. */
export const LEGACY_REDIRECTS: Record<string, string> = {
  '/document-library': '/library/documents',
  '/capability-library': '/library/capability',
  '/past-performance-library': '/library/past-performance',
  '/knowledge': '/library/knowledge',
  '/timekeeping': '/finance/timekeeping',
  '/receivables': '/finance/receivables',
  '/indirect-rates': '/finance/indirect-rates',
  '/audit-readiness': '/finance/audit-readiness',
  '/penalties': '/finance/penalties',
  '/template-library': '/templates/library',
  '/teaming': '/partners/teaming',
  '/subcontracting': '/partners/subcontracting',
  '/subcontracting/contacts': '/partners/contacts',
  '/partner-submissions': '/partners/submissions',
  '/compliance': '/admin/compliance',
  '/template-moderation': '/admin/template-review',
  '/platform/margin': '/admin/fleet-margin',
  '/platform/metrics': '/admin/metrics',
}

/** Joins a hub path and a tab segment without producing a trailing slash. */
export function hubTabPath(hub: string, segment: string): string {
  return segment ? `${hub}/${segment}` : hub
}

/** Flat list of every destination for the command palette. */
export interface PaletteEntry { label: string; to: string; section: string; keywords: string; adminOnly?: boolean; platformAdminOnly?: boolean }

export function paletteEntries(): PaletteEntry[] {
  const out: PaletteEntry[] = []
  for (const section of NAV_SECTIONS) {
    for (const item of section.items) {
      out.push({ label: item.label, to: item.to, section: section.label, keywords: item.keywords ?? '', adminOnly: item.adminOnly, platformAdminOnly: item.platformAdminOnly })
      for (const tab of item.tabs ?? []) {
        out.push({ label: `${item.label} › ${tab.label}`, to: hubTabPath(item.to, tab.segment), section: section.label, keywords: item.keywords ?? '', adminOnly: item.adminOnly, platformAdminOnly: tab.platformAdminOnly })
      }
    }
  }
  return out
}
