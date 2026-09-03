// =============================================================
// §5.1 Opportunity data-quality badges — source/type/status/amended labelling
// and honest link gating (demo/manual never render a government link).
// =============================================================
import { render, screen, fireEvent } from '@testing-library/react'
import { describe, it, expect, vi } from 'vitest'
import { SourceBadge, StatusBadge, AmendedBadge } from './OpportunityBadges'

describe('SourceBadge', () => {
  it('labels a live SAM.gov record with a clickable external link', () => {
    render(<SourceBadge opp={{ source: 'SAM_GOV', hasValidSourceLink: true, sourceUrl: 'https://sam.gov/opp/x/view' }} />)
    // Rendered as span[role="link"] (a real <a> nested in the row <Link> is
    // invalid DOM); it opens the source via window.open in a new tab.
    const link = screen.getByRole('link', { name: /SAM\.gov/i })
    const openSpy = vi.spyOn(window, 'open').mockImplementation(() => null)
    fireEvent.click(link)
    expect(openSpy).toHaveBeenCalledWith('https://sam.gov/opp/x/view', '_blank', 'noopener,noreferrer')
    openSpy.mockRestore()
  })
  it('labels a demo record DEMO and renders NO link', () => {
    render(<SourceBadge opp={{ source: 'DEMO', isDemo: true, sourceUrl: null }} />)
    expect(screen.getByText('DEMO')).toBeInTheDocument()
    expect(screen.queryByRole('link')).not.toBeInTheDocument()
  })
  it('labels a manual record MANUAL and renders NO link', () => {
    render(<SourceBadge opp={{ source: 'MANUAL' }} />)
    expect(screen.getByText('MANUAL')).toBeInTheDocument()
    expect(screen.queryByRole('link')).not.toBeInTheDocument()
  })
  it('shows an honest "no live link" state when a SAM record lacks a valid link', () => {
    render(<SourceBadge opp={{ source: 'SAM_GOV', hasValidSourceLink: false, sourceUrl: null }} />)
    expect(screen.getByText(/no live link/i)).toBeInTheDocument()
    expect(screen.queryByRole('link')).not.toBeInTheDocument()
  })
})

describe('StatusBadge', () => {
  it('hides for ACTIVE, shows for terminal states', () => {
    const { container, rerender } = render(<StatusBadge status="ACTIVE" />)
    expect(container.textContent).toBe('')
    rerender(<StatusBadge status="CANCELLED" />)
    expect(screen.getByText('CANCELLED')).toBeInTheDocument()
    rerender(<StatusBadge status="ARCHIVED" />)
    expect(screen.getByText('ARCHIVED')).toBeInTheDocument()
  })
})

describe('AmendedBadge', () => {
  it('shows only when amended, with the count', () => {
    const { container, rerender } = render(<AmendedBadge opp={{ isAmended: false }} />)
    expect(container.textContent).toBe('')
    rerender(<AmendedBadge opp={{ isAmended: true, amendmentCount: 3 }} />)
    expect(screen.getByText(/AMENDED ·3/i)).toBeInTheDocument()
  })
})
