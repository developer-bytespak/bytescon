// =============================================================
// Type-to-search picker.
//
// The assertions that matter are the ones a plain <select> could not make:
// results come from the SERVER for every keystroke, and a slow earlier
// response never overwrites a newer, better one.
// =============================================================
import { render, screen, waitFor, fireEvent } from '@testing-library/react'
import { useState } from 'react'
import { describe, it, expect, vi } from 'vitest'
import { SearchSelect, type SearchOption } from './SearchSelect'

const ROWS: SearchOption[] = [
  { id: 'o1', label: 'DOE Cybersecurity Support', hint: 'Department of Energy' },
  { id: 'o2', label: 'Cyber Range Operations', hint: 'Department of Defense' },
]

/**
 * The component is controlled, so the harness owns `value` the way a real form
 * does. Rendering with a frozen empty value would test a parent that ignores
 * its own picker, not the picker.
 */
function Controlled({ search, onChange }: {
  search: (t: string) => Promise<SearchOption[]>
  onChange: (id: string) => void
}) {
  const [value, setValue] = useState('')
  return (
    <SearchSelect
      value={value}
      onChange={(id) => { setValue(id); onChange(id) }}
      search={search}
      label="Link to an opportunity"
    />
  )
}

function setup(search: (t: string) => Promise<SearchOption[]>, onChange = vi.fn()) {
  render(<Controlled search={search} onChange={onChange} />)
  return onChange
}

describe('SearchSelect', () => {
  it('asks the server on focus, before anything is typed', async () => {
    const search = vi.fn().mockResolvedValue(ROWS)
    setup(search)
    fireEvent.focus(screen.getByLabelText('Link to an opportunity'))
    await waitFor(() => expect(search).toHaveBeenCalledWith(''))
    expect(await screen.findByText('DOE Cybersecurity Support')).toBeInTheDocument()
  })

  it('searches from the very first character', async () => {
    const search = vi.fn().mockResolvedValue(ROWS)
    setup(search)
    const input = screen.getByLabelText('Link to an opportunity')
    fireEvent.focus(input)
    fireEvent.change(input, { target: { value: 'c' } })
    await waitFor(() => expect(search).toHaveBeenCalledWith('c'))
  })

  it('sends the full term as it grows, so results keep narrowing', async () => {
    const search = vi.fn().mockResolvedValue(ROWS)
    setup(search)
    const input = screen.getByLabelText('Link to an opportunity')
    fireEvent.focus(input)
    fireEvent.change(input, { target: { value: 'cy' } })
    await waitFor(() => expect(search).toHaveBeenCalledWith('cy'))
    fireEvent.change(input, { target: { value: 'cyber' } })
    await waitFor(() => expect(search).toHaveBeenCalledWith('cyber'))
  })

  it('shows the agency alongside the title, so near-identical names are separable', async () => {
    setup(vi.fn().mockResolvedValue(ROWS))
    fireEvent.focus(screen.getByLabelText('Link to an opportunity'))
    expect(await screen.findByText('Department of Energy')).toBeInTheDocument()
    expect(screen.getByText('Department of Defense')).toBeInTheDocument()
  })

  it('reports the chosen id and then shows its name', async () => {
    const onChange = setup(vi.fn().mockResolvedValue(ROWS))
    fireEvent.focus(screen.getByLabelText('Link to an opportunity'))
    fireEvent.click(await screen.findByText('Cyber Range Operations'))
    expect(onChange).toHaveBeenCalledWith('o2')
    expect(screen.getByText('Cyber Range Operations')).toBeInTheDocument()
  })

  it('clears back to empty', async () => {
    const onChange = setup(vi.fn().mockResolvedValue(ROWS))
    fireEvent.focus(screen.getByLabelText('Link to an opportunity'))
    fireEvent.click(await screen.findByText('Cyber Range Operations'))
    fireEvent.click(screen.getByLabelText('Clear selection'))
    expect(onChange).toHaveBeenLastCalledWith('')
  })

  it('picks the highlighted row with the keyboard', async () => {
    const onChange = setup(vi.fn().mockResolvedValue(ROWS))
    const input = screen.getByLabelText('Link to an opportunity')
    fireEvent.focus(input)
    await screen.findByText('DOE Cybersecurity Support')
    fireEvent.keyDown(input, { key: 'ArrowDown' })
    fireEvent.keyDown(input, { key: 'Enter' })
    expect(onChange).toHaveBeenCalledWith('o2')
  })

  it('drops a stale response so a slow early search cannot overwrite a newer one', async () => {
    const search = vi.fn()
      .mockImplementationOnce(() => new Promise<SearchOption[]>((r) =>
        setTimeout(() => r([{ id: 'stale', label: 'STALE ROW' }]), 600)))
      .mockResolvedValue(ROWS)

    setup(search)
    const input = screen.getByLabelText('Link to an opportunity')
    fireEvent.focus(input)
    // Let the first search actually dispatch, so it is genuinely in flight
    // when the second one starts. Otherwise the debounce cancels it and the
    // race this test exists for never happens.
    await waitFor(() => expect(search).toHaveBeenCalledTimes(1))

    fireEvent.change(input, { target: { value: 'cyber' } })
    await waitFor(() => expect(search).toHaveBeenCalledTimes(2))
    expect(await screen.findByText('DOE Cybersecurity Support')).toBeInTheDocument()

    // The slow first response lands only now. It must be ignored.
    await new Promise((r) => setTimeout(r, 700))
    expect(screen.queryByText('STALE ROW')).not.toBeInTheDocument()
    expect(screen.getByText('DOE Cybersecurity Support')).toBeInTheDocument()
  })

  it('says so plainly when nothing matches', async () => {
    setup(vi.fn().mockResolvedValue([]))
    fireEvent.focus(screen.getByLabelText('Link to an opportunity'))
    expect(await screen.findByText('No matches.')).toBeInTheDocument()
  })

  it('stays usable when the search fails — linking is optional', async () => {
    setup(vi.fn().mockRejectedValue(new Error('network')))
    fireEvent.focus(screen.getByLabelText('Link to an opportunity'))
    expect(await screen.findByText('No matches.')).toBeInTheDocument()
  })
})
