// =============================================================
// Add-on module catalog — the SINGLE source of truth for the
// $99-base + modular add-ons pricing model.
//
// Every sellable module lives here: display copy, monthly/annual
// price, availability, and the monthly proposal-token grant it
// carries. stripeService derives checkout amounts from this file
// and entitlementService derives feature access from these slugs —
// there is deliberately no second catalog anywhere else.
// =============================================================

export interface AddonDef {
  slug: string
  name: string
  tagline: string
  description: string
  priceMonthly: number
  priceAnnual: number   // per-month equivalent when billed annually (~15% off)
  icon: string          // emoji
  status: 'available' | 'coming_soon'
  category: 'ai' | 'data' | 'automation' | 'reporting'
  /** Monthly proposal-token grant while the module subscription is active. */
  tokensPerMonth?: number
  isTokenPack?: boolean   // one-time credit purchase, not a subscription
  tokenAmount?: number    // how many proposal tokens this pack grants
}

// The base plan and bundle are SubscriptionPlan rows (billingService
// DEFAULT_PLANS), not add-ons — but their slugs are referenced everywhere
// entitlements are computed, so they are exported from here alongside the
// module slugs they interact with.
export const BASE_PLAN_SLUG = 'base'
export const ALL_ACCESS_SLUG = 'all_access'
export const ALL_ACCESS_TOKENS_PER_MONTH = 50

export const ADDON_CATALOG: AddonDef[] = [
  {
    slug: 'setaside_intel',
    name: 'Set-Aside Intelligence',
    tagline: 'Win where your certifications give you the edge',
    description: 'Set-aside scanner and eligibility matching for SDVOSB, 8(a), HUBZone, WOSB and more — plus agency set-aside award rates and NAICS market stats so you target the agencies that actually award to firms like yours.',
    priceMonthly: 29,
    priceAnnual: 25,
    icon: '🎖️',
    status: 'available',
    category: 'data',
  },
  {
    slug: 'teaming_suite',
    name: 'Teaming & Subcontracting',
    tagline: 'Find partners and prime contacts for every bid',
    description: 'AI teaming-partner recommendations, partner and arrangement tracking with the teaming board, subcontracting opportunity discovery, prime contact enrichment, and AI outreach drafts.',
    priceMonthly: 49,
    priceAnnual: 42,
    icon: '🤝',
    status: 'available',
    category: 'ai',
    tokensPerMonth: 5,
  },
  {
    slug: 'contract_analysis',
    name: 'Contract Analysis & Compliance',
    tagline: 'Understand every requirement before you bid',
    description: 'Upload solicitations for AI clause extraction, generate compliance matrices with gap analysis and bid guidance, track document requirements, browse FAR/DFARS clauses, and monitor penalty risk.',
    priceMonthly: 59,
    priceAnnual: 50,
    icon: '📋',
    status: 'available',
    category: 'ai',
    tokensPerMonth: 15,
  },
  {
    slug: 'proposal_studio',
    name: 'Proposal Studio',
    tagline: 'AI-drafted outlines and full proposals in minutes',
    description: 'Turn requirements into proposal outlines, full draft PDFs, and win themes. Includes the template library and the AI assistant. 25 proposal tokens included every month — top up with token packs anytime.',
    priceMonthly: 79,
    priceAnnual: 67,
    icon: '✍️',
    status: 'available',
    category: 'ai',
    tokensPerMonth: 25,
  },
  {
    slug: 'market_intel',
    name: 'Market & Competitor Intelligence',
    tagline: 'Know the market and the competition before you bid',
    description: 'Full analytics suite — revenue forecasting, portfolio health, agency buying profiles, incumbent and competitor lookups from USAspending award history.',
    priceMonthly: 39,
    priceAnnual: 33,
    icon: '📊',
    status: 'available',
    category: 'data',
  },
  {
    slug: 'auto_sync',
    name: 'Automated Daily Sync',
    tagline: 'New contracts land in your dashboard every morning',
    description: 'SAM.gov is automatically checked every morning at 6am. New opportunities matching your NAICS filters are ingested, scored, and waiting for you — no manual sync needed.',
    priceMonthly: 29,
    priceAnnual: 25,
    icon: '⚡',
    status: 'available',
    category: 'automation',
  },
  {
    slug: 'api_access',
    name: 'API & MCP Access',
    tagline: 'Connect Claude, your CRM, or custom dashboards',
    description: 'Mint MCP access tokens to use the platform from Claude and other AI tools, plus REST API access for custom integrations.',
    priceMonthly: 49,
    priceAnnual: 42,
    icon: '🔌',
    status: 'available',
    category: 'automation',
  },
  {
    slug: 'client_portal',
    name: 'Client Portal & Branded Reports',
    tagline: 'Give your clients a professional branded experience',
    description: 'Client-facing portal with login access, branded PDF deliverables — pipeline reports, opportunity analyses, compliance summaries — with your firm logo and colors.',
    priceMonthly: 39,
    priceAnnual: 33,
    icon: '📄',
    status: 'available',
    category: 'reporting',
  },
  {
    slug: 'state_municipal',
    name: 'State & Municipal Access',
    tagline: 'Expand beyond federal to state and local contracts',
    description: 'Unlock state, county, and municipal contracting opportunities with the same scoring and tracking you use for federal.',
    priceMonthly: 49,
    priceAnnual: 42,
    icon: '🏛️',
    status: 'coming_soon',
    category: 'data',
  },
]

// ---------------------------------------------------------------
// Legacy slug aliases — firms that bought add-ons under the old
// two-catalog model keep their entitlement under the new module
// that absorbed it. Resolve BEFORE any entitlement/gating check.
// ---------------------------------------------------------------
export const ADDON_ALIASES: Record<string, string> = {
  proposal_assistant: 'proposal_studio',
  proposal_assist_pro: 'proposal_studio',
  compliance_matrix_ai: 'contract_analysis',
  competitor_intel: 'market_intel',
  executive_briefing: 'market_intel',
  branded_reports: 'client_portal',
  teaming_finder: 'teaming_suite',
}

export function resolveAddonSlug(slug: string): string {
  return ADDON_ALIASES[slug] ?? slug
}

export function getAddon(slug: string): AddonDef | undefined {
  return ADDON_CATALOG.find((a) => a.slug === resolveAddonSlug(slug))
}

/** True when the slug is a real module that can be bought today (not a pack, not coming soon). */
export function isPurchasableAddon(slug: string): boolean {
  const addon = ADDON_CATALOG.find((a) => a.slug === slug)
  return Boolean(addon && addon.status === 'available')
}

/** slug → monthly token grant, for the lazy monthly token refresh. */
export const ADDON_TOKEN_GRANTS: Record<string, number> = Object.fromEntries(
  ADDON_CATALOG.filter((a) => a.tokensPerMonth).map((a) => [a.slug, a.tokensPerMonth as number]),
)

// ---------------------------------------------------------------
// Proposal Token Packs — one-time credit purchases
// ---------------------------------------------------------------
export const TOKEN_PACK_SLUGS: Record<string, number> = {
  proposal_tokens_15: 15,
  proposal_tokens_40: 40,
  proposal_tokens_120: 120,
}

// Slug → price in cents (used for Stripe Checkout)
export const TOKEN_PACK_PRICE_CENTS: Record<string, number> = {
  proposal_tokens_15: 2500,   // $25
  proposal_tokens_40: 5000,   // $50
  proposal_tokens_120: 12500, // $125
}

export const TOKEN_PACK_ADDONS: AddonDef[] = [
  {
    slug: 'proposal_tokens_15',
    name: '15 Proposal Tokens',
    tagline: 'Good for 3 full drafts + outlines',
    description: 'One-time purchase of 15 proposal tokens. Use them to generate outlines (1 token each) or full draft PDFs (5 tokens each). Tokens never expire.',
    priceMonthly: 25,
    priceAnnual: 25,
    icon: '🪙',
    status: 'available',
    category: 'ai',
    isTokenPack: true,
    tokenAmount: 15,
  },
  {
    slug: 'proposal_tokens_40',
    name: '40 Proposal Tokens',
    tagline: 'Best value — 8 full drafts + outlines',
    description: 'One-time purchase of 40 proposal tokens. Use them to generate outlines (1 token each) or full draft PDFs (5 tokens each). Tokens never expire.',
    priceMonthly: 50,
    priceAnnual: 50,
    icon: '🪙',
    status: 'available',
    category: 'ai',
    isTokenPack: true,
    tokenAmount: 40,
  },
  {
    slug: 'proposal_tokens_120',
    name: '120 Proposal Tokens',
    tagline: 'Power pack — 24 full drafts + outlines',
    description: 'One-time purchase of 120 proposal tokens. Use them to generate outlines (1 token each) or full draft PDFs (5 tokens each). Tokens never expire.',
    priceMonthly: 125,
    priceAnnual: 125,
    icon: '🪙',
    status: 'available',
    category: 'ai',
    isTokenPack: true,
    tokenAmount: 120,
  },
]
