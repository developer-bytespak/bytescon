// =============================================================
// Proposal templates: the standard layouts federal buyers ask for, and the one
// document model the preview, the PDF and the Word file are all made from.
//
// SAM.gov itself has no proposal template: each solicitation's Section L says
// what it wants. So a template gives the standard layout (volumes, cover
// letter, form page, default format) and the solicitation's own format rules
// (proposalFormat.ts) are applied on top: font, size, margins, spacing, page
// limits. The template is chosen from the solicitation itself (detectTemplates:
// its notice type and what it says), template 1 (full proposal) when nothing
// says; the person can switch, and the choice is kept on the proposal (templateKey).
// =============================================================
import { prisma } from '../config/database'
import { NotFoundError } from '../utils/errors'
import { readFormat, type ProposalFormat, type VolumeKey } from './proposalFormat'
import { isPriceFormat, wrapFactor } from './priceFormat'

export type TemplateKey = 'FULL_PROPOSAL' | 'COMMERCIAL' | 'RFQ_QUOTE' | 'SOURCES_SOUGHT' | 'GSA_EBUY'

export interface TemplateInfo {
  key: TemplateKey
  name: string
  /** When it's the right choice, in one line. */
  use: string
  /** The government form that goes on top, if any. */
  form: { code: string; name: string; url: string } | null
}

export const TEMPLATES: TemplateInfo[] = [
  { key: 'FULL_PROPOSAL', name: 'Full proposal (FAR Part 15 RFP)', use: 'Negotiated contracts: separate technical, past performance and price volumes.', form: { code: 'SF-33', name: 'Solicitation, Offer and Award', url: 'https://www.gsa.gov/forms-library/solicitation-offer-and-award' } },
  { key: 'COMMERCIAL', name: 'Commercial items (FAR Part 12)', use: 'Commercial products and services: a technical response and a price schedule.', form: { code: 'SF-1449', name: 'Solicitation/Contract/Order for Commercial Products and Commercial Services', url: 'https://www.gsa.gov/forms-library/solicitationcontractorder-commercial-products-and-commercial-services' } },
  { key: 'RFQ_QUOTE', name: 'Quote (RFQ, simplified acquisition)', use: 'Smaller buys: a quote letter, the price schedule and a short technical description.', form: { code: 'SF-18', name: 'Request for Quotations', url: 'https://www.gsa.gov/forms-library/request-quotations' } },
  { key: 'SOURCES_SOUGHT', name: 'Sources Sought / RFI response', use: 'Market research: a capability statement with your company facts and answers, no price.', form: null },
  { key: 'GSA_EBUY', name: 'GSA eBuy quote', use: 'GSA Schedule holders answering an eBuy RFQ: quote letter, schedule pricing and technical response.', form: null },
]
export const DEFAULT_TEMPLATE: TemplateKey = 'FULL_PROPOSAL'

export interface TemplateMatch { key: TemplateKey; reason: string }

/**
 * The template(s) this solicitation asks for, strongest first, each with why:
 * from its SAM.gov notice type and what its text says (the form it names, a
 * quote, FAR Part 12 / 13 / 15, eBuy, a capability statement). Empty when
 * nothing says (e.g. an award notice): then the full proposal is the default.
 */
export function detectTemplates(input: { noticeType: string | null; texts: string[] }): TemplateMatch[] {
  const type = (input.noticeType ?? '').toLowerCase()
  // Placeholders the AI wrote where the solicitation was missing say nothing.
  const text = input.texts.filter((t) => t && !/^\s*\[(EVIDENCE_NEEDED|[A-Z ]*REQUIRED)/.test(t)).join('\n')
  const found: TemplateMatch[] = []
  const add = (key: TemplateKey, reason: string) => { if (!found.some((m) => m.key === key)) found.push({ key, reason }) }
  const says = (re: RegExp) => re.test(text)

  if (type.includes('sources sought')) add('SOURCES_SOUGHT', 'It is a Sources Sought notice: a capability statement answers it.')
  if (type.includes('special notice') && says(/\b(request for information|RFI)\b|capabilit(y|ies) statement/i)) add('SOURCES_SOUGHT', 'It is a request for information: a capability statement answers it.')
  if (says(/\b(e-?buy|GSA (MAS|schedule)|multiple award schedule)\b/i)) add('GSA_EBUY', 'It is a GSA Schedule (eBuy) request.')
  if (says(/\bSF[- ]?1449\b/i)) add('COMMERCIAL', 'It asks for form SF-1449 (commercial products and services).')
  if (says(/\bSF[- ]?33\b/i)) add('FULL_PROPOSAL', 'It asks for form SF-33.')
  if (says(/\bSF[- ]?18\b/i)) add('RFQ_QUOTE', 'It asks for form SF-18 (request for quotations).')
  if (type.includes('combined synopsis')) add('COMMERCIAL', 'It is a combined synopsis/solicitation, used for commercial buys (FAR 12.603).')
  if (says(/\b(request for quot(e|ation)s?|RFQ)\b|\bquot(e|ation)s? (are|is|shall be|must be) (due|submitted)/i) || says(/\b(FAR (part )?13|simplified acquisition)\b/i)) add('RFQ_QUOTE', 'It asks for a quote (simplified acquisition).')
  if (says(/\bFAR (part )?12\b|\bcommercial (items?|products?|services?)\b/i)) add('COMMERCIAL', 'It is a commercial buy (FAR Part 12).')
  if (says(/\bFAR (part )?15\b|\b(technical|past performance|price|cost) volume\b/i)) add('FULL_PROPOSAL', 'It asks for separate volumes (FAR Part 15).')
  if (type === 'solicitation' && !found.some((m) => m.key !== 'SOURCES_SOUGHT')) add('FULL_PROPOSAL', 'It is a solicitation: a full proposal answers it.')
  if (type.includes('sources sought') || (type.includes('special notice') && found[0]?.key === 'SOURCES_SOUGHT')) return found.filter((m) => m.key === 'SOURCES_SOUGHT')
  return found
}
export const isTemplateKey = (v: unknown): v is TemplateKey => TEMPLATES.some((t) => t.key === v)

export type DocBlock =
  | { kind: 'heading'; text: string }
  | { kind: 'para'; text: string }
  | { kind: 'facts'; rows: Array<[string, string]> }
  | { kind: 'table'; head: string[]; rows: string[][]; numeric?: number[] }

export interface DocPart {
  key: string
  title: string
  /** Which page limit applies (null: none, e.g. the cover). */
  volume: VolumeKey | null
  blocks: DocBlock[]
}

export interface ProposalDocument {
  template: TemplateInfo
  format: ProposalFormat
  title: string
  parts: DocPart[]
}

export interface DocumentFacts {
  opportunity: { title: string; agency: string; solicitationNumber: string | null; responseDeadline: Date; noticeType: string | null; description?: string | null }
  proposalTitle: string
  company: {
    name: string; uei: string | null; cage: string | null; naicsCodes: string[]; setAsides: string[]
    address: string | null; phone: string | null; email: string | null; website: string | null; contact: string | null
  }
  sections: Array<{ title: string; text: string }>
  requirements: Array<{ text: string; type: string; section: string | null }>
  price: null | {
    scenario: string
    total: number
    /** What the solicitation asks to see (services/priceFormat.ts). */
    format: 'LINE_ITEMS' | 'LABOR_RATES' | 'COST_BREAKDOWN' | 'NONE'
    lineItems: Array<{ item: string; description: string; quantity: number; unit: string; unitPrice: number | null; period: string | null }>
    /** Fully loaded hourly rates (FAR 16.601), from the internal build-up. */
    laborRates: Array<{ category: string; hours: number; rate: number }>
    quote: { validityDays: number | null; promptPayDiscount: string | null }
    /** Null when the person may not see rates (non-admins): only the total is shown. */
    detail: null | {
      labor: Array<{ category: string; hours: number; rate: number; amount: number }>
      other: Array<{ description: string; category: string; quantity: number; unit: number; amount: number }>
      totals: Array<[string, number]>
    }
  }
}

const usd = (n: number) => `$${n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`
const day = (d: Date) => d.toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric', timeZone: 'America/New_York' })
const REQUIRED = (what: string) => `[${what.toUpperCase()} REQUIRED]`
const isPastPerformance = (title: string) => /past performance|experience|references|similar (work|contracts)/i.test(title)

function coverPart(f: DocumentFacts, t: TemplateInfo, kind: string): DocPart {
  const c = f.company
  return {
    key: 'cover', title: kind, volume: null,
    blocks: [
      { kind: 'heading', text: f.proposalTitle },
      { kind: 'facts', rows: [
        ['Submitted to', f.opportunity.agency],
        ['Solicitation', f.opportunity.solicitationNumber ?? REQUIRED('solicitation number')],
        ['Responses due', day(f.opportunity.responseDeadline)],
        ['Submitted by', c.name],
        ['UEI', c.uei ?? REQUIRED('UEI')],
        ['CAGE code', c.cage ?? REQUIRED('CAGE code')],
        ...(c.contact || c.email ? [['Point of contact', [c.contact, c.email, c.phone].filter(Boolean).join(' · ')] as [string, string]] : []),
        ...(t.form ? [['Government form', `${t.form.code} (${t.form.name}): complete and sign it, and put it on top`] as [string, string]] : []),
      ] },
    ],
  }
}

function letterPart(f: DocumentFacts, quote: boolean, gsa = false): DocPart {
  const c = f.company
  const what = quote ? 'quote' : 'proposal'
  return {
    key: 'letter', title: quote ? 'Quote letter' : 'Cover letter', volume: null,
    blocks: [
      { kind: 'para', text: day(new Date()) },
      { kind: 'para', text: `${f.opportunity.agency}\nRe: ${f.opportunity.title}${f.opportunity.solicitationNumber ? ` (${f.opportunity.solicitationNumber})` : ''}` },
      { kind: 'para', text: 'Dear Contracting Officer,' },
      { kind: 'para', text: `${c.name} is pleased to submit this ${what} in response to the solicitation above.${gsa ? ` This quote is offered under our GSA Multiple Award Schedule contract ${REQUIRED('GSA schedule contract number')}.` : ''} It addresses each requirement of the solicitation, and ${quote ? 'the quoted prices remain' : 'our offer remains'} valid for ${f.price?.quote.validityDays ? `${f.price.quote.validityDays} days` : REQUIRED('validity period, e.g. 90 days')}.` },
      { kind: 'para', text: `${c.name} is ${c.setAsides.length ? `a ${c.setAsides.join(', ')}` : 'a business'} registered in SAM.gov (UEI ${c.uei ?? REQUIRED('UEI')}). Please direct questions to ${c.contact ?? REQUIRED('point of contact name')}${c.email ? ` at ${c.email}` : ''}${c.phone ? `, ${c.phone}` : ''}.` },
      { kind: 'para', text: `Sincerely,\n\n${REQUIRED('name and title of the authorized signer')}\n${c.name}` },
    ],
  }
}

function sectionBlocks(sections: DocumentFacts['sections']): DocBlock[] {
  return sections.flatMap((s, i) => [{ kind: 'heading' as const, text: `${i + 1}. ${s.title}` }, { kind: 'para' as const, text: s.text.trim() || REQUIRED(`text for ${s.title}`) }])
}

function pricePart(f: DocumentFacts, title: string, key = 'price'): DocPart {
  const p = f.price
  if (!p) return { key, title, volume: 'price', blocks: [{ kind: 'para', text: `${REQUIRED('price')} No price has been built for this proposal yet.` }] }
  const blocks: DocBlock[] = []
  if (p.format === 'NONE') {
    blocks.push({ kind: 'para', text: 'This solicitation asks for no price.' })
  } else if (p.format === 'LINE_ITEMS') {
    // The schedule of supplies/services, by period, as the solicitation lists it.
    const periods = [...new Set(p.lineItems.map((i) => i.period ?? ''))]
    let grand = 0
    for (const period of periods) {
      const rows = p.lineItems.filter((i) => (i.period ?? '') === period)
      let sub = 0
      const body = rows.map((i) => {
        const amount = i.unitPrice === null ? null : i.unitPrice * i.quantity
        if (amount !== null) sub += amount
        return [i.item, i.description, i.quantity.toLocaleString('en-US'), i.unit, i.unitPrice === null ? REQUIRED('unit price') : usd(i.unitPrice), amount === null ? '—' : usd(amount)]
      })
      grand += sub
      if (period) blocks.push({ kind: 'heading', text: period })
      blocks.push({ kind: 'table', head: ['Item', 'Description', 'Qty', 'Unit', 'Unit price', 'Amount'], numeric: [2, 4, 5], rows: [...body, ['', periods.length > 1 ? `Total, ${period || 'items'}` : 'Total', '', '', '', usd(sub)]] })
    }
    if (!p.lineItems.length) blocks.push({ kind: 'para', text: `${REQUIRED('items to price')} The schedule of items has not been entered yet.` })
    if (periods.length > 1) blocks.push({ kind: 'facts', rows: [['Total, all periods', usd(grand)]] })
  } else if (p.format === 'LABOR_RATES') {
    // Fully loaded hourly rates per labor category (FAR 16.601).
    let total = 0
    const rows = p.laborRates.map((l) => { const amount = l.rate * l.hours; total += amount; return [l.category, usd(l.rate), l.hours.toLocaleString('en-US'), usd(amount)] })
    blocks.push(rows.length
      ? { kind: 'table', head: ['Labor category', 'Fully loaded hourly rate', 'Estimated hours', 'Amount'], numeric: [1, 2, 3], rows: [...rows, ['Total', '', '', usd(total)]] }
      : { kind: 'para', text: `${REQUIRED('labor rates')} No labor categories have been priced yet.` })
    blocks.push({ kind: 'para', text: 'Rates include wages, fringe, overhead, general and administrative expenses, and profit.' })
  } else if (p.detail) {
    if (p.detail.labor.length) blocks.push({ kind: 'table', head: ['Labor category', 'Hours', 'Rate', 'Amount'], numeric: [1, 2, 3], rows: p.detail.labor.map((l) => [l.category, l.hours.toLocaleString('en-US'), usd(l.rate), usd(l.amount)]) })
    if (p.detail.other.length) blocks.push({ kind: 'table', head: ['Other costs', 'Qty', 'Unit', 'Amount'], numeric: [1, 2, 3], rows: p.detail.other.map((o) => [`${o.description} (${o.category.toLowerCase().replace(/_/g, ' ')})`, String(o.quantity), usd(o.unit), usd(o.amount)]) })
    blocks.push({ kind: 'table', head: ['', 'Amount'], numeric: [1], rows: [...p.detail.totals.filter(([, v]) => v !== 0).map(([k, v]) => [k, usd(v)]), ['Total price', usd(p.total)]] })
  } else {
    blocks.push({ kind: 'facts', rows: [['Total price', usd(p.total)]] })
  }
  if (p.format !== 'NONE' && (p.quote.validityDays || p.quote.promptPayDiscount)) {
    blocks.push({ kind: 'facts', rows: [
      ...(p.quote.validityDays ? [['Prices valid for', `${p.quote.validityDays} days`] as [string, string]] : []),
      ...(p.quote.promptPayDiscount ? [['Prompt payment discount', p.quote.promptPayDiscount] as [string, string]] : []),
    ] })
  }
  return { key, title, volume: 'price', blocks }
}

function crossReferencePart(f: DocumentFacts): DocPart | null {
  const rows = f.requirements.filter((r) => ['INSTRUCTION', 'EVALUATION', 'FORMAT', 'SUBMISSION'].includes(r.type) && !/^\s*\[/.test(r.text))
  if (!rows.length) return null
  return {
    key: 'crossref', title: 'Compliance cross-reference', volume: null,
    blocks: [{ kind: 'table', head: ['Solicitation requirement', 'Where it is answered'], rows: rows.slice(0, 80).map((r) => [r.text.length > 240 ? `${r.text.slice(0, 237)}…` : r.text, r.section ?? '—']) }],
  }
}

function capabilityFacts(f: DocumentFacts): DocBlock {
  const c = f.company
  return { kind: 'facts', rows: [
    ['Company', c.name], ['UEI', c.uei ?? REQUIRED('UEI')], ['CAGE code', c.cage ?? REQUIRED('CAGE code')],
    ['NAICS codes', c.naicsCodes.join(', ') || REQUIRED('NAICS codes')], ['Business size and set-asides', c.setAsides.join(', ') || 'Small business status not recorded'],
    ['Address', c.address ?? REQUIRED('address')], ['Contact', [c.contact, c.email, c.phone].filter(Boolean).join(' · ') || REQUIRED('point of contact')],
    ...(c.website ? [['Website', c.website] as [string, string]] : []),
  ] }
}

/** The proposal laid out in a template. Pure: everything comes from `facts`. */
export function layoutProposal(facts: DocumentFacts, templateKey: TemplateKey, format: ProposalFormat): ProposalDocument {
  const t = TEMPLATES.find((x) => x.key === templateKey) ?? TEMPLATES[0]
  const technical = facts.sections.filter((s) => !isPastPerformance(s.title))
  const past = facts.sections.filter((s) => isPastPerformance(s.title))
  const parts: DocPart[] = []
  switch (t.key) {
    case 'FULL_PROPOSAL': {
      parts.push(coverPart(facts, t, 'Cover page'), letterPart(facts, false))
      parts.push({ key: 'technical', title: 'Volume I: Technical', volume: 'technical', blocks: sectionBlocks(technical) })
      parts.push({ key: 'pastPerformance', title: 'Volume II: Past Performance', volume: 'pastPerformance', blocks: past.length ? sectionBlocks(past) : [{ kind: 'para', text: `${REQUIRED('past performance')} Describe up to three similar contracts: customer, contract number, value, dates, work done and a reference contact.` }] })
      parts.push(pricePart(facts, 'Volume III: Price'))
      const xref = crossReferencePart(facts)
      if (xref) parts.push(xref)
      break
    }
    case 'COMMERCIAL':
      parts.push(coverPart(facts, t, 'Cover page'), letterPart(facts, false))
      parts.push({ key: 'technical', title: 'Technical response', volume: 'technical', blocks: sectionBlocks(facts.sections) })
      parts.push(pricePart(facts, 'Price schedule'))
      break
    case 'RFQ_QUOTE':
      parts.push(letterPart(facts, true))
      parts.push(pricePart(facts, 'Price schedule'))
      parts.push({ key: 'technical', title: 'Technical description', volume: 'technical', blocks: sectionBlocks(facts.sections) })
      break
    case 'SOURCES_SOUGHT':
      parts.push({ key: 'capability', title: 'Capability statement', volume: 'capability', blocks: [
        { kind: 'heading', text: `${facts.company.name}: response to ${facts.opportunity.title}` },
        { kind: 'para', text: `Submitted to ${facts.opportunity.agency}${facts.opportunity.solicitationNumber ? ` for notice ${facts.opportunity.solicitationNumber}` : ''}, ${day(new Date())}.` },
        capabilityFacts(facts),
        ...sectionBlocks(facts.sections),
      ] })
      break
    case 'GSA_EBUY':
      parts.push(letterPart(facts, true, true))
      parts.push({ key: 'technical', title: 'Technical response', volume: 'technical', blocks: sectionBlocks(facts.sections) })
      parts.push(pricePart(facts, 'GSA Schedule pricing'))
      break
  }
  return { template: t, format, title: facts.proposalTitle, parts }
}

/** Loads what a proposal document is made from: the opportunity, company, sections, requirements and price. */
export async function loadDocumentFacts(consultingFirmId: string, proposalId: string, opts: { canSeeRates: boolean }): Promise<{ facts: DocumentFacts; savedKey: TemplateKey | null; proposalId: string }> {
  const proposal = await prisma.proposal.findFirst({
    where: { id: proposalId, consultingFirmId },
    select: { id: true, title: true, templateKey: true, opportunityId: true, sections: { where: { isArchived: false }, orderBy: { sortOrder: 'asc' }, select: { title: true, draft: true } } },
  })
  if (!proposal) throw new NotFoundError('Proposal')
  const opp = await prisma.opportunity.findFirstOrThrow({
    where: { id: proposal.opportunityId, consultingFirmId },
    select: { title: true, agency: true, solicitationNumber: true, responseDeadline: true, noticeType: true, description: true },
  })
  // The company that bids: the client a consulting firm scored this for, else the firm's own company.
  const scorecard = await prisma.scorecard.findFirst({ where: { bidPursuit: { consultingFirmId, opportunityId: proposal.opportunityId }, clientCompanyId: { not: null } }, orderBy: { updatedAt: 'desc' }, select: { clientCompanyId: true } })
  const company = await prisma.clientCompany.findFirst({
    where: scorecard?.clientCompanyId ? { id: scorecard.clientCompanyId, consultingFirmId } : { consultingFirmId, isSelf: true },
    select: { name: true, uei: true, cage: true, naicsCodes: true, sdvosb: true, wosb: true, hubzone: true, eightA: true, smallBusiness: true, streetAddress: true, city: true, state: true, zipCode: true, phone: true, email: true, website: true, primaryContactName: true, primaryContactEmail: true },
  })
  const firm = company ? null : await prisma.consultingFirm.findUnique({ where: { id: consultingFirmId }, select: { name: true, contactEmail: true } })
  const matrix = await prisma.complianceMatrix.findFirst({ where: { opportunityId: proposal.opportunityId, consultingFirmId }, select: { id: true } })
  const requirements = matrix ? await prisma.matrixRequirement.findMany({ where: { matrixId: matrix.id, verificationStatus: { not: 'REJECTED' } }, orderBy: { sortOrder: 'asc' }, select: { requirementText: true, sectionType: true, proposalSection: true } }) : []
  const ws = await prisma.pricingWorkspace.findFirst({
    where: { consultingFirmId, opportunityId: proposal.opportunityId, isArchived: false, status: { notIn: ['SUPERSEDED', 'ARCHIVED'] } },
    orderBy: { version: 'desc' },
    select: { preferredScenarioId: true, priceFormat: true, quoteValidityDays: true, promptPayDiscount: true, lineItems: { orderBy: { sortOrder: 'asc' } }, scenarios: { where: { isArchived: false }, orderBy: [{ isPreferred: 'desc' }, { sortOrder: 'asc' }], include: { laborLines: true, otherCosts: true } } },
  })
  const scenario = ws ? ws.scenarios.find((s) => s.id === ws.preferredScenarioId) ?? ws.scenarios[0] ?? null : null
  const n = (v: unknown) => Number(v ?? 0)

  const setAsides = company ? [
    company.smallBusiness && 'small business', company.sdvosb && 'service-disabled veteran-owned small business (SDVOSB)',
    company.wosb && 'woman-owned small business (WOSB)', company.hubzone && 'HUBZone small business', company.eightA && 'SBA 8(a) participant',
  ].filter((x): x is string => !!x) : []
  const address = company && [company.streetAddress, company.city, [company.state, company.zipCode].filter(Boolean).join(' ')].filter(Boolean).join(', ')

  const facts: DocumentFacts = {
    opportunity: { title: opp.title, agency: opp.agency, solicitationNumber: opp.solicitationNumber, responseDeadline: opp.responseDeadline, noticeType: opp.noticeType, description: opp.description },
    proposalTitle: proposal.title,
    company: {
      name: company?.name ?? firm?.name ?? 'Your company',
      uei: company?.uei ?? null, cage: company?.cage ?? null, naicsCodes: company?.naicsCodes ?? [], setAsides,
      address: address || null, phone: company?.phone ?? null, email: company?.primaryContactEmail ?? company?.email ?? firm?.contactEmail ?? null,
      website: company?.website ?? null, contact: company?.primaryContactName ?? null,
    },
    sections: proposal.sections.map((s) => ({ title: s.title, text: s.draft ?? '' })),
    requirements: requirements.map((r) => ({ text: r.requirementText, type: r.sectionType, section: r.proposalSection })),
    price: ws ? {
      scenario: scenario?.name ?? 'Price',
      total: scenario ? n(scenario.totalPrice) : 0,
      // No stored format: a price from before formats, i.e. a cost build-up.
      format: (isPriceFormat(ws.priceFormat) ? ws.priceFormat : 'COST_BREAKDOWN'),
      lineItems: ws.lineItems.map((i) => ({ item: i.itemNumber, description: i.description, quantity: n(i.quantity), unit: i.unit, unitPrice: i.unitPrice === null ? null : n(i.unitPrice), period: i.periodLabel })),
      laborRates: scenario ? scenario.laborLines.map((l) => ({ category: l.categoryName, hours: n(l.hours), rate: Math.round(n(l.baseRate) * wrapFactor(scenario) * 100) / 100 })) : [],
      quote: { validityDays: ws.quoteValidityDays, promptPayDiscount: ws.promptPayDiscount },
      detail: opts.canSeeRates && scenario ? {
        labor: scenario.laborLines.map((l) => ({ category: l.categoryName, hours: n(l.hours), rate: n(l.baseRate), amount: n(l.directLaborAmount) })),
        other: scenario.otherCosts.map((o) => ({ description: o.description, category: o.costCategory, quantity: n(o.quantity), unit: n(o.unitCost), amount: n(o.totalAmount) })),
        totals: [['Direct labor', n(scenario.totalDirectLabor)], ['Fringe', n(scenario.totalFringe)], ['Overhead', n(scenario.totalOverhead)], ['Other direct costs', n(scenario.totalOdc)], ['Subcontractors', n(scenario.totalSubcontractor)], ['G&A', n(scenario.totalGA)], ['Fee', n(scenario.totalFee)]],
      } : null,
    } : null,
  }
  return { facts, savedKey: isTemplateKey(proposal.templateKey) ? proposal.templateKey : null, proposalId: proposal.id }
}

export const matchesFor = (facts: DocumentFacts): TemplateMatch[] => detectTemplates({
  noticeType: facts.opportunity.noticeType,
  texts: [facts.opportunity.title, facts.opportunity.description ?? '', ...facts.requirements.map((r) => r.text)],
})

/**
 * The proposal laid out with the solicitation's format rules. Its template:
 * the one asked for (`opts.template`), else the one chosen and kept on the
 * proposal, else the one the solicitation calls for, else the full proposal.
 */
export async function buildProposalDocument(consultingFirmId: string, proposalId: string, opts: { canSeeRates: boolean; template?: TemplateKey }): Promise<ProposalDocument & { matches: TemplateMatch[]; savedKey: TemplateKey | null }> {
  const { facts, savedKey } = await loadDocumentFacts(consultingFirmId, proposalId, opts)
  const matches = matchesFor(facts)
  const key = opts.template ?? savedKey ?? matches[0]?.key ?? DEFAULT_TEMPLATE
  return { ...layoutProposal(facts, key, readFormat(facts.requirements.map((r) => r.text))), matches, savedKey }
}

export interface LimitCheck { part: string; title: string; pages: number; limit: number | null; over: boolean; source: string | null }

/** Each part's pages against the solicitation's page limits (a whole-proposal limit counts every limited part). */
export function checkPageLimits(doc: ProposalDocument, pageCounts: Record<string, number>): LimitCheck[] {
  const limits = doc.format.pageLimits
  const checks: LimitCheck[] = doc.parts.filter((p) => p.volume).map((p) => {
    const l = limits.find((x) => x.volume === p.volume) ?? null
    const pages = pageCounts[p.key] ?? 0
    return { part: p.key, title: p.title, pages, limit: l?.pages ?? null, over: !!l && pages > l.pages, source: l?.source ?? null }
  })
  const total = limits.find((x) => x.volume === 'total')
  if (total) {
    const pages = doc.parts.filter((p) => p.volume).reduce((n, p) => n + (pageCounts[p.key] ?? 0), 0)
    checks.push({ part: 'total', title: 'Whole proposal', pages, limit: total.pages, over: pages > total.pages, source: total.source })
  }
  return checks
}

