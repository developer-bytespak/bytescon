// =============================================================
// §8.5 — Unanet and Deltek Costpoint.
//
// These two are CONTRACT_ONLY, and that is a deliberate, documented decision
// rather than a shortfall hidden behind a stub.
//
// Both vendors supply their integration endpoints under customer contract:
// Unanet's REST surface is per-tenant and versioned by deployment, and
// Costpoint's varies with the licensed modules and the on-premise release. The
// authentication, the object model and the paths differ between customers.
// Writing plausible-looking endpoints here would produce something that
// compiles, passes its own mocks, and fails the first time a real customer
// connects it — while reading, in a status page, as "implemented".
//
// So the connector boundary is real and enforced: credentials are stored and
// encrypted exactly like every other provider, the connection lifecycle works,
// and the sync ledger is ready. Every operation that would need an invented
// endpoint refuses with NOT_SUPPORTED and says precisely what is missing. When
// a customer supplies their own endpoint documentation, only the request
// mapping in this file has to be written; nothing around it changes.
// =============================================================
import { IntegrationProvider } from '@prisma/client'
import { PROVIDER_DEFINITIONS } from '../registry'
import {
  ConnectorError,
  type AccountingConnector, type ConnectionTestResult, type ConnectorContext,
  type ExportPayload, type ExportResult, type RemotePayment,
} from './connector'

function notMapped(provider: IntegrationProvider, operation: string): never {
  throw new ConnectorError(
    `${PROVIDER_DEFINITIONS[provider].label} ${operation} is not mapped on this deployment. ` +
    PROVIDER_DEFINITIONS[provider].configurationNote,
    'NOT_SUPPORTED',
    false,
  )
}

function buildConnector(provider: IntegrationProvider): AccountingConnector {
  return {
    provider,

    /**
     * Reports the honest state instead of a green tick.
     *
     * `ok: false` with a specific reason, so the Integrations page shows
     * "configuration required" rather than "connected" — the operator learns
     * what is missing at connect time, not at year end.
     */
    async testConnection(ctx: ConnectorContext): Promise<ConnectionTestResult> {
      const hasCredential = Boolean(ctx.credential.accessToken)
      return {
        ok: false,
        detail: hasCredential
          ? `A credential is stored for ${PROVIDER_DEFINITIONS[provider].label}, but no endpoint mapping is configured on this deployment. ${PROVIDER_DEFINITIONS[provider].configurationNote}`
          : `No credential is stored for ${PROVIDER_DEFINITIONS[provider].label}. ${PROVIDER_DEFINITIONS[provider].configurationNote}`,
      }
    },

    async exportDocument(_ctx: ConnectorContext, payload: ExportPayload): Promise<ExportResult> {
      notMapped(provider, `export of ${payload.localType}`)
    },

    async fetchPayments(): Promise<RemotePayment[]> {
      notMapped(provider, 'payment reconciliation')
    },
  }
}

export const unanetConnector = buildConnector(IntegrationProvider.UNANET)
export const deltekConnector = buildConnector(IntegrationProvider.DELTEK)
