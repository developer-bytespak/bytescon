// =============================================================
// §8.4 — Knowledge search UI.
//
// What matters here is honesty: the panel must say it is a text search, must
// render each result's approval state rather than implying one, and an empty
// result must not read as "the firm has nothing".
// =============================================================
import { render, screen, waitFor, fireEvent } from '@testing-library/react'
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { MemoryRouter } from 'react-router-dom'
import { KnowledgeSearch } from './KnowledgeSearch'

const search = vi.fn()

vi.mock('../../services/knowledgeApi', async () => {
  const actual = await vi.importActual<typeof import('../../services/knowledgeApi')>('../../services/knowledgeApi')
  return { ...actual, knowledgeApi: { search: (...a: unknown[]) => search(...a) } }
})

const METHOD = 'Case-insensitive text match across the existing knowledge tables, ranked by title match then recency. This is a database text search, not a semantic or AI search: a record whose wording differs from your query will not be found.'

const wrap = () => render(<MemoryRouter><KnowledgeSearch /></MemoryRouter>)

const runSearch = (term: string) => {
  fireEvent.change(screen.getByLabelText('Search knowledge'), { target: { value: term } })
  fireEvent.click(screen.getByRole('button', { name: 'Search' }))
}

beforeEach(() => vi.clearAllMocks())

describe('KnowledgeSearch', () => {
  it('renders results with their type and approval state', async () => {
    search.mockResolvedValue({
      query: 'cyber', total: 2, limit: 25, offset: 0, method: METHOD,
      totalByType: { CAPABILITY: 1, PERSONNEL: 1 },
      results: [
        { type: 'CAPABILITY', id: 'c1', title: 'Cyber defence', summary: 'Managed detection.', sourceRoute: '/discovery?tab=capabilities', evidenceState: 'VERIFIED', updatedAt: '2026-08-01T00:00:00.000Z' },
        { type: 'PERSONNEL', id: 'p1', title: 'Ada Byron', summary: 'Engineer', sourceRoute: '/knowledge', evidenceState: 'NO_APPROVED_RESUME', updatedAt: '2026-08-01T00:00:00.000Z' },
      ],
    })
    wrap()
    runSearch('cyber')
    expect(await screen.findByText('Cyber defence')).toBeInTheDocument()
    expect(screen.getByText('VERIFIED')).toBeInTheDocument()
    expect(screen.getByText('NO_APPROVED_RESUME')).toBeInTheDocument()
  })

  it('states that it is a database text search, not an AI one', async () => {
    search.mockResolvedValue({ query: 'x', total: 0, limit: 25, offset: 0, method: METHOD, totalByType: {}, results: [] })
    wrap()
    runSearch('x')
    expect(await screen.findByText(/not a semantic or AI search/i)).toBeInTheDocument()
  })

  it('explains an empty result rather than implying nothing exists', async () => {
    search.mockResolvedValue({ query: 'nothing', total: 0, limit: 25, offset: 0, method: METHOD, totalByType: {}, results: [] })
    wrap()
    runSearch('nothing')
    expect(await screen.findByText(/Nothing matched/i)).toBeInTheDocument()
    expect(screen.getByText(/a record worded differently will not appear/i)).toBeInTheDocument()
  })

  it('passes a type filter to the server', async () => {
    search.mockResolvedValue({ query: 'x', total: 0, limit: 25, offset: 0, method: METHOD, totalByType: {}, results: [] })
    wrap()
    runSearch('x')
    await waitFor(() => expect(search).toHaveBeenCalled())
    fireEvent.click(screen.getByRole('button', { name: /Template/ }))
    await waitFor(() => expect(search).toHaveBeenLastCalledWith(expect.objectContaining({ types: 'TEMPLATE' })))
  })

  it('surfaces a server error', async () => {
    search.mockRejectedValue({ response: { data: { error: 'Unknown result type: NONSENSE' } } })
    wrap()
    runSearch('x')
    expect(await screen.findByText('Unknown result type: NONSENSE')).toBeInTheDocument()
  })

  it('does not search on an empty term', async () => {
    wrap()
    fireEvent.click(screen.getByRole('button', { name: 'Search' }))
    await waitFor(() => expect(search).not.toHaveBeenCalled())
  })
})
