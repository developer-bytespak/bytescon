// =============================================================
// §8.5 — Accounting synchronization.
//
// THE THING THIS MODULE EXISTS TO PREVENT: a repeated sync, a retried worker
// or a replayed webhook creating a second invoice, a second vendor bill or a
// second payment. Money that is counted twice is worse than money that is not
// counted at all, because nobody notices.
//
// The mechanism is IntegrationSyncRecord, a unique row per
// (connection, localType, localId) carrying the id the provider assigned.
// Before anything is sent, that row is consulted; after, it is written. The
// adapters are idempotent on their own side too, so both layers have to fail
// for a duplicate to happen.
//
// Payment reconciliation is the one inbound direction, and it writes exactly
// one thing: an InvoicePayment row against an invoice this connection
// previously exported. It never creates an invoice, never creates a cost, and
// never moves a status the platform's own approval flow owns.
// =============================================================
import crypto from 'crypto'
import { IntegrationProvider, Prisma } from '@prisma/client'
import { prisma } from '../../../config/database'
import { logger } from '../../../utils/logger'
import { ValidationError } from '../../../utils/errors'
import {
  findConnection, readCredential, recordFailure, recordSuccess, retriesExhausted,
} from '../connectionService'
import { quickbooksConnector } from './quickbooks'
import { unanetConnector, deltekConnector } from './contractOnly'
import {
  ConnectorError, type AccountingConnector, type ConnectorContext, type ExportPayload,
} from './connector'

const CONNECTORS: Partial<Record<IntegrationProvider, AccountingConnector>> = {
  QUICKBOOKS: quickbooksConnector,
  UNANET: unanetConnector,
  DELTEK: deltekConnector,
}

export function connectorFor(provider: IntegrationProvider): AccountingConnector {
  const connector = CONNECTORS[provider]
  if (!connector) throw new ValidationError(`${provider} is not an accounting provider`)
  return connector
}

/** Test seam so the suite can drive the whole lifecycle without a live vendor. */
export function __setAccountingConnector(provider: IntegrationProvider, connector: AccountingConnector | null): void {
  if (connector) CONNECTORS[provider] = connector
  else delete CONNECTORS[provider]
}

function payloadHash(payload: ExportPayload): string {
  return crypto.createHash('sha256').update(JSON.stringify({
    n: payload.documentNumber, a: payload.amount, c: payload.counterpartyName,
    d: payload.issuedOn?.toISOString() ?? null, l: payload.lines,
  })).digest('hex')
}

export interface SyncOutcome {
  localType: string
  localId: string
  externalId: string | null
  action: 'CREATED' | 'ALREADY_SYNCED' | 'UPDATED_LEDGER' | 'SKIPPED' | 'FAILED'
  detail?: string
}

/**
 * Export one record, exactly once.
 *
 * Order matters. The ledger is read first, so a record already exported is
 * never re-sent; the adapter is called second, and is itself idempotent; the
 * ledger is written last, inside a unique constraint, so two concurrent
 * workers cannot both claim to have created the same external object.
 */
export async function exportDocument(
  consultingFirmId: string, provider: IntegrationProvider, payload: ExportPayload,
): Promise<SyncOutcome> {
  const connection = await findConnection(consultingFirmId, provider)
  if (!connection) {
    return { localType: payload.localType, localId: payload.localId, externalId: null, action: 'SKIPPED', detail: 'No connection for this provider' }
  }
  if (retriesExhausted(connection)) {
    return {
      localType: payload.localType, localId: payload.localId, externalId: null, action: 'SKIPPED',
      detail: 'This connection has failed too many times in a row; reconnect it before syncing again.',
    }
  }

  const existing = await prisma.integrationSyncRecord.findUnique({
    where: {
      connectionId_localType_localId: {
        connectionId: connection.id, localType: payload.localType, localId: payload.localId,
      },
    },
  })
  const hash = payloadHash(payload)
  if (existing && existing.payloadHash === hash) {
    // Nothing changed. The provider is not asked, so there is nothing to
    // duplicate.
    return { localType: payload.localType, localId: payload.localId, externalId: existing.externalId, action: 'ALREADY_SYNCED' }
  }

  const connector = connectorFor(provider)
  const ctx: ConnectorContext = {
    consultingFirmId, connectionId: connection.id, credential: readCredential(connection),
  }

  try {
    const result = await connector.exportDocument(ctx, payload)
    await prisma.integrationSyncRecord.upsert({
      where: {
        connectionId_localType_localId: {
          connectionId: connection.id, localType: payload.localType, localId: payload.localId,
        },
      },
      create: {
        connectionId: connection.id, consultingFirmId,
        localType: payload.localType, localId: payload.localId,
        externalId: result.externalId, externalType: result.externalType,
        direction: 'EXPORT', payloadHash: hash, lastSyncedAt: new Date(),
      },
      update: {
        externalId: result.externalId, externalType: result.externalType,
        payloadHash: hash, lastSyncedAt: new Date(), lastError: null,
      },
    })
    await recordSuccess(connection.id)
    return {
      localType: payload.localType, localId: payload.localId, externalId: result.externalId,
      action: result.deduped ? 'UPDATED_LEDGER' : 'CREATED',
    }
  } catch (err) {
    const message = err instanceof ConnectorError ? err.message : 'The export failed.'
    await recordFailure(connection.id, message)
    return { localType: payload.localType, localId: payload.localId, externalId: null, action: 'FAILED', detail: message }
  }
}

function money(value: Prisma.Decimal): string {
  return value.toFixed(2)
}

/** Turn an approved contract invoice into an export payload. */
export async function buildInvoicePayload(
  consultingFirmId: string, invoiceId: string,
): Promise<ExportPayload | null> {
  const invoice = await prisma.contractInvoice.findFirst({
    where: { id: invoiceId, consultingFirmId },
    include: { lineItems: true, contract: { select: { contractNumber: true, title: true } } },
  })
  if (!invoice) return null
  return {
    localType: 'ContractInvoice',
    localId: invoice.id,
    idempotencyKey: invoice.id,
    documentNumber: invoice.invoiceNumber,
    counterpartyName: invoice.customerName ?? invoice.contract.contractNumber,
    issuedOn: invoice.invoiceDate,
    dueOn: invoice.dueDate,
    amount: money(invoice.total),
    currency: 'USD',
    memo: invoice.contract.title,
    lines: invoice.lineItems.length > 0
      ? invoice.lineItems.map((l) => ({ description: l.description, amount: money(l.amount) }))
      : [{ description: invoice.contract.title, amount: money(invoice.total) }],
  }
}

export async function buildSubcontractInvoicePayload(
  consultingFirmId: string, invoiceId: string,
): Promise<ExportPayload | null> {
  const invoice = await prisma.subcontractInvoice.findFirst({
    where: { id: invoiceId, consultingFirmId },
    include: { purchaseOrder: { select: { poNumber: true } } },
  })
  if (!invoice) return null
  return {
    localType: 'SubcontractInvoice',
    localId: invoice.id,
    idempotencyKey: invoice.id,
    documentNumber: invoice.invoiceNumber,
    counterpartyName: invoice.vendorName,
    issuedOn: invoice.invoiceDate,
    dueOn: null,
    amount: money(invoice.amount),
    currency: 'USD',
    memo: invoice.purchaseOrder?.poNumber,
    lines: [{ description: `Subcontract ${invoice.purchaseOrder?.poNumber ?? ''}`.trim(), amount: money(invoice.amount) }],
  }
}

export interface ReconcileResult {
  matched: number
  created: number
  skipped: number
  details: string[]
}

/**
 * Reconcile payments the accounting system recorded.
 *
 * A remote payment reaches a local invoice only through the sync ledger, so a
 * payment against an object this connection never exported is skipped rather
 * than guessed at. The InvoicePayment row itself is keyed by the provider's
 * payment id in its own sync record, so a repeated poll — or a replayed
 * webhook — reconciles to the row that already exists.
 */
export async function reconcilePayments(
  consultingFirmId: string, provider: IntegrationProvider, since: Date | null,
): Promise<ReconcileResult> {
  const result: ReconcileResult = { matched: 0, created: 0, skipped: 0, details: [] }
  const connection = await findConnection(consultingFirmId, provider)
  if (!connection) {
    result.details.push('No connection for this provider')
    return result
  }

  const connector = connectorFor(provider)
  const ctx: ConnectorContext = {
    consultingFirmId, connectionId: connection.id, credential: readCredential(connection),
  }

  let payments
  try {
    payments = await connector.fetchPayments(ctx, since)
  } catch (err) {
    const message = err instanceof ConnectorError ? err.message : 'The payment fetch failed.'
    await recordFailure(connection.id, message)
    result.details.push(message)
    return result
  }

  for (const payment of payments) {
    // Which local invoice is this? Only the ledger may answer.
    const link = await prisma.integrationSyncRecord.findFirst({
      where: {
        connectionId: connection.id, localType: 'ContractInvoice', externalId: payment.externalInvoiceId,
      },
      select: { localId: true },
    })
    if (!link) { result.skipped++; continue }

    const invoice = await prisma.contractInvoice.findFirst({
      where: { id: link.localId, consultingFirmId }, select: { id: true, amountPaid: true, total: true },
    })
    if (!invoice) { result.skipped++; continue }

    // Already reconciled? The payment's own external id is its ledger key.
    const already = await prisma.integrationSyncRecord.findUnique({
      where: { connectionId_externalId: { connectionId: connection.id, externalId: payment.externalId } },
    })
    if (already) { result.matched++; continue }

    const amount = new Prisma.Decimal(payment.amount)
    await prisma.$transaction(async (tx) => {
      const created = await tx.invoicePayment.create({
        data: {
          consultingFirmId, invoiceId: invoice.id, amount,
          paymentDate: payment.paidOn, referenceNumber: payment.reference,
          method: 'ACCOUNTING_SYNC',
          notes: `Reconciled from ${provider}`,
          // No internal user recorded: no internal user did this.
          recordedByUserId: null,
        },
        select: { id: true },
      })
      const paid = new Prisma.Decimal(invoice.amountPaid).plus(amount)
      await tx.contractInvoice.update({
        where: { id: invoice.id },
        data: {
          amountPaid: paid,
          // Only the payment-derived states. Approval and submission belong to
          // the platform's own human flow and are never set from here.
          status: paid.greaterThanOrEqualTo(invoice.total) ? 'PAID' : 'PARTIALLY_PAID',
          ...(paid.greaterThanOrEqualTo(invoice.total) ? { paidAt: payment.paidOn ?? new Date() } : {}),
        },
      })
      await tx.integrationSyncRecord.create({
        data: {
          connectionId: connection.id, consultingFirmId,
          localType: 'InvoicePayment', localId: created.id,
          externalId: payment.externalId, externalType: 'Payment',
          direction: 'IMPORT', lastSyncedAt: new Date(),
        },
      })
    })
    result.created++
  }

  await recordSuccess(connection.id)
  logger.info('Accounting payment reconciliation complete', {
    consultingFirmId, provider, matched: result.matched, created: result.created, skipped: result.skipped,
  })
  return result
}
