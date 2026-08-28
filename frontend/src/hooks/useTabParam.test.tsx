// =============================================================
// The active tab lives in the URL, so a refresh returns to the tab the person
// was on. These assert the two failure modes that made the bug: a tab click
// that never reaches the URL, and a URL value that never reaches the render.
// =============================================================
import { render, screen, fireEvent } from '@testing-library/react'
import { MemoryRouter, useLocation } from 'react-router-dom'
import { describe, it, expect } from 'vitest'
import { useTabParam } from './useTabParam'

const KEYS = ['agencies', 'contacts', 'activities'] as const

function Harness() {
  const [tab, setTab] = useTabParam(KEYS, 'agencies')
  const { search } = useLocation()
  return (
    <div>
      <span data-testid="active">{tab}</span>
      <span data-testid="search">{search}</span>
      {KEYS.map((k) => (
        <button key={k} onClick={() => setTab(k)}>{k}</button>
      ))}
    </div>
  )
}

const renderAt = (url: string) =>
  render(<MemoryRouter initialEntries={[url]}><Harness /></MemoryRouter>)

describe('useTabParam', () => {
  it('falls back when the URL names no tab', () => {
    renderAt('/crm')
    expect(screen.getByTestId('active')).toHaveTextContent('agencies')
  })

  it('restores the tab the URL names — this is what survives a refresh', () => {
    renderAt('/crm?tab=activities')
    expect(screen.getByTestId('active')).toHaveTextContent('activities')
  })

  it('writes the tab into the URL when one is clicked', () => {
    renderAt('/crm')
    fireEvent.click(screen.getByRole('button', { name: 'contacts' }))
    expect(screen.getByTestId('active')).toHaveTextContent('contacts')
    expect(screen.getByTestId('search')).toHaveTextContent('tab=contacts')
  })

  it('falls back rather than rendering nothing for an unknown tab', () => {
    renderAt('/crm?tab=nonsense')
    expect(screen.getByTestId('active')).toHaveTextContent('agencies')
  })

  it('keeps other query params intact', () => {
    renderAt('/crm?agency=Energy&tab=contacts')
    fireEvent.click(screen.getByRole('button', { name: 'activities' }))
    const search = screen.getByTestId('search').textContent ?? ''
    expect(search).toContain('agency=Energy')
    expect(search).toContain('tab=activities')
  })
})
