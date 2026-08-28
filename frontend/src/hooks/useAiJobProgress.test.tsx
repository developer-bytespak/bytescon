// =============================================================
// Section 4 #3 — useAiJobProgress drives the AI operation UX: success, a
// retryable error, and cancellation via AbortSignal.
// =============================================================
import { renderHook, act, waitFor } from '@testing-library/react'
import { describe, it, expect } from 'vitest'
import { useAiJobProgress } from './useAiJobProgress'

describe('useAiJobProgress', () => {
  it('runs to completion and returns the value', async () => {
    const { result } = renderHook(() => useAiJobProgress())

    let value: unknown
    await act(async () => {
      value = await result.current.run(async () => 'ok')
    })

    expect(value).toBe('ok')
    expect(result.current.state).toBe('done')
    expect(result.current.running).toBe(false)
  })

  it('captures a non-abort error via the mapper and exposes it', async () => {
    const { result } = renderHook(() => useAiJobProgress())

    let value: unknown = 'sentinel'
    await act(async () => {
      value = await result.current.run(
        async () => {
          throw new Error('boom')
        },
        () => 'friendly message',
      )
    })

    expect(value).toBeUndefined()
    expect(result.current.state).toBe('error')
    expect(result.current.error).toBe('friendly message')
  })

  it('cancels an in-flight op via the AbortSignal (no error state)', async () => {
    const { result } = renderHook(() => useAiJobProgress())

    let runPromise: Promise<unknown>
    act(() => {
      runPromise = result.current.run(
        (signal) =>
          new Promise((_resolve, reject) => {
            signal.addEventListener('abort', () => {
              const err = new Error('canceled') as Error & { name: string }
              err.name = 'CanceledError'
              reject(err)
            })
          }),
      )
    })

    await waitFor(() => expect(result.current.running).toBe(true))

    act(() => result.current.cancel())

    await act(async () => {
      await runPromise
    })

    expect(result.current.state).toBe('cancelled')
    expect(result.current.error).toBe('')
  })

  it('reports a phase label and an eta hint', () => {
    const { result } = renderHook(() => useAiJobProgress({ expectedSec: 25 }))
    expect(result.current.etaHint).toBe('usually ~25s')
    expect(typeof result.current.phase).toBe('string')
  })
})
