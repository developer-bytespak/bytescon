import type { ContactProvider } from './types'
import { samPocProvider } from './samPocProvider'
import { clayProvider } from './clayProvider'

// Order matters: first available provider wins as default. samPocProvider
// stays first so SAM.gov POCs remain the default whenever SAM_API_KEY is set.
// clayProvider is a selectable/fallback provider placed last so
// free/authoritative sources are preferred over paid enrichment; it is inert
// unless CLAY_ENRICHMENT_ENABLED + CLAY_API_KEY are set, so it never changes
// default behavior on merge.
const REGISTRY: ContactProvider[] = [
  samPocProvider,
  clayProvider,
  // Future:
  // apolloProvider,
  // hunterProvider,
]

export function getContactProvider(key: string): ContactProvider | null {
  return REGISTRY.find((p) => p.key === key) ?? null
}

export function getDefaultProvider(): ContactProvider | null {
  return REGISTRY.find((p) => p.isAvailable()) ?? null
}

export function listProviders(): { key: string; label: string; available: boolean }[] {
  return REGISTRY.map((p) => ({ key: p.key, label: p.label, available: p.isAvailable() }))
}

export type { ContactRow, ContactProvider, FetchContactsArgs } from './types'
