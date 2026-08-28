// =============================================================
// Pipeline stage state-machine unit tests (pure logic, no DB).
// =============================================================
import { describe, it, expect } from 'vitest'
import {
  isValidStageTransition,
  allowedStageTargets,
  isPursuitOverdue,
  isPipelineStage,
  isPursuitPriority,
} from './pipelineStages'

describe('pipeline stage transitions', () => {
  it('allows the forward capture flow', () => {
    expect(isValidStageTransition('IDENTIFIED', 'QUALIFICATION')).toBe(true)
    expect(isValidStageTransition('QUALIFICATION', 'CAPTURE')).toBe(true)
    expect(isValidStageTransition('CAPTURE', 'PROPOSAL')).toBe(true)
    expect(isValidStageTransition('PROPOSAL', 'SUBMITTED')).toBe(true)
    expect(isValidStageTransition('SUBMITTED', 'AWARDED')).toBe(true)
    expect(isValidStageTransition('SUBMITTED', 'LOST')).toBe(true)
  })

  it('rejects skipping stages and impossible rewinds', () => {
    expect(isValidStageTransition('IDENTIFIED', 'PROPOSAL')).toBe(false)
    expect(isValidStageTransition('SUBMITTED', 'IDENTIFIED')).toBe(false)
    expect(isValidStageTransition('AWARDED', 'SUBMITTED')).toBe(false)
    expect(isValidStageTransition('LOST', 'CAPTURE')).toBe(false)
  })

  it('rejects same-stage no-ops', () => {
    expect(isValidStageTransition('CAPTURE', 'CAPTURE')).toBe(false)
  })

  it('AWARDED and LOST may only archive', () => {
    expect(allowedStageTargets('AWARDED')).toEqual(['ARCHIVED'])
    expect(allowedStageTargets('LOST')).toEqual(['ARCHIVED'])
  })

  it('NO_BID can be reassessed back to QUALIFICATION and ARCHIVED reopened', () => {
    expect(isValidStageTransition('NO_BID', 'QUALIFICATION')).toBe(true)
    expect(isValidStageTransition('ARCHIVED', 'IDENTIFIED')).toBe(true)
  })
})

describe('overdue detection', () => {
  const now = new Date('2026-08-05T12:00:00Z')
  const past = new Date('2026-08-04T12:00:00Z')
  const future = new Date('2026-08-06T12:00:00Z')

  it('is overdue when a due date is in the past and the stage is open', () => {
    expect(isPursuitOverdue('CAPTURE', past, now)).toBe(true)
  })

  it('is not overdue with no due date or a future due date', () => {
    expect(isPursuitOverdue('CAPTURE', null, now)).toBe(false)
    expect(isPursuitOverdue('CAPTURE', future, now)).toBe(false)
  })

  it('is never overdue in a closed stage', () => {
    expect(isPursuitOverdue('AWARDED', past, now)).toBe(false)
    expect(isPursuitOverdue('NO_BID', past, now)).toBe(false)
    expect(isPursuitOverdue('ARCHIVED', past, now)).toBe(false)
  })
})

describe('type guards', () => {
  it('validate stage and priority values', () => {
    expect(isPipelineStage('CAPTURE')).toBe(true)
    expect(isPipelineStage('NOPE')).toBe(false)
    expect(isPursuitPriority('CRITICAL')).toBe(true)
    expect(isPursuitPriority('URGENT')).toBe(false)
  })
})
