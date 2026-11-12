import { describe, it, expect } from 'vitest'
import { contractorPlanFeature } from './contractorWording'

describe('contractorPlanFeature', () => {
  it('drops client-company limits', () => {
    expect(contractorPlanFeature('Company profile & onboarding — up to 5 client companies')).toBe('Company profile & onboarding')
    expect(contractorPlanFeature('10 seats · unlimited client companies')).toBe('10 seats')
    expect(contractorPlanFeature('10 seats, unlimited client companies')).toBe('10 seats')
  })

  it('drops the client portal from module lists', () => {
    expect(contractorPlanFeature('ALL add-on modules included — Set-Aside Intelligence, API & MCP Access, Client Portal'))
      .toBe('ALL add-on modules included — Set-Aside Intelligence, API & MCP Access')
    expect(contractorPlanFeature('Set-Aside Intel · Teaming · API/MCP · Client Portal')).toBe('Set-Aside Intel · Teaming · API/MCP')
  })

  it('leaves other lines alone', () => {
    expect(contractorPlanFeature('Priority support')).toBe('Priority support')
  })
})
