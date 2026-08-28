// =============================================================
// Compliance Gate — Layer 1: Hard eligibility filter
// Returns ELIGIBLE / CONDITIONAL / INELIGIBLE
// INELIGIBLE = legally cannot bid (certification mismatch)
// CONDITIONAL = can bid but requires corrective actions
// ELIGIBLE = fully qualified to bid
// =============================================================
import { ComplianceGate, ComplianceGateOutput } from '../types'

interface ClientProfile {
  sdvosb: boolean
  wosb: boolean
  hubzone: boolean
  smallBusiness: boolean
  naicsCodes: string[]
  samRegStatus?: string | null
  samRegExpiry?: Date | null
}

interface OpportunityProfile {
  setAsideType: string
  naicsCode: string
}

export function runComplianceGate(
  client: ClientProfile,
  opportunity: OpportunityProfile
): ComplianceGateOutput {
  const blockers: string[] = []
  const conditions: string[] = []
  const requiredActions: string[] = []

  const sa = (opportunity.setAsideType || 'NONE').toUpperCase().replace(/[-\s]/g, '_')

  // -------------------------------------------------------
  // Hard gates — INELIGIBLE if any trigger
  // -------------------------------------------------------

  if (sa === 'SDVOSB' && !client.sdvosb) {
    blockers.push('SDVOSB set-aside: client lacks SDVOSB certification')
    requiredActions.push('Obtain SDVOSB certification via VA Center for Verification and Evaluation (CVE)')
  }

  if ((sa === 'WOSB' || sa === 'EDWOSB') && !client.wosb) {
    blockers.push(`${sa} set-aside: client lacks WOSB/EDWOSB certification`)
    requiredActions.push('Obtain WOSB certification via SBA WOSB Federal Contract Program')
  }

  if (sa === 'HUBZONE' && !client.hubzone) {
    blockers.push('HUBZone set-aside: client lacks HUBZone certification')
    requiredActions.push('Obtain HUBZone certification via SBA HUBZone Program')
  }

  if (sa === 'SBA_8A' || sa === '8A') {
    blockers.push('8(a) set-aside: requires active SBA 8(a) program participation')
    requiredActions.push('Enroll in SBA 8(a) Business Development program (2-year eligibility window)')
  }

  // NAICS sector-level hard block (completely different industry)
  if (client.naicsCodes.length > 0 && opportunity.naicsCode) {
    const oppSector = opportunity.naicsCode.substring(0, 2)
    const hasSectorMatch = client.naicsCodes.some((c) => c.substring(0, 2) === oppSector)
    if (!hasSectorMatch) {
      blockers.push(
        `NAICS sector mismatch: opportunity is in sector ${oppSector}xx, client has no codes in this sector`
      )
      requiredActions.push('Register applicable NAICS code in SAM.gov profile before bidding')
    }
  }

  // -------------------------------------------------------
  // Soft gates — CONDITIONAL (no hard blockers present)
  // -------------------------------------------------------
  if (blockers.length === 0) {
    const hasExactMatch = client.naicsCodes.some((c) => c.trim() === opportunity.naicsCode.trim())
    const hasSubsectorMatch = client.naicsCodes.some(
      (c) => c.substring(0, 4) === opportunity.naicsCode.substring(0, 4)
    )
    const hasSectorMatch = client.naicsCodes.some(
      (c) => c.substring(0, 2) === opportunity.naicsCode.substring(0, 2)
    )

    if (opportunity.naicsCode && client.naicsCodes.length > 0) {
      if (!hasExactMatch && !hasSubsectorMatch && hasSectorMatch) {
        conditions.push(
          `NAICS subsector gap: client is in sector ${opportunity.naicsCode.substring(0, 2)}xx but not ${opportunity.naicsCode.substring(0, 4)}xx`
        )
        requiredActions.push(`Add ${opportunity.naicsCode} to SAM.gov NAICS registration`)
      } else if (!hasExactMatch && hasSubsectorMatch) {
        conditions.push(
          `NAICS code gap: client has subsector match but not exact code ${opportunity.naicsCode}`
        )
        requiredActions.push(`Verify ${opportunity.naicsCode} applicability and add to SAM.gov profile`)
      }
    }

    if ((sa === 'SMALL_BUSINESS' || sa === 'TOTAL_SMALL_BUSINESS') && !client.smallBusiness) {
      conditions.push('Small business set-aside: client not registered as small business in SAM.gov')
      requiredActions.push('Update size certification in SAM.gov entity registration')
    }

    if (client.samRegStatus && client.samRegStatus.toLowerCase() !== 'active') {
      conditions.push(`SAM.gov registration status: "${client.samRegStatus}" (must be Active to bid)`)
      requiredActions.push('Renew SAM.gov registration immediately')
    }

    if (client.samRegExpiry) {
      const daysToExpiry = (new Date(client.samRegExpiry).getTime() - Date.now()) / 86400000
      if (daysToExpiry < 0) {
        conditions.push('SAM.gov registration is expired')
        requiredActions.push('Renew SAM.gov registration — expired registrations cannot submit proposals')
      } else if (daysToExpiry < 30) {
        conditions.push(`SAM.gov registration expires in ${Math.round(daysToExpiry)} days`)
        requiredActions.push('Renew SAM.gov registration before proposal submission date')
      }
    }
  }

  const gate: ComplianceGate =
    blockers.length > 0 ? 'INELIGIBLE' :
    conditions.length > 0 ? 'CONDITIONAL' :
    'ELIGIBLE'

  return { gate, blockers, conditions, requiredActions }
}
