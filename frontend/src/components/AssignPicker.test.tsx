// Every assignment picker says it is optional and what choosing someone does.
import { render, screen, fireEvent } from '@testing-library/react'
import { describe, it, expect, vi } from 'vitest'
import { AssignPicker, ASSIGN } from './AssignPicker'

const users = [{ id: 'u1', firstName: 'Pat', lastName: 'Lee' }, { id: 'u2', email: 'sam@firm.test' }]

describe('AssignPicker', () => {
  it('labels the choice as optional and explains what happens', () => {
    render(<AssignPicker kind="approver" users={users} value={null} onChange={vi.fn()} />)
    expect(screen.getByText('Get it approved by')).toBeInTheDocument()
    expect(screen.getByText('(optional)')).toBeInTheDocument()
    expect(screen.getByText(ASSIGN.approver.hint)).toBeInTheDocument()
    expect(screen.getByRole('option', { name: 'Not assigned' })).toBeInTheDocument()
  })

  it('returns the chosen person, or null when cleared', () => {
    const onChange = vi.fn()
    render(<AssignPicker kind="writer" users={users} value="u1" onChange={onChange} />)
    const select = screen.getByLabelText('Assign writing to (optional)')
    fireEvent.change(select, { target: { value: 'u2' } })
    expect(onChange).toHaveBeenLastCalledWith('u2')
    fireEvent.change(select, { target: { value: '' } })
    expect(onChange).toHaveBeenLastCalledWith(null)
    expect(screen.getByRole('option', { name: 'sam@firm.test' })).toBeInTheDocument()
  })
})
