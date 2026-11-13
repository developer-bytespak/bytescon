// =============================================================
// What the opportunity page shows from a SAM.gov notice, beyond its columns.
//
// SAM.gov's search result gives the description only as a link to its
// `noticedesc` endpoint (the text is fetched later, services/gb107), plus the
// notice's contacts and attachment links. This turns them into what a person
// reads: the primary contact, the attachments, and the description only when
// it is real text. Pure.
// =============================================================

export interface SamContact { name: string | null; title: string | null; email: string | null; phone: string | null; type: string | null }
export interface SamAttachment { url: string; label: string }

/** A description that is only SAM.gov's link to the text, not the text. */
export function isDescriptionLink(description: string | null | undefined): boolean {
  const d = (description ?? '').trim()
  return /^https?:\/\/\S+$/.test(d)
}

const str = (v: unknown): string | null => (typeof v === 'string' && v.trim() ? v.trim() : null)

export function samContacts(pointOfContact: unknown): SamContact[] {
  if (!Array.isArray(pointOfContact)) return []
  return pointOfContact
    .map((c) => (c && typeof c === 'object' ? c as Record<string, unknown> : {}))
    .map((c) => ({ name: str(c.fullName), title: str(c.title), email: str(c.email), phone: str(c.phone), type: str(c.type) }))
    .filter((c) => c.name || c.email || c.phone)
    // Primary first.
    .sort((a, b) => Number(b.type === 'primary') - Number(a.type === 'primary'))
}

/** Attachment links, with any api_key the feed put in them removed. */
export function samAttachments(resourceLinks: unknown): SamAttachment[] {
  if (!Array.isArray(resourceLinks)) return []
  return resourceLinks
    .filter((u): u is string => typeof u === 'string' && /^https:\/\//.test(u))
    .map((u, i) => {
      let url = u
      try {
        const parsed = new URL(u)
        parsed.searchParams.delete('api_key')
        url = parsed.toString()
      } catch { /* keep as given */ }
      return { url, label: `Attachment ${i + 1}` }
    })
}

/** The extra fields the opportunity page reads. */
export function samNoticeDetails(o: { description: string | null; pointOfContact: unknown; resourceLinks: unknown }) {
  const contacts = samContacts(o.pointOfContact)
  const primary = contacts[0]
  const linkOnly = isDescriptionLink(o.description)
  return {
    // Never show SAM.gov's raw link as if it were the description.
    description: linkOnly ? null : o.description,
    descriptionPending: linkOnly,
    pocName: primary?.name ?? null,
    pocTitle: primary?.title ?? null,
    pocEmail: primary?.email ?? null,
    pocPhone: primary?.phone ?? null,
    contacts,
    attachments: samAttachments(o.resourceLinks),
  }
}
