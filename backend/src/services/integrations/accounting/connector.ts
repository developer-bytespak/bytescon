// =============================================================
// §8.5 — The accounting connector contract.
//
// THE DIRECTION RULE, which is the whole design: the internal ERP is
// authoritative for Bytescon operational state. An accounting product receives
// what Bytescon decided; it does not decide anything on Bytescon's behalf.
//
//   ContractInvoice     → external invoice        EXPORT
//   SubcontractInvoice  → external vendor bill    EXPORT
//   ContractCost        → external expense        EXPORT
//   external payment    → InvoicePayment          IMPORT (reconciliation only)
//
// There is no uncontrolled two-way sync. The one inbound direction is payment
// reconciliation, because the bank tells the accounting system about money
// before it tells Bytescon — and even that writes a payment row, never an
// invoice, never a cost, and never a status the platform's own approval flow
// is responsible for.
//
// Every provider implements as much of this as its API supports and declares
// the rest through the registry. Nothing is forced to pretend.
// =============================================================
import { IntegrationProvider } from '@prisma/client'
import type { DecryptedCredential } from '../connectionService'

export interface ConnectorContext {
  consultingFirmId: string
  connectionId: string
  credential: DecryptedCredential
}

/** A normalized failure. Adapters never throw raw provider errors upward. */
export class ConnectorError extends Error {
  constructor(
    message: string,
    readonly kind: 'NO_CREDENTIAL' | 'UNAUTHORIZED' | 'RATE_LIMITED' | 'TIMEOUT' | 'PROVIDER_ERROR' | 'NOT_SUPPORTED',
    readonly retryable: boolean = false,
    readonly retryAfterSeconds?: number,
  ) {
    super(message)
    this.name = 'ConnectorError'
  }
}

export interface ConnectionTestResult {
  ok: boolean
  /** The provider's account/company name, when it will tell us. */
  accountName?: string
  accountId?: string
  detail: string
}

/** One record on its way out. `idempotencyKey` is the local record's identity. */
export interface ExportPayload {
  localType: 'ContractInvoice' | 'SubcontractInvoice' | 'ContractCost'
  localId: string
  idempotencyKey: string
  documentNumber: string
  counterpartyName: string
  issuedOn: Date | null
  dueOn: Date | null
  /** Exact decimal string. Money is never a float on the way to a ledger. */
  amount: string
  currency: string
  memo?: string
  lines: Array<{ description: string; amount: string }>
}

export interface ExportResult {
  externalId: string
  externalType: string
  /** True when the provider matched an existing object instead of creating one. */
  deduped: boolean
}

export interface RemotePayment {
  externalId: string
  externalInvoiceId: string
  amount: string
  paidOn: Date | null
  reference: string | null
}

/**
 * What every accounting adapter offers. A method a provider cannot support
 * throws ConnectorError('NOT_SUPPORTED') rather than silently doing nothing —
 * a no-op that reports success is how a customer discovers at year end that
 * nothing was ever exported.
 */
export interface AccountingConnector {
  readonly provider: IntegrationProvider
  /** Verify the stored credential actually authenticates. */
  testConnection(ctx: ConnectorContext): Promise<ConnectionTestResult>
  /** Push one record. MUST be idempotent on `payload.idempotencyKey`. */
  exportDocument(ctx: ConnectorContext, payload: ExportPayload): Promise<ExportResult>
  /** Payments recorded against exported invoices since `since`. */
  fetchPayments(ctx: ConnectorContext, since: Date | null): Promise<RemotePayment[]>
  /** Exchange a refresh token, where the provider issues one. */
  refresh?(ctx: ConnectorContext): Promise<{ accessToken: string; refreshToken?: string; expiresAt: Date }>
}
