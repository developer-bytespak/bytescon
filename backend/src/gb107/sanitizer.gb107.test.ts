import { describe, it, expect } from 'vitest'
import { sanitizeDescriptionHtml, htmlToPlainText, decodeEntities } from './sanitizer.gb107'

describe('GB-107 sanitizer', () => {
  it('strips scripts, iframes, and event handlers from stored HTML', () => {
    const dirty =
      '<p onclick="steal()">Requirements</p><script>alert(1)</script>' +
      '<iframe src="https://evil.example"></iframe><a href="javascript:bad()">link</a>'
    const clean = sanitizeDescriptionHtml(dirty)
    expect(clean).toContain('<p>Requirements</p>')
    expect(clean).not.toContain('script')
    expect(clean).not.toContain('iframe')
    expect(clean).not.toContain('onclick')
    expect(clean).not.toContain('javascript:')
  })

  it('keeps safe structural tags and http(s) links', () => {
    const html = '<h2>Scope</h2><ul><li>Item one</li></ul><a href="https://sam.gov/x">SAM</a>'
    const clean = sanitizeDescriptionHtml(html)
    expect(clean).toContain('<h2>Scope</h2>')
    expect(clean).toContain('<li>Item one</li>')
    expect(clean).toContain('href="https://sam.gov/x"')
  })

  it('converts HTML to plain text with paragraph breaks preserved', () => {
    const html = '<p>First paragraph.</p><p>Second paragraph.</p><br>Third line.'
    const text = htmlToPlainText(html)
    expect(text).toContain('First paragraph.')
    expect(text).toContain('Second paragraph.')
    expect(text.split('\n').filter(Boolean).length).toBeGreaterThanOrEqual(3)
  })

  it('decodes named, decimal, and hex entities in extracted text', () => {
    expect(decodeEntities('Q&amp;A &sect; 52 &#8212; done &#x27;quoted&#x27;')).toBe(
      "Q&A § 52 — done 'quoted'",
    )
  })

  it('decodes entities produced by the strip pass', () => {
    const html = '<p>Terms &amp; Conditions &mdash; FAR 52.212&#8209;1</p>'
    const text = htmlToPlainText(html)
    expect(text).toContain('Terms & Conditions')
  })

  it('collapses runs of whitespace but keeps content intact', () => {
    const html = '<div>lots     of\t\tspaces</div>'
    expect(htmlToPlainText(html)).toBe('lots of spaces')
  })
})
