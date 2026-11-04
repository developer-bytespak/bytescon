// B27 — the Feedback page speaks to customers, not to the team.
import { render, screen } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { describe, it, expect } from 'vitest'
import FeedbackPage from './Feedback'

describe('Feedback page wording', () => {
  it('explains the survey without internal wording', () => {
    const { container } = render(
      <QueryClientProvider client={new QueryClient()}>
        <MemoryRouter><FeedbackPage /></MemoryRouter>
      </QueryClientProvider>,
    )
    expect(screen.getByText(/help us decide what to improve next/i)).toBeTruthy()
    expect(container.textContent).not.toMatch(/investor|traction|calibration backlog/i)
  })
})
