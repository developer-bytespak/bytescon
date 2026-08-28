import { lookupEntityByUEI } from '../samEntityApi'
import type { ContactProvider, ContactRow } from './types'

export const samPocProvider: ContactProvider = {
  key: 'sam_poc',
  label: 'SAM.gov Points of Contact',
  isAvailable() {
    return Boolean(process.env.SAM_API_KEY)
  },
  async fetchContacts({ uei }) {
    const ent = await lookupEntityByUEI(uei)
    if (!ent) return []
    return ent.pocs.map(
      (p): ContactRow => ({
        name: p.name,
        title: p.title,
        email: p.email,
        phone: p.phone,
        source: 'sam.gov',
        role: p.role,
        // SAM.gov POCs are authoritative (government registration) but not
        // deliverability-verified, and may not be the right BD contact for
        // subcontract outreach — so 'probable', never auto-sent (GB-104).
        verificationStatus: p.email ? 'probable' : 'unknown',
      }),
    )
  },
}
