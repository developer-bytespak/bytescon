import { describe, it, expect } from 'vitest'
import { isDescriptionLink, samAttachments, samContacts, samNoticeDetails } from './samNoticeDetails'

describe('samNoticeDetails', () => {
  it('never passes SAM.gov\'s description link off as the description', () => {
    const link = 'https://api.sam.gov/prod/opportunities/v1/noticedesc?noticeid=abc123'
    expect(isDescriptionLink(link)).toBe(true)
    expect(samNoticeDetails({ description: link, pointOfContact: null, resourceLinks: null })).toMatchObject({ description: null, descriptionPending: true })
    const text = 'Replace the roof of building 12. See https://example.gov for site access.'
    expect(samNoticeDetails({ description: text, pointOfContact: null, resourceLinks: null })).toMatchObject({ description: text, descriptionPending: false })
  })

  it('puts the primary contact first and fills the contact fields from it', () => {
    const contacts = [
      { type: 'secondary', fullName: 'Sam Second', email: 'sam@agency.test' },
      { type: 'primary', fullName: 'Pat Officer', title: 'Contracting Officer', email: 'pat@agency.test', phone: '2145550100' },
      { type: 'primary', fullName: '', email: '', phone: '' },
    ]
    expect(samContacts(contacts).map((c) => c.name)).toEqual(['Pat Officer', 'Sam Second'])
    expect(samNoticeDetails({ description: null, pointOfContact: contacts, resourceLinks: null })).toMatchObject({ pocName: 'Pat Officer', pocTitle: 'Contracting Officer', pocEmail: 'pat@agency.test', pocPhone: '2145550100' })
  })

  it('lists attachments as numbered https links without any api_key', () => {
    const atts = samAttachments([
      'https://sam.gov/api/prod/opps/v3/opportunities/resources/files/f1/download?api_key=SECRET&token=',
      'http://insecure.test/file',
      42,
      'https://sam.gov/api/prod/opps/v3/opportunities/resources/files/f2/download',
    ])
    expect(atts.map((a) => a.label)).toEqual(['Attachment 1', 'Attachment 2'])
    expect(atts[0].url).not.toMatch(/api_key/)
    expect(atts[0].url).toMatch(/files\/f1\/download/)
  })
})

describe('descriptionFetchState', () => {
  const link = 'https://api.sam.gov/prod/opportunities/v1/noticedesc?noticeid=abc'
  it('says fetching while queued or untried, unavailable when SAM had none, failed or there is no key', async () => {
    const { descriptionFetchState } = await import('./samNoticeDetails')
    expect(descriptionFetchState({ description: link, descriptionEnrichmentStatus: null })).toBe('fetching')
    expect(descriptionFetchState({ description: link, descriptionEnrichmentStatus: 'QUEUED' })).toBe('fetching')
    expect(descriptionFetchState({ description: link, descriptionEnrichmentStatus: 'NOT_FOUND' })).toBe('unavailable')
    expect(descriptionFetchState({ description: link, descriptionEnrichmentStatus: 'FAILED' })).toBe('unavailable')
    expect(descriptionFetchState({ description: link, descriptionEnrichmentStatus: null }, false)).toBe('unavailable')
    expect(descriptionFetchState({ description: 'Real text.', descriptionEnrichmentStatus: null })).toBeNull()
  })
})
