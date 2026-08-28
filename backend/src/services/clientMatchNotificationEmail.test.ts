import { describe, it, expect } from 'vitest'
import {
  renderClientMatchEmail,
  buildUnsubscribeUrl,
  CAN_SPAM_POSTAL_ADDRESS,
  MatchEmailItem,
} from './clientMatchNotificationEmail'

const item = (overrides: Partial<MatchEmailItem> = {}): MatchEmailItem => ({
  opportunityId: 'opp-1',
  title: 'IT Modernization Services',
  agency: 'Department of Defense',
  matchScore: 82,
  estimatedValueDisplay: '$1.2M',
  daysToDeadline: 21,
  matchReasons: ['Strong NAICS alignment'],
  url: 'https://sam.gov/opp/abc/view',
  ...overrides,
})

const base = {
  firmDisplayName: 'Bytes Platform',
  firmTagline: 'Federal Contracting Intelligence',
  isVeteranOwned: true,
  accentColor: '#C9A227',
  clientId: 'client-123',
  clientName: 'Apex Federal',
  appUrl: 'https://app.example.test',
}

describe('renderClientMatchEmail — CAN-SPAM compliance', () => {
  it('footer contains the exact registered postal address', () => {
    const { html, text } = renderClientMatchEmail({ ...base, matches: [item()] })
    expect(CAN_SPAM_POSTAL_ADDRESS).toBe('1 Central Ave NW, Albuquerque, NM 87102')
    expect(html).toContain('1 Central Ave NW, Albuquerque, NM 87102')
    expect(text).toContain('1 Central Ave NW, Albuquerque, NM 87102')
  })

  it('includes a clear sender identity in the footer', () => {
    const { html } = renderClientMatchEmail({ ...base, matches: [item()] })
    expect(html).toContain('Bytes Platform')
  })

  it('includes a functioning unsubscribe / preference link tied to the client', () => {
    const rendered = renderClientMatchEmail({ ...base, matches: [item()] })
    const expectedUrl = buildUnsubscribeUrl(base.appUrl, base.clientId)
    expect(rendered.unsubscribeUrl).toBe(expectedUrl)
    // Link is a well-formed absolute URL pointing at the prefs page.
    const parsed = new URL(rendered.unsubscribeUrl)
    expect(parsed.protocol).toMatch(/^https?:$/)
    expect(parsed.searchParams.get('client')).toBe(base.clientId)
    // And it is actually rendered as an anchor in the HTML.
    expect(rendered.html).toContain(`href="${expectedUrl}"`)
    expect(rendered.html.toLowerCase()).toContain('unsubscribe')
    expect(rendered.text).toContain(expectedUrl)
  })
})

describe('renderClientMatchEmail — content modes', () => {
  it('single match renders an immediate-style subject with the title', () => {
    const { subject } = renderClientMatchEmail({ ...base, matches: [item({ title: 'Cyber Range Ops' })] })
    expect(subject).toContain('Cyber Range Ops')
    expect(subject).toContain('82%')
  })

  it('digest mode aggregates multiple matches into a single message', () => {
    const { subject, html } = renderClientMatchEmail({
      ...base,
      matches: [
        item({ opportunityId: 'o1', title: 'Alpha Program' }),
        item({ opportunityId: 'o2', title: 'Bravo Program' }),
        item({ opportunityId: 'o3', title: 'Charlie Program' }),
      ],
    })
    expect(subject).toContain('3')
    expect(subject).toContain('Apex Federal')
    expect(html).toContain('Alpha Program')
    expect(html).toContain('Bravo Program')
    expect(html).toContain('Charlie Program')
  })

  it('escapes HTML in untrusted fields', () => {
    const { html } = renderClientMatchEmail({
      ...base,
      clientName: '<script>x</script>',
      matches: [item({ title: 'A & B <b>opp</b>' })],
    })
    expect(html).not.toContain('<script>x</script>')
    expect(html).toContain('&amp; B')
  })
})
