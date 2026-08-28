// =============================================================
// §8.2 — Posting an approved subcontractor invoice to actual cost.
//
// One authoritative rule, in one place: an approved vendor invoice becomes
// actual contract cost by writing exactly ONE ContractCost row, category
// SUBCONTRACTOR, carrying its source linkage back to the invoice.
//
// Why this shape rather than a parallel cost ledger:
//   - actual cost already has a definition — approved TimeEntry plus approved
//     ContractCost — used by the finance API, the burn monitor and the Contract
//     Administration Agent. Posting through ContractCost means the ERP view and
//     every existing consumer agree by construction.
//   - a second ledger would have to be summed alongside the first, and every
//     future reader would have to remember to do it. That is how double counting
//     starts.
//
// Idempotency is structural, not hopeful: `SubcontractInvoice.postedContractCostId`
// is unique, and the whole post runs in one transaction that re-reads the
// invoice inside it. Re-approving, retrying, or two requests racing all converge
// on the same single cost row.
// =============================================================
import { CostSourceType, Prisma, SubcontractInvoiceStatus } from '@prisma/client'
import { prisma } from '../../config/database'

export interface PostingResult {
  posted: boolean
  contractCostId: string
  /** True when this call created the cost; false when it already existed. */
  created: boolean
  reason: string
}

/**
 * Post an approved subcontractor invoice to actual cost, exactly once.
 *
 * Callers may invoke this repeatedly — on approval, on retry, from a backfill —
 * without risk of a second cost row.
 */
export async function postSubcontractInvoiceCost(
  consultingFirmId: string,
  invoiceId: string,
  actorUserId: string | null,
): Promise<PostingResult> {
  return prisma.$transaction(async (tx) => {
    const invoice = await tx.subcontractInvoice.findFirst({
      where: { id: invoiceId, consultingFirmId },
      include: {
        lines: { select: { amount: true, clinId: true } },
        purchaseOrder: { select: { id: true, contractId: true, clinId: true, poNumber: true } },
      },
    })
    if (!invoice) throw new Error('Subcontract invoice not found')

    if (invoice.status !== SubcontractInvoiceStatus.APPROVED && invoice.status !== SubcontractInvoiceStatus.PAID) {
      throw new Error('Only an approved invoice can be posted to contract cost')
    }

    // Already posted — return the existing row rather than creating another.
    if (invoice.postedContractCostId) {
      return {
        posted: true,
        contractCostId: invoice.postedContractCostId,
        created: false,
        reason: 'This invoice was already posted; the existing cost record is unchanged.',
      }
    }

    // Defensive second check on the cost side, in case a prior attempt wrote the
    // cost but failed before stamping the invoice.
    const orphan = await tx.contractCost.findFirst({
      where: { consultingFirmId, sourceType: CostSourceType.SUBCONTRACT_INVOICE, sourceId: invoice.id },
      select: { id: true },
    })
    if (orphan) {
      await tx.subcontractInvoice.update({
        where: { id: invoice.id },
        data: { postedContractCostId: orphan.id, postedAt: new Date() },
      })
      return {
        posted: true,
        contractCostId: orphan.id,
        created: false,
        reason: 'A cost record already existed for this invoice; the invoice was linked to it rather than posting again.',
      }
    }

    // A single line's CLIN is used only when the whole invoice sits on one CLIN;
    // a mixed invoice posts at contract level rather than guessing an allocation.
    const lineClins = new Set(invoice.lines.map((l) => l.clinId).filter((c): c is string => Boolean(c)))
    const clinId = lineClins.size === 1 ? [...lineClins][0] : invoice.purchaseOrder.clinId

    const cost = await tx.contractCost.create({
      data: {
        consultingFirmId,
        contractId: invoice.purchaseOrder.contractId,
        clinId,
        category: 'SUBCONTRACTOR',
        description: `Subcontract invoice ${invoice.invoiceNumber} — ${invoice.vendorName} (PO ${invoice.purchaseOrder.poNumber})`,
        amount: invoice.amount,
        incurredDate: invoice.invoiceDate,
        // Approved on the invoice is approved as cost; a second approval step
        // would make the same human decision twice.
        status: 'APPROVED',
        approvedByUserId: invoice.approvedByUserId ?? actorUserId,
        approvedAt: invoice.approvedAt ?? new Date(),
        createdByUserId: actorUserId,
        sourceType: CostSourceType.SUBCONTRACT_INVOICE,
        sourceId: invoice.id,
      },
      select: { id: true },
    })

    await tx.subcontractInvoice.update({
      where: { id: invoice.id },
      data: { postedContractCostId: cost.id, postedAt: new Date() },
    })

    return {
      posted: true,
      contractCostId: cost.id,
      created: true,
      reason: 'Approved invoice posted to contract cost as a subcontractor expense.',
    }
  })
}

export interface PurchaseOrderBalance {
  purchaseOrderId: string
  ceiling: string
  invoicedTotal: string
  postedTotal: string
  remaining: string
  overInvoiced: boolean
}

/**
 * Balance of one purchase order.
 *
 * `invoicedTotal` counts everything not rejected — including invoices still
 * under review, because they are real claims against the order. `postedTotal`
 * counts only what has become actual cost.
 */
export async function computePurchaseOrderBalance(
  consultingFirmId: string,
  purchaseOrderId: string,
): Promise<PurchaseOrderBalance> {
  const po = await prisma.purchaseOrder.findFirst({
    where: { id: purchaseOrderId, consultingFirmId },
    select: {
      id: true,
      ceilingAmount: true,
      invoices: { select: { amount: true, status: true, postedContractCostId: true } },
    },
  })
  if (!po) throw new Error('Purchase order not found')

  const zero = new Prisma.Decimal(0)
  const counted = po.invoices.filter((i) => i.status !== SubcontractInvoiceStatus.REJECTED)
  const invoicedTotal = counted.reduce((s, i) => s.plus(i.amount), zero)
  const postedTotal = po.invoices
    .filter((i) => i.postedContractCostId)
    .reduce((s, i) => s.plus(i.amount), zero)
  const remaining = new Prisma.Decimal(po.ceilingAmount).minus(invoicedTotal)

  return {
    purchaseOrderId: po.id,
    ceiling: new Prisma.Decimal(po.ceilingAmount).toFixed(2),
    invoicedTotal: invoicedTotal.toFixed(2),
    postedTotal: postedTotal.toFixed(2),
    remaining: remaining.toFixed(2),
    overInvoiced: remaining.isNegative(),
  }
}
