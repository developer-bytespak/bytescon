import { render, screen } from '@testing-library/react'
import { describe, it, expect } from 'vitest'
import { OptionalDetailsNote } from './OptionalDetailsNote'

const status = (over: Record<string, unknown> = {}) => ({
  clientCompanyId: 'c1', name: 'Co', isSelf: true, complete: true, percent: 100, missing: [],
  optional: { filled: 3, total: 14, missing: ['Phone', 'PSC codes', 'Logo'], improving: [{ label: 'PSC codes', improves: 'matching and proposals' }, { label: 'Logo', improves: 'proposal PDFs' }] },
  ...over,
}) as never

describe('OptionalDetailsNote', () => {
  it('names only the empty details that improve results, and what each improves', () => {
    render(<OptionalDetailsNote status={status()} />)
    expect(screen.getByText('To improve your results, you can also add: PSC codes (matching and proposals), Logo (proposal PDFs).')).toBeInTheDocument()
    expect(screen.queryByText(/Phone/)).not.toBeInTheDocument()
  })

  it('says nothing when nothing useful is missing, or the profile is incomplete', () => {
    const { container, rerender } = render(<OptionalDetailsNote status={status({ optional: { filled: 11, total: 14, missing: ['Phone'], improving: [] } })} />)
    expect(container).toBeEmptyDOMElement()
    rerender(<OptionalDetailsNote status={status({ complete: false })} />)
    expect(container).toBeEmptyDOMElement()
  })
})
