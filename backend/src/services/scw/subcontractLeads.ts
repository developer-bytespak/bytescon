// =============================================================
// Saving scraped subcontracting leads — one copy per firm.
//
// Leads come from public feeds (SUBNet, SAM.gov), so many firms see the same
// lead. Each firm keeps its OWN row, keyed on (consultingFirmId, externalId):
// a re-sync refreshes that firm's copy and never touches another firm's, and
// the firm's own triage (SAVED / DISMISSED) survives every refresh.
// =============================================================
import { prisma } from '../../config/database'
import type { SubnetOpportunity } from '../subnetScraper'

export interface SavedLead {
  id: string
  title: string
  created: boolean
}

export async function saveSyncedLead(consultingFirmId: string, opp: SubnetOpportunity): Promise<SavedLead> {
  const key = { consultingFirmId_externalId: { consultingFirmId, externalId: opp.externalId } }
  const existing = await prisma.subcontractOpportunity.findUnique({ where: key, select: { id: true } })

  const saved = await prisma.subcontractOpportunity.upsert({
    where: key,
    // Refresh only the feed's facts; status and triage fields are the firm's.
    update: {
      title:            opp.title,
      estimatedValue:   opp.estimatedValue ?? undefined,
      responseDeadline: opp.responseDeadline ?? undefined,
      description:      opp.description ?? undefined,
      scrapedAt:        new Date(),
    },
    create: {
      consultingFirmId,
      externalId:         opp.externalId,
      title:              opp.title,
      primeContractor:    opp.primeContractor,
      primeContractorUei: opp.primeContractorUei ?? undefined,
      naicsCode:          opp.naicsCode ?? undefined,
      agency:             opp.agency ?? undefined,
      estimatedValue:     opp.estimatedValue ?? undefined,
      responseDeadline:   opp.responseDeadline ?? undefined,
      description:        opp.description ?? undefined,
      contactEmail:       opp.contactEmail ?? undefined,
      contactName:        opp.contactName ?? undefined,
      sourceUrl:          opp.sourceUrl ?? undefined,
      setAside:           opp.setAside ?? undefined,
      status:             'OPEN',
    },
    select: { id: true, title: true },
  })

  return { ...saved, created: existing === null }
}
