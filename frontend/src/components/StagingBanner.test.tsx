import { render, screen } from '@testing-library/react'
import { describe, it, expect } from 'vitest'
import { StagingBanner } from './StagingBanner'

describe('StagingBanner', () => {
  it('shows on a staging build', () => {
    render(<StagingBanner appEnv="staging" />)
    expect(screen.getByTestId('staging-banner').textContent).toMatch(/STAGING/)
  })

  it.each(['production', '', undefined])('stays hidden when the environment is %s', (appEnv) => {
    const { container } = render(<StagingBanner appEnv={appEnv} />)
    expect(container.firstChild).toBeNull()
  })
})
