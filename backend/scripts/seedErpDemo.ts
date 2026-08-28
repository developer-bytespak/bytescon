// =============================================================
// ERP demo data — one contract, told end to end.
//
// Everything below goes in through the REAL API, not straight into the
// database. That matters for a demo: funded totals, billing amounts and
// invoice lines are then produced by the same code the client will be
// clicking through, so the numbers on screen are computed, not typed in.
//
// Re-runnable: it deletes its own contract first and rebuilds from scratch.
//
//   npx tsx scripts/seedErpDemo.ts
// =============================================================
import { prisma } from '../src/config/database'
import jwt from 'jsonwebtoken'

const API = process.env.DEMO_API ?? 'http://localhost:3001/api'
const FIRM = process.env.DEMO_FIRM ?? 'f1471ec1-136f-4b92-a657-25a104f8ec0c'
const CONTRACT_NUMBER = 'DE-AC05-26DEMO'

const day = (n: number) => new Date(Date.now() + n * 86400000)
const iso = (n: number) => day(n).toISOString()

let token = ''

async function call<T = Record<string, unknown>>(
  method: 'GET' | 'POST' | 'PUT',
  path: string,
  body?: unknown,
): Promise<T> {
  const res = await fetch(`${API}${path}`, {
    method,
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
    body: body === undefined ? undefined : JSON.stringify(body),
  })
  const payload = await res.json().catch(() => ({}))
  if (!res.ok || payload?.success === false) {
    throw new Error(`${method} ${path} → ${res.status} ${payload?.error ?? JSON.stringify(payload).slice(0, 200)}`)
  }
  return payload.data as T
}

async function main() {
  const admin = await prisma.user.findFirst({
    where: { consultingFirmId: FIRM, role: 'ADMIN' },
    select: { id: true, email: true },
  })
  if (!admin) throw new Error('No ADMIN user in that firm')

  const secret = process.env.JWT_SECRET
  if (!secret) throw new Error('JWT_SECRET is required — pass the same value the API container uses')
  token = jwt.sign(
    { userId: admin.id, email: admin.email, role: 'ADMIN', consultingFirmId: FIRM },
    secret,
    { expiresIn: '1h' },
  )

  // ---- Start clean so the demo is identical every time --------------------
  const existing = await prisma.contract.findFirst({
    where: { consultingFirmId: FIRM, contractNumber: CONTRACT_NUMBER },
    select: { id: true },
  })
  if (existing) {
    await prisma.contract.delete({ where: { id: existing.id } })
    console.log('· removed the previous demo contract')
  }

  // ---- The contract -------------------------------------------------------
  const contract = await call<{ id: string }>('POST', '/contract-management', {
    contractNumber: CONTRACT_NUMBER,
    title: 'Enterprise Cybersecurity Support Services',
    agency: 'Department of Energy',
    contractingOffice: 'EM Consolidated Business Center',
    contractType: 'T_AND_M',
    awardValue: 2400000,
    ceilingValue: 2400000,
    startDate: iso(-120),
    endDate: iso(245),
    status: 'ACTIVE',
    customerContactName: 'Marcus Webb',
    customerContactEmail: 'marcus.webb@doe.example.gov',
    description: 'Tier-2 SOC monitoring, vulnerability management and incident response for the DOE enterprise.',
  })
  const CT = contract.id
  console.log(`· contract ${CONTRACT_NUMBER}`)

  // ---- CLIN structure, including the task-order tier -----------------------
  const clin = async (body: Record<string, unknown>) =>
    (await call<{ id: string }>('POST', `/contract-management/${CT}/clins`, body)).id

  const taskOrder = await clin({
    clinNumber: 'TO-001', title: 'Year 1 operations', clinLevel: 'TASK_ORDER',
    fundedAmount: 1500000, ceilingAmount: 2040000, startDate: iso(-120), endDate: iso(245),
  })
  const clinSoc = await clin({
    clinNumber: '0001', title: 'Tier-2 SOC monitoring', clinType: 'T_AND_M', clinLevel: 'CLIN',
    parentClinId: taskOrder, fundedAmount: 900000, ceilingAmount: 1200000,
  })
  const clinVuln = await clin({
    clinNumber: '0002', title: 'Vulnerability management', clinType: 'FFP', clinLevel: 'CLIN',
    parentClinId: taskOrder, fundedAmount: 360000, ceilingAmount: 480000,
  })
  const clinIr = await clin({
    clinNumber: '0003', title: 'Incident response retainer', clinType: 'FFP', clinLevel: 'CLIN',
    parentClinId: taskOrder, fundedAmount: 240000, ceilingAmount: 360000,
  })
  const clinOdc = await clin({
    clinNumber: '0004', title: 'Travel and other direct costs', clinType: 'COST_REIMBURSEMENT',
    fundedAmount: 60000, ceilingAmount: 120000,
  })
  console.log('· 1 task order, 4 CLINs')

  // ---- Funding: obligated in increments, as a real contract is -------------
  await call('POST', `/contract-finance/${CT}/funding`, {
    type: 'INITIAL_OBLIGATION', amount: 900000, clinId: clinSoc,
    effectiveDate: iso(-118), referenceNumber: 'MOD-P00001',
    description: 'Initial obligation at award',
  })
  await call('POST', `/contract-finance/${CT}/funding`, {
    type: 'INCREMENTAL_FUNDING', amount: 360000, clinId: clinVuln,
    effectiveDate: iso(-75), referenceNumber: 'MOD-P00002',
    description: 'Incremental funding — vulnerability management',
  })
  await call('POST', `/contract-finance/${CT}/funding`, {
    type: 'INCREMENTAL_FUNDING', amount: 240000, clinId: clinIr,
    effectiveDate: iso(-40), referenceNumber: 'MOD-P00003',
    description: 'Incremental funding — IR retainer',
  })
  await call('POST', `/contract-finance/${CT}/funding`, {
    type: 'INCREMENTAL_FUNDING', amount: 60000, clinId: clinOdc,
    effectiveDate: iso(-40), referenceNumber: 'MOD-P00003',
    description: 'Incremental funding — travel and ODC',
  })
  console.log('· funding $1,560,000 of a $2,400,000 ceiling')

  // ---- Labour rates. Time is costed from these, never typed in. ------------
  const RATES = [
    { categoryName: 'Program Manager', categoryCode: 'PM-01', billingRate: 212.5, costRate: 141.0 },
    { categoryName: 'Senior Security Engineer', categoryCode: 'SSE-03', billingRate: 185.0, costRate: 118.75 },
    { categoryName: 'SOC Analyst II', categoryCode: 'SOC-02', billingRate: 124.0, costRate: 78.5 },
    { categoryName: 'Vulnerability Analyst', categoryCode: 'VUL-02', billingRate: 138.0, costRate: 88.25 },
  ]
  for (const r of RATES) {
    await call('POST', `/contract-finance/${CT}/rates`, {
      ...r, rateType: 'BILLING', effectiveStart: iso(-120), effectiveEnd: iso(245),
    })
  }
  console.log('· 4 labour categories with billing and cost rates')

  // ---- Budget: the plan the actuals get compared against -------------------
  await call('POST', '/erp/budgets', {
    contractId: CT,
    title: 'Year 1 approved budget',
    effectiveDate: iso(-115),
    notes: 'Baseline approved at award. Variance is measured against this.',
    lines: [
      { clinId: clinSoc, category: 'LABOR', description: 'SOC monitoring labour', plannedAmount: 780000 },
      { clinId: clinVuln, category: 'LABOR', description: 'Vulnerability management labour', plannedAmount: 300000 },
      { clinId: clinIr, category: 'LABOR', description: 'IR retainer labour', plannedAmount: 190000 },
      { clinId: clinSoc, category: 'SUBCONTRACT', description: 'Subcontracted after-hours coverage', plannedAmount: 180000 },
      { clinId: clinOdc, category: 'TRAVEL', description: 'On-site incident travel', plannedAmount: 42000 },
      { clinId: clinOdc, category: 'MATERIAL', description: 'Tooling and licences', plannedAmount: 36000 },
    ],
  })
  const budgets = await call<Array<{ id: string }>>('GET', `/erp/contracts/${CT}/budgets`)
  await call('POST', `/erp/budgets/${budgets[0].id}/activate`, {})
  console.log('· budget approved and activated')

  // ---- Time. Submitted and approved so it becomes billable. ---------------
  const TIME = [
    { laborCategory: 'Senior Security Engineer', clinId: clinSoc, hours: 8, day: -46, description: 'Alert triage and escalation review' },
    { laborCategory: 'Senior Security Engineer', clinId: clinSoc, hours: 7.5, day: -45, description: 'Detection tuning' },
    { laborCategory: 'SOC Analyst II', clinId: clinSoc, hours: 8, day: -45, description: 'Tier-2 queue' },
    { laborCategory: 'SOC Analyst II', clinId: clinSoc, hours: 8, day: -44, description: 'Tier-2 queue' },
    { laborCategory: 'Vulnerability Analyst', clinId: clinVuln, hours: 6.5, day: -44, description: 'Authenticated scan of the enclave' },
    { laborCategory: 'Vulnerability Analyst', clinId: clinVuln, hours: 8, day: -43, description: 'Remediation ranking' },
    { laborCategory: 'Program Manager', clinId: clinSoc, hours: 4, day: -43, description: 'Monthly programme review with the COR' },
    { laborCategory: 'Senior Security Engineer', clinId: clinIr, hours: 5.5, day: -42, description: 'Tabletop exercise facilitation' },
  ]
  for (const t of TIME) {
    const entry = await call<{ id: string }>('POST', `/contract-finance/${CT}/time`, {
      laborCategory: t.laborCategory, clinId: t.clinId, hours: t.hours,
      workDate: iso(t.day), description: t.description,
    })
    await call('POST', `/contract-finance/time/${entry.id}/submit`)
    await call('POST', `/contract-finance/time/${entry.id}/approve`)
  }

  // A pending entry, so the demo has something waiting on a decision.
  const pending = await call<{ id: string }>('POST', `/contract-finance/${CT}/time`, {
    laborCategory: 'SOC Analyst II', clinId: clinSoc, hours: 8,
    workDate: iso(-3), description: 'Tier-2 queue — awaiting approval',
  })
  await call('POST', `/contract-finance/time/${pending.id}/submit`)
  console.log('· 8 approved timesheets, 1 waiting for approval')

  // ---- Direct costs -------------------------------------------------------
  const COSTS = [
    { category: 'TRAVEL', clinId: clinOdc, amount: 1842.5, day: -44, description: 'On-site incident support — Oak Ridge' },
    { category: 'MATERIAL', clinId: clinOdc, amount: 3200, day: -43, description: 'Threat intelligence feed — quarterly' },
    { category: 'OTHER_DIRECT_COST', clinId: clinVuln, amount: 950, day: -42, description: 'Scanner licence top-up' },
  ]
  for (const c of COSTS) {
    const cost = await call<{ id: string }>('POST', `/contract-finance/${CT}/costs`, {
      category: c.category, clinId: c.clinId, amount: c.amount,
      incurredDate: iso(c.day), description: c.description,
    })
    await call('POST', `/contract-finance/costs/${cost.id}/submit`)
    await call('POST', `/contract-finance/costs/${cost.id}/approve`)
  }
  const unapproved = await call<{ id: string }>('POST', `/contract-finance/${CT}/costs`, {
    category: 'TRAVEL', clinId: clinOdc, amount: 720.4,
    incurredDate: iso(-5), description: 'Site visit — awaiting approval',
  })
  await call('POST', `/contract-finance/costs/${unapproved.id}/submit`)
  console.log('· 3 approved costs, 1 waiting for approval')

  // ---- Who is on this contract -------------------------------------------
  const staff = await prisma.user.findMany({
    where: { consultingFirmId: FIRM, isActive: true },
    select: { id: true }, take: 3,
  })
  const ALLOC = [
    { laborCategory: 'Senior Security Engineer', allocationPercent: 60, plannedHoursPerWeek: 24, clinId: clinSoc },
    { laborCategory: 'SOC Analyst II', allocationPercent: 80, plannedHoursPerWeek: 32, clinId: clinSoc },
    { laborCategory: 'Program Manager', allocationPercent: 25, plannedHoursPerWeek: 10, clinId: null },
  ]
  for (let i = 0; i < staff.length && i < ALLOC.length; i++) {
    await call('POST', '/erp/resource-allocations', {
      userId: staff[i].id, contractId: CT, status: 'ACTIVE',
      startDate: iso(-120), endDate: iso(245), ...ALLOC[i],
    })
  }
  console.log(`· ${Math.min(staff.length, ALLOC.length)} people allocated`)

  // ---- Subcontract to a partner -------------------------------------------
  const partner = await prisma.partner.findFirst({
    where: { consultingFirmId: FIRM, isActive: true },
    select: { id: true, name: true },
  })
  if (partner) {
    const po = await call<{ id: string }>('POST', '/erp/purchase-orders', {
      contractId: CT, clinId: clinSoc, partnerId: partner.id, vendorName: partner.name,
      poNumber: 'PO-2026-0041', isSubcontract: true, ceilingAmount: 180000,
      startDate: iso(-100), endDate: iso(245),
      description: 'After-hours SOC coverage, 18:00–06:00 ET',
      lines: [
        { clinId: clinSoc, category: 'SUBCONTRACT', description: 'After-hours SOC analyst', quantity: 1200, unit: 'hour', unitPrice: 115, amount: 138000 },
        { clinId: clinSoc, category: 'SUBCONTRACT', description: 'Weekend escalation coverage', amount: 30000 },
        { clinId: clinOdc, category: 'TRAVEL', description: 'Travel for on-site surge', amount: 12000 },
      ],
    })
    await call('POST', `/erp/purchase-orders/${po.id}/transition`, { status: 'PENDING_APPROVAL' })
    await call('POST', `/erp/purchase-orders/${po.id}/transition`, { status: 'APPROVED', reason: 'Subcontract executed' })

    const SUB_INVOICES = [
      { invoiceNumber: 'SUB-2026-06', amount: 18400, day: -70, approve: true, pay: true },
      { invoiceNumber: 'SUB-2026-07', amount: 21150, day: -40, approve: true, pay: false },
      { invoiceNumber: 'SUB-2026-08', amount: 16720, day: -8, approve: false, pay: false },
    ]
    for (const si of SUB_INVOICES) {
      const inv = await call<{ id: string }>('POST', '/erp/subcontract-invoices', {
        purchaseOrderId: po.id, invoiceNumber: si.invoiceNumber, amount: si.amount,
        invoiceDate: iso(si.day), servicePeriodStart: iso(si.day - 30), servicePeriodEnd: iso(si.day),
        lines: [{ clinId: clinSoc, category: 'SUBCONTRACT', description: 'After-hours SOC coverage', amount: si.amount }],
      })
      if (si.approve) {
        await call('POST', `/erp/subcontract-invoices/${inv.id}/transition`, { status: 'APPROVED' })
      }
      if (si.pay) {
        await call('POST', `/erp/subcontract-invoices/${inv.id}/transition`, {
          status: 'PAID', paymentReference: 'ACH-88412',
        })
      }
    }

    const FLOW_DOWNS = [
      { clauseNumber: '52.204-21', clauseTitle: 'Basic Safeguarding of Covered Contractor Information Systems', state: 'APPLICABLE_CONFIRMED', evidence: 'Subcontractor stores covered contract information. Flows down in full.' },
      { clauseNumber: '252.204-7012', clauseTitle: 'Safeguarding Covered Defense Information and Cyber Incident Reporting', state: 'INCLUDED', evidence: 'Included at Article 14. 72-hour reporting applies to the subcontractor directly.' },
      { clauseNumber: '52.222-50', clauseTitle: 'Combating Trafficking in Persons', state: 'APPLICABLE_CONFIRMED', evidence: 'Mandatory flow-down at any tier.' },
      { clauseNumber: '52.219-8', clauseTitle: 'Utilization of Small Business Concerns', state: 'REVIEW_REQUIRED', evidence: 'Subcontract value is above threshold. Awaiting counsel review.' },
    ]
    for (const fd of FLOW_DOWNS) {
      await call('POST', '/erp/flow-downs', { purchaseOrderId: po.id, ...fd })
    }
    console.log(`· subcontract PO-2026-0041 to ${partner.name}: 3 invoices, 4 flow-downs`)
  } else {
    console.log('· no partner in this firm — subcontract section skipped')
  }

  // ---- Deliverables -------------------------------------------------------
  // Status is workflow-guarded, so each deliverable is walked through the real
  // transitions rather than having a final status written onto it. `PUT` does
  // not accept `status` at all — a seed that set it there would look like it
  // worked and quietly leave every row NOT_STARTED.
  const DELIVERABLES: Array<{ name: string; cdrlNumber: string; path: string[]; dueDate: string }> = [
    { name: 'Monthly SOC activity report — June', cdrlNumber: 'A001', path: ['SUBMITTED', 'ACCEPTED'], dueDate: iso(-60) },
    { name: 'Monthly SOC activity report — July', cdrlNumber: 'A002', path: ['SUBMITTED', 'ACCEPTED'], dueDate: iso(-30) },
    { name: 'Q3 vulnerability scan results', cdrlNumber: 'A003', path: ['IN_PROGRESS', 'SUBMITTED'], dueDate: iso(-4) },
    { name: 'Incident response tabletop after-action', cdrlNumber: 'A004', path: ['IN_PROGRESS'], dueDate: iso(12) },
    { name: 'Annual security control assessment', cdrlNumber: 'A005', path: [], dueDate: iso(60) },
  ]
  for (const d of DELIVERABLES) {
    const row = await call<{ id: string }>('POST', `/contract-management/${CT}/deliverables`, {
      name: d.name, cdrlNumber: d.cdrlNumber, dueDate: d.dueDate,
      clinId: d.cdrlNumber === 'A003' ? clinVuln : clinSoc,
      deliverableType: 'REPORT', frequency: 'MONTHLY',
      // One deliverable belongs to the subcontractor, so partner performance
      // has something real to count.
      ...(d.cdrlNumber === 'A004' && partner ? { partnerId: partner.id } : {}),
    })
    for (const status of d.path) {
      await call('POST', `/contract-management/deliverables/${row.id}/transition`, { status })
    }
  }
  console.log('· 5 deliverables walked through the real workflow')

  // ---- Invoice the government, from the approved records ------------------
  const invoice = await call<{ id: string; invoiceNumber: string; total: string; lineItems: unknown[] }>(
    'POST', `/contract-finance/${CT}/invoices`,
    { dueDate: iso(18), invoiceDate: iso(-12), customerName: 'Department of Energy', feeAmount: 4200 },
  )
  await call('POST', `/contract-finance/invoices/${invoice.id}/approve`)
  await call('POST', `/contract-finance/invoices/${invoice.id}/submit`, { reference: 'IPP-2026-0088' })
  await call('POST', `/contract-finance/invoices/${invoice.id}/payments`, {
    amount: 8000, reference: 'ACH-70221', receivedDate: iso(-2),
  })
  console.log(`· invoice ${invoice.invoiceNumber} for $${invoice.total} — ${invoice.lineItems.length} lines, partially paid`)

  const summary = await call<Record<string, unknown>>('GET', `/contract-finance/${CT}/summary`)
  console.log('\nDemo contract ready.')
  console.log(`  /contracts/${CT}`)
  console.log(`  funded ${summary.funded} · expended ${summary.expended} · remaining ${summary.remainingFunded}`)
}

main()
  .catch((err) => { console.error('\nSeed failed:', err instanceof Error ? err.message : err); process.exitCode = 1 })
  .finally(() => prisma.$disconnect())
