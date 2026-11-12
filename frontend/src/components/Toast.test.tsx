// Toasts can carry a second line and a link to where the next step is done.
import { render, screen, fireEvent } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import { describe, it, expect } from 'vitest'
import { ToastProvider, useToast } from './Toast'

function Trigger({ withAction }: { withAction: boolean }) {
  const { toast } = useToast()
  return (
    <button type="button" onClick={() => toast('Proposal started.', 'success', withAction
      ? { detail: 'Now: Proposal. Next: Outline the proposal.', action: { label: 'Open the proposal workspace', to: '/opportunities/o1/proposal' } }
      : undefined)}>go</button>
  )
}

const renderToast = (withAction: boolean) => render(<MemoryRouter><ToastProvider><Trigger withAction={withAction} /></ToastProvider></MemoryRouter>)

describe('Toast', () => {
  it('shows the next step and a link to where it is done', () => {
    renderToast(true)
    fireEvent.click(screen.getByRole('button', { name: 'go' }))
    expect(screen.getByText('Proposal started.')).toBeInTheDocument()
    expect(screen.getByText('Now: Proposal. Next: Outline the proposal.')).toBeInTheDocument()
    expect(screen.getByRole('link', { name: /Open the proposal workspace/ })).toHaveAttribute('href', '/opportunities/o1/proposal')
  })

  it('is unchanged for a plain message', () => {
    renderToast(false)
    fireEvent.click(screen.getByRole('button', { name: 'go' }))
    expect(screen.getByText('Proposal started.')).toBeInTheDocument()
    expect(screen.queryByRole('link')).not.toBeInTheDocument()
  })
})
