import { describe, it, expect } from 'vitest'
import { roleLabel } from './roleLabels'

describe('roleLabel', () => {
  it('shows the read-only staff role as Read-only, not Consultant', () => {
    expect(roleLabel('CONSULTANT')).toBe('Read-only')
    expect(roleLabel('ADMIN')).toBe('Admin')
    expect(roleLabel('SOMETHING_NEW')).toBe('SOMETHING_NEW')
    expect(roleLabel(undefined)).toBe('')
  })
})
