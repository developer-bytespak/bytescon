// =============================================================
// AppError subclass identity.
//
// AppError's constructor used to end with `Object.setPrototypeOf(this,
// AppError.prototype)`. A subclass constructor's body runs AFTER super(), so
// that line overwrote the subclass prototype on every instance: `new
// AiUnavailableError() instanceof AiUnavailableError` was FALSE and
// `constructor.name` reported 'AppError'.
//
// It went unnoticed for a long time because the codebase only ever tested
// `instanceof AppError`, which stayed true either way. It surfaced when a fix
// guarded on `err instanceof AiUnavailableError` to decide whether an AI outage
// should be re-thrown — the guard silently never fired and a fabricated FAR
// compliance matrix shipped to the customer during a real provider outage.
//
// These tests pin the invariant for EVERY subclass so the footgun cannot come
// back the next time someone touches the base class.
// =============================================================
import { describe, it, expect } from 'vitest'
import {
  AppError,
  UnauthorizedError,
  ForbiddenError,
  NotFoundError,
  ValidationError,
  AiUnavailableError,
} from './errors'

const SUBCLASSES = [
  { Ctor: UnauthorizedError, name: 'UnauthorizedError' },
  { Ctor: ForbiddenError, name: 'ForbiddenError' },
  { Ctor: NotFoundError, name: 'NotFoundError' },
  { Ctor: ValidationError, name: 'ValidationError' },
  { Ctor: AiUnavailableError, name: 'AiUnavailableError' },
] as const

describe('AppError subclass prototype chain', () => {
  it.each(SUBCLASSES)('$name is instanceof itself', ({ Ctor }) => {
    // The exact assertion that was false before the base-class fix.
    expect(new (Ctor as any)() instanceof Ctor).toBe(true)
  })

  it.each(SUBCLASSES)('$name is still instanceof AppError', ({ Ctor }) => {
    expect(new (Ctor as any)()).toBeInstanceOf(AppError)
  })

  it.each(SUBCLASSES)('$name is still instanceof Error', ({ Ctor }) => {
    expect(new (Ctor as any)()).toBeInstanceOf(Error)
  })

  it.each(SUBCLASSES)('$name reports its own constructor name', ({ Ctor, name }) => {
    expect(new (Ctor as any)().constructor.name).toBe(name)
  })

  it('does not make unrelated subclasses interchangeable', () => {
    expect(new NotFoundError()).not.toBeInstanceOf(AiUnavailableError)
    expect(new AiUnavailableError()).not.toBeInstanceOf(NotFoundError)
  })
})

describe('AiUnavailableError carries the 503 contract', () => {
  it('has statusCode 503 and code AI_UNAVAILABLE so errorHandler maps it', () => {
    const err = new AiUnavailableError()
    expect(err.statusCode).toBe(503)
    expect(err.code).toBe('AI_UNAVAILABLE')
    expect(err.isOperational).toBe(true)
  })

  it('keeps a usable stack and message', () => {
    const err = new AiUnavailableError('provider down')
    expect(err.message).toBe('provider down')
    expect(err.stack).toBeTruthy()
  })
})
