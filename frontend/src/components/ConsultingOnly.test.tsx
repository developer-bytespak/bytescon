// Client pages send contractor accounts (no clients) to the dashboard.
import { render, screen } from '@testing-library/react'
import { MemoryRouter, Routes, Route } from 'react-router-dom'
import { describe, it, expect, vi, beforeEach } from 'vitest'

let contractor = false
vi.mock('../hooks/useAuth', () => ({ useIsContractor: () => contractor }))

import { ConsultingOnly } from './ConsultingOnly'

function renderAt() {
  return render(
    <MemoryRouter initialEntries={['/clients']}>
      <Routes>
        <Route path="/clients" element={<ConsultingOnly><p>Client list</p></ConsultingOnly>} />
        <Route path="/dashboard" element={<p>Dashboard page</p>} />
      </Routes>
    </MemoryRouter>,
  )
}

beforeEach(() => { contractor = false })

describe('ConsultingOnly', () => {
  it('shows the page to a consulting firm', () => {
    renderAt()
    expect(screen.getByText('Client list')).toBeInTheDocument()
  })

  it('sends a contractor account to the dashboard', () => {
    contractor = true
    renderAt()
    expect(screen.getByText('Dashboard page')).toBeInTheDocument()
    expect(screen.queryByText('Client list')).toBeNull()
  })
})
