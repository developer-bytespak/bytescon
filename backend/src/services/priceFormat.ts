// =============================================================
// Price formats: what a solicitation asks to see in the price, so the Pricing
// page asks only for that and the proposal's price volume shows only that.
//
// From 57 real SAM.gov solicitations read on 2026-11-21 (their attached
// documents) and the FAR:
//   LINE_ITEMS      a schedule of supplies/services: item, description,
//                   quantity, unit, unit price, amount (SF-1449 blocks 19-24,
//                   SF-18, agency price sheets), often by base and option year.
//                   29 of 57; the default. Commercial buys are firm-fixed-price
//                   and certified cost data can't be required (FAR 12.207,
//                   15.403-1(b)(3)).
//   LABOR_RATES     time-and-materials / labor-hour: one fully loaded hourly
//                   rate per labor category (FAR 16.601). Rare.
//   COST_BREAKDOWN  cost-reimbursement: every cost element and the fee, for
//                   cost realism (FAR 15.404-1(d)). 3 of 57.
//   NONE            a Sources Sought / RFI response: no price.
// Detection is like the template's: the notice type and what the text says,
// strongest first, each with why; the person can switch.
// =============================================================
import { prisma } from '../config/database'
import { logger } from '../utils/logger'
import { checkAiCallLimit, checkProposalTokens, deductProposalTokens } from '../middleware/tierGate'
import { generateWithRouter } from './llm/llmRouter'
import { solicitationText } from './complianceMatrixBuild'

export type PriceFormat = 'LINE_ITEMS' | 'LABOR_RATES' | 'COST_BREAKDOWN' | 'NONE'
export const PRICE_FORMATS: Array<{ key: PriceFormat; name: string; asks: string }> = [
  { key: 'LINE_ITEMS', name: 'Line items (price schedule)', asks: 'A unit price for each item of the schedule; the amount and total are worked out.' },
  { key: 'LABOR_RATES', name: 'Labor rates (time-and-materials)', asks: 'A fully loaded hourly rate for each labor category, and the estimated hours.' },
  { key: 'COST_BREAKDOWN', name: 'Cost breakdown (cost-reimbursement)', asks: 'Every cost element: labor, fringe, overhead, G&A, other direct costs and the fee.' },
  { key: 'NONE', name: 'No price', asks: 'A Sources Sought or RFI response has no price.' },
]
export const isPriceFormat = (v: unknown): v is PriceFormat => PRICE_FORMATS.some((f) => f.key === v)

export interface PriceFormatMatch { format: PriceFormat; reason: string }

/** The price format(s) this solicitation asks for, strongest first, each with why. */
export function detectPriceFormats(input: { noticeType: string | null; texts: string[] }): PriceFormatMatch[] {
  const type = (input.noticeType ?? '').toLowerCase()
  const text = input.texts.filter((t) => t && !/^\s*\[(EVIDENCE_NEEDED|[A-Z ]*REQUIRED)/.test(t)).join('\n')
  const says = (re: RegExp) => re.test(text)
  const found: PriceFormatMatch[] = []
  const add = (format: PriceFormat, reason: string) => { if (!found.some((m) => m.format === format)) found.push({ format, reason }) }

  if (type.includes('sources sought') || (type.includes('special notice') && says(/\b(request for information|RFI)\b/i))) {
    return [{ format: 'NONE', reason: 'It is a Sources Sought / RFI notice: responses carry no price.' }]
  }
  // Cost-reimbursement needs the cost elements for cost realism (FAR 15.404-1(d)).
  if (says(/\bcost[- ](plus|reimburse(ment|able)?)\b|\bCPFF\b|\bCPAF\b|\bCPIF\b/i) && says(/\bcost (breakdown|realism)\b|\b(overhead|fringe|G&A) rates?\b|\bcost elements?\b|\bcertified cost or pricing data\b/i)) {
    add('COST_BREAKDOWN', 'It is cost-reimbursement and asks for the cost elements (cost realism, FAR 15.404-1(d)).')
  }
  if (says(/\bcost breakdown\b|\bbreakdown of (all )?(costs?|prices?)\b|\bdetailed (offer|cost|price) breakdown\b/i)) {
    add('COST_BREAKDOWN', 'It asks for a breakdown of the costs.')
  }
  // Time-and-materials only when the pricing asks for rates, not when a clause merely names it.
  if (says(/\bfully[- ](burdened|loaded)\b[^.]{0,80}\b(rate|labor)|\b(labor|hourly) rates?\b[^.]{0,80}\blabor categor(y|ies)\b|\blabor categor(y|ies)\b[^.]{0,80}\b(hourly|labor) rates?\b/i)) {
    add('LABOR_RATES', 'It asks for hourly rates by labor category (time-and-materials / labor-hour, FAR 16.601).')
  }
  if (says(/\b(unit price|extended (price|amount)|CLINs?|schedule of (supplies|services)|price schedule|pricing schedule|item number)\b/i) || type.includes('combined synopsis')) {
    add('LINE_ITEMS', type.includes('combined synopsis') && !says(/\b(unit price|CLIN)/i)
      ? 'It is a combined synopsis/solicitation: a firm-fixed-price schedule of items (FAR 12.207).'
      : 'It has a schedule of items to price: item, quantity, unit and unit price.')
  }
  return found
}

/** For a new price: the one chosen, else the solicitation's first, else line items. (A price stored without one predates formats: a cost build-up.) */
export const priceFormatOf = (chosen: string | null | undefined, matches: PriceFormatMatch[]): PriceFormat =>
  isPriceFormat(chosen) ? chosen : matches[0]?.format ?? 'LINE_ITEMS'

/** The solicitation's text and notice type, for detection and for reading its items. */
export async function pricingSources(consultingFirmId: string, opportunityId: string): Promise<{ noticeType: string | null; text: string; requirementTexts: string[]; hasDocuments: boolean }> {
  const opp = await prisma.opportunity.findFirst({
    where: { id: opportunityId, consultingFirmId },
    include: { documents: { orderBy: { uploadedAt: 'desc' }, take: 8 } },
  })
  if (!opp) return { noticeType: null, text: '', requirementTexts: [], hasDocuments: false }
  const matrix = await prisma.complianceMatrix.findFirst({ where: { opportunityId, consultingFirmId }, select: { id: true } })
  const requirementTexts = matrix ? (await prisma.matrixRequirement.findMany({ where: { matrixId: matrix.id, verificationStatus: { not: 'REJECTED' } }, select: { requirementText: true } })).map((r) => r.requirementText) : []
  const text = await solicitationText(opp)
  return { noticeType: opp.noticeType, text, requirementTexts, hasDocuments: opp.documents.length > 0 }
}

export async function detectForOpportunity(consultingFirmId: string, opportunityId: string): Promise<PriceFormatMatch[]> {
  const s = await pricingSources(consultingFirmId, opportunityId)
  return detectPriceFormats({ noticeType: s.noticeType, texts: [s.text, ...s.requirementTexts] })
}

export interface ExtractedItem { itemNumber: string; description: string; quantity: number; unit: string; period: string | null }

const ITEMS_PROMPT = `You read a U.S. federal solicitation and list the line items the offeror must price: its schedule of supplies/services (CLINs / item numbers), e.g. SF-1449 blocks 19-24, an SF-18 schedule, Section B, or an attached price sheet.

Return ONLY a JSON array, no prose. Each element:
{"itemNumber": "0001", "description": "short description", "quantity": 12, "unit": "MO", "period": "Base Year" }

Rules:
- Only items the solicitation actually lists. Never invent items. If it lists none, return [].
- quantity: a number (1 when not stated). unit: the unit of issue as written (EA, MO, HR, LOT, JB...), "EA" when not stated.
- period: only when the solicitation lists the item under a named base or option period ("Base Year", "Option Year 1", ...). Otherwise null: never assume "Base Year".
- Leave prices out: they are the offeror's to fill in.
- Repeat an item for each period it is listed under.`

/** Reads the solicitation's item list with the AI. Throws when the AI is unavailable. */
export async function readItemsWithAi(consultingFirmId: string, title: string, text: string): Promise<ExtractedItem[]> {
  const res = await generateWithRouter({ systemPrompt: ITEMS_PROMPT, userPrompt: `Solicitation: ${title}\n\n${text.slice(0, 60000)}`, maxTokens: 4000, temperature: 0 }, consultingFirmId, { task: 'DOCUMENT_ANALYSIS' })
  return parseItems(res.text)
}

export function parseItems(raw: string): ExtractedItem[] {
  const m = raw.match(/\[[\s\S]*\]/)
  if (!m) return []
  let arr: unknown
  try { arr = JSON.parse(m[0]) } catch { return [] }
  if (!Array.isArray(arr)) return []
  return arr.flatMap((x) => {
    if (!x || typeof x !== 'object') return []
    const o = x as Record<string, unknown>
    const description = String(o.description ?? '').trim()
    if (!description) return []
    const q = Number(o.quantity)
    return [{
      itemNumber: String(o.itemNumber ?? '').trim().slice(0, 40) || '—',
      description: description.slice(0, 1000),
      quantity: Number.isFinite(q) && q > 0 ? q : 1,
      unit: String(o.unit ?? 'EA').trim().slice(0, 20) || 'EA',
      period: o.period ? String(o.period).trim().slice(0, 60) : null,
    }]
  }).slice(0, 300)
}

export const pricingSetupEnabled = (): boolean => process.env.PRICING_AUTO_SETUP !== 'off'

/**
 * Fills a price's line items from its solicitation (AI, 1 token): only when it
 * has none. itemsStatus is PREPARING while this runs and DONE after, with
 * itemsNote saying what it did or why it stopped short.
 */
export async function readSolicitationItems(consultingFirmId: string, workspaceId: string, userId: string | null): Promise<void> {
  const ws = await prisma.pricingWorkspace.findFirst({ where: { id: workspaceId, consultingFirmId }, select: { id: true, opportunityId: true, _count: { select: { lineItems: true } } } })
  if (!ws) return
  await prisma.pricingWorkspace.update({ where: { id: ws.id }, data: { itemsStatus: 'PREPARING', itemsNote: null } })
  let note = ''
  try {
    if (ws._count.lineItems > 0) { note = 'This price already has items.'; return }
    const s = await pricingSources(consultingFirmId, ws.opportunityId)
    if (!s.hasDocuments) { note = 'No solicitation documents to read the items from yet: add them yourself, or add the documents and read again.'; return }
    const ai = await checkAiCallLimit(consultingFirmId)
    if (!ai.allowed) { note = `Items were not read: AI call limit reached (${ai.current}/${ai.max} this month).`; return }
    const tokens = await checkProposalTokens(consultingFirmId, 1)
    if (!tokens.allowed) { note = 'Items were not read: no proposal tokens left. Add the items yourself.'; return }
    const opp = await prisma.opportunity.findUnique({ where: { id: ws.opportunityId }, select: { title: true } })
    const items = await readItemsWithAi(consultingFirmId, opp?.title ?? '', s.text)
    await deductProposalTokens(consultingFirmId, 1, { userId, opportunityId: ws.opportunityId, reason: 'Price schedule read from the solicitation (1 token)' })
    if (!items.length) { note = 'The solicitation lists no items to price that could be read: add them yourself.'; return }
    await prisma.pricingLineItem.createMany({
      data: items.map((it, i) => ({ consultingFirmId, workspaceId: ws.id, itemNumber: it.itemNumber, description: it.description, quantity: it.quantity, unit: it.unit, periodLabel: it.period, sortOrder: i, source: 'SOLICITATION' })),
    })
    note = `Read ${items.length} item${items.length === 1 ? '' : 's'} from the solicitation (1 token). Enter a unit price for each.`
  } catch (err) {
    logger.error('Reading the price schedule did not finish', { workspaceId, error: (err as Error).message })
    note = 'Items could not be read from the solicitation: add them yourself, or try again.'
  } finally {
    await prisma.pricingWorkspace.update({ where: { id: ws.id }, data: { itemsStatus: 'DONE', itemsNote: note || null } }).catch(() => undefined)
  }
}

/** A line-item price is built once it has items and every one has a unit price. */
export function lineItemsPriced(items: Array<{ unitPrice: unknown }>): boolean {
  return items.length > 0 && items.every((i) => i.unitPrice !== null && i.unitPrice !== undefined && Number(i.unitPrice) >= 0)
}

/**
 * The fully loaded hourly rate for a labor line, from the internal build-up:
 * its direct rate times the scenario's labor wrap (fringe, overhead, G&A and
 * fee over direct labor), as FAR 16.601 rates include them.
 */
export function wrapFactor(s: { totalDirectLabor: unknown; subtotalBeforeFee: unknown; totalFee: unknown; totalOdc: unknown; totalSubcontractor: unknown }): number {
  const direct = Number(s.totalDirectLabor ?? 0)
  if (!direct) return 1
  const loaded = Number(s.subtotalBeforeFee ?? 0) + Number(s.totalFee ?? 0) - Number(s.totalOdc ?? 0) - Number(s.totalSubcontractor ?? 0)
  return loaded > 0 ? loaded / direct : 1
}
