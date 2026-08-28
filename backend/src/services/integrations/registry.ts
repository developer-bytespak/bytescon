// =============================================================
// §8.5 — The provider registry.
//
// One place that answers, for every provider: what category it belongs to,
// what it can do, which server-side credentials it needs, and — honestly —
// whether this deployment can currently connect it at all.
//
// THE HONESTY RULE that shapes this file: a provider is never described as
// available because its adapter compiles. `platformConfigured` is computed
// from environment variables that actually exist at runtime, and a tenant that
// tries to connect an unconfigured provider is told `CREDENTIAL_REQUIRED`
// rather than being walked into an OAuth redirect that cannot succeed.
// =============================================================
import { IntegrationCategory, IntegrationProvider } from '@prisma/client'

export type ProviderCapability =
  | 'OAUTH2'
  | 'API_KEY'
  | 'WEBHOOK_URL'
  | 'EXPORT_INVOICES'
  | 'EXPORT_VENDOR_BILLS'
  | 'IMPORT_PAYMENTS'
  | 'PUSH_EVENTS'
  | 'UPDATE_EVENTS'
  | 'DELETE_EVENTS'
  | 'SEND_MESSAGE'
  | 'SEND_ENVELOPE'
  | 'INBOUND_WEBHOOK'

export interface ProviderDefinition {
  provider: IntegrationProvider
  category: IntegrationCategory
  label: string
  /** What the adapter can actually do, not what the vendor's product can do. */
  capabilities: ProviderCapability[]
  /** Environment variables this deployment must set before a tenant can connect. */
  requiredEnv: string[]
  /**
   * How far this adapter has been taken. Stated here so the UI, the API and
   * the report all read from the same source rather than from a claim.
   *
   *  ADAPTER_IMPLEMENTED  — a real HTTP client against a documented API,
   *                         exercised against mocks; needs credentials to run.
   *  CONTRACT_ONLY        — the connector boundary exists and is enforced, but
   *                         the vendor's API is not publicly documented enough
   *                         to implement without inventing endpoints.
   */
  implementation: 'ADAPTER_IMPLEMENTED' | 'CONTRACT_ONLY'
  /** Shown to an operator when the provider cannot be connected here. */
  configurationNote: string
}

export const PROVIDER_DEFINITIONS: Record<IntegrationProvider, ProviderDefinition> = {
  QUICKBOOKS: {
    provider: 'QUICKBOOKS',
    category: 'ACCOUNTING',
    label: 'QuickBooks Online',
    capabilities: ['OAUTH2', 'EXPORT_INVOICES', 'EXPORT_VENDOR_BILLS', 'IMPORT_PAYMENTS'],
    requiredEnv: ['QUICKBOOKS_CLIENT_ID', 'QUICKBOOKS_CLIENT_SECRET'],
    implementation: 'ADAPTER_IMPLEMENTED',
    configurationNote: 'Create an Intuit app and set QUICKBOOKS_CLIENT_ID and QUICKBOOKS_CLIENT_SECRET.',
  },
  UNANET: {
    provider: 'UNANET',
    category: 'ACCOUNTING',
    label: 'Unanet',
    capabilities: ['API_KEY'],
    requiredEnv: ['UNANET_BASE_URL', 'UNANET_API_KEY'],
    implementation: 'CONTRACT_ONLY',
    configurationNote:
      'Unanet exposes a per-tenant API whose endpoints are supplied under contract rather than published. The connector boundary and credential storage are in place; the request mapping must be completed against your own tenant documentation before this can sync.',
  },
  DELTEK: {
    provider: 'DELTEK',
    category: 'ACCOUNTING',
    label: 'Deltek Costpoint',
    capabilities: ['API_KEY'],
    requiredEnv: ['DELTEK_BASE_URL', 'DELTEK_API_KEY'],
    implementation: 'CONTRACT_ONLY',
    configurationNote:
      'Costpoint integration endpoints vary by deployment and licensed module, and are supplied under contract rather than published. The connector boundary and credential storage are in place; the request mapping must be completed against your own deployment documentation.',
  },
  GOOGLE_CALENDAR: {
    provider: 'GOOGLE_CALENDAR',
    category: 'CALENDAR',
    label: 'Google Calendar',
    capabilities: ['OAUTH2', 'PUSH_EVENTS', 'UPDATE_EVENTS', 'DELETE_EVENTS'],
    requiredEnv: ['GOOGLE_CALENDAR_CLIENT_ID', 'GOOGLE_CALENDAR_CLIENT_SECRET'],
    implementation: 'ADAPTER_IMPLEMENTED',
    configurationNote: 'Create a Google Cloud OAuth client with the calendar.events scope.',
  },
  MICROSOFT_CALENDAR: {
    provider: 'MICROSOFT_CALENDAR',
    category: 'CALENDAR',
    label: 'Microsoft 365 Calendar',
    capabilities: ['OAUTH2', 'PUSH_EVENTS', 'UPDATE_EVENTS', 'DELETE_EVENTS'],
    requiredEnv: ['MICROSOFT_CLIENT_ID', 'MICROSOFT_CLIENT_SECRET'],
    implementation: 'ADAPTER_IMPLEMENTED',
    configurationNote: 'Register an Entra ID application with the Calendars.ReadWrite scope.',
  },
  SLACK: {
    provider: 'SLACK',
    category: 'CHAT',
    label: 'Slack',
    capabilities: ['OAUTH2', 'SEND_MESSAGE'],
    requiredEnv: ['SLACK_CLIENT_ID', 'SLACK_CLIENT_SECRET'],
    implementation: 'ADAPTER_IMPLEMENTED',
    configurationNote: 'Create a Slack app with the chat:write scope and set its client id and secret.',
  },
  MICROSOFT_TEAMS: {
    provider: 'MICROSOFT_TEAMS',
    category: 'CHAT',
    label: 'Microsoft Teams',
    // An incoming webhook is a per-channel URL the customer pastes in, so this
    // one needs no platform-side application registration.
    capabilities: ['WEBHOOK_URL', 'SEND_MESSAGE'],
    requiredEnv: [],
    implementation: 'ADAPTER_IMPLEMENTED',
    configurationNote: 'Paste an incoming-webhook URL from the Teams channel that should receive notifications.',
  },
  DOCUSIGN: {
    provider: 'DOCUSIGN',
    category: 'ESIGNATURE',
    label: 'DocuSign',
    capabilities: ['OAUTH2', 'SEND_ENVELOPE', 'INBOUND_WEBHOOK'],
    requiredEnv: ['DOCUSIGN_CLIENT_ID', 'DOCUSIGN_CLIENT_SECRET', 'DOCUSIGN_BASE_URL'],
    implementation: 'ADAPTER_IMPLEMENTED',
    configurationNote: 'Create a DocuSign integration key and set its client id, secret and account base URL.',
  },
}

export const ALL_PROVIDERS = Object.keys(PROVIDER_DEFINITIONS) as IntegrationProvider[]

/** Every required variable present and non-empty. Read at call time, not at import. */
export function platformConfigured(provider: IntegrationProvider): boolean {
  const def = PROVIDER_DEFINITIONS[provider]
  return def.requiredEnv.every((key) => {
    const value = process.env[key]
    return typeof value === 'string' && value.trim().length > 0
  })
}

/** The variables an operator still has to set. Names only — never values. */
export function missingEnv(provider: IntegrationProvider): string[] {
  return PROVIDER_DEFINITIONS[provider].requiredEnv.filter((key) => {
    const value = process.env[key]
    return !(typeof value === 'string' && value.trim().length > 0)
  })
}

export function providersInCategory(category: IntegrationCategory): ProviderDefinition[] {
  return ALL_PROVIDERS.map((p) => PROVIDER_DEFINITIONS[p]).filter((d) => d.category === category)
}
