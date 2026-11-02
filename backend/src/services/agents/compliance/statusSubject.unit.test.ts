// =============================================================
// statusSubject — where a compliance run files its status.
//
// A sweep is the firm-wide status; an event run covers one record and must be
// filed under it, so it never supersedes the firm-wide sweep.
// =============================================================
import { describe, it, expect } from 'vitest'
import { statusSubject, OPPORTUNITY_ENTITY_TYPE } from './complianceAgentHandler'

const FIRM = 'firm-1'

describe('statusSubject', () => {
  it('files a sweep (no trigger entity) under the firm', () => {
    expect(statusSubject({ consultingFirmId: FIRM, triggerEntityType: null, triggerEntityId: null }, [{ id: 'o1' }, { id: 'o2' }]))
      .toEqual({ type: 'ConsultingFirm', id: FIRM })
  })

  it('files an event run that resolves to one opportunity under that opportunity', () => {
    expect(statusSubject({ consultingFirmId: FIRM, triggerEntityType: 'OpportunityDocument', triggerEntityId: 'doc-1' }, [{ id: 'o1' }]))
      .toEqual({ type: OPPORTUNITY_ENTITY_TYPE, id: 'o1' })
  })

  it('files an event run with no single opportunity under the triggering record', () => {
    expect(statusSubject({ consultingFirmId: FIRM, triggerEntityType: 'Amendment', triggerEntityId: 'amd-1' }, []))
      .toEqual({ type: 'Amendment', id: 'amd-1' })
    expect(statusSubject({ consultingFirmId: FIRM, triggerEntityType: 'BidPursuit', triggerEntityId: 'p-1' }, [{ id: 'o1' }, { id: 'o2' }]))
      .toEqual({ type: 'BidPursuit', id: 'p-1' })
  })

  it('never files an event run under the firm', () => {
    const subject = statusSubject({ consultingFirmId: FIRM, triggerEntityType: null, triggerEntityId: 'x-1' }, [])
    expect(subject.type).not.toBe('ConsultingFirm')
    expect(subject.id).toBe('x-1')
  })
})
