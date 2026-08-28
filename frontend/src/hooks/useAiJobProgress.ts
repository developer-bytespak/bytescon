import { useCallback, useEffect, useRef, useState } from 'react'

// Section 4 #3: the AI operations (Analyze Solicitation, Generate Outline) are
// synchronous HTTP calls that can run 15–40s+. Previously the UI showed only a
// spinner, which reads as "frozen". This hook adds — without changing the
// synchronous architecture — a live elapsed timer, a staged phase label derived
// from expected duration, and a cancel path (AbortController) so a long call
// reads as working and can be aborted.

export interface AiJobPhase {
  /** Seconds elapsed at which this label starts showing. */
  atSec: number
  label: string
}

export type AiJobState = 'idle' | 'running' | 'done' | 'error' | 'cancelled'

export interface UseAiJobProgress {
  state: AiJobState
  running: boolean
  elapsedSec: number
  phase: string
  error: string
  /** Human hint like "usually ~30s". */
  etaHint: string
  /**
   * Run an async operation that takes an AbortSignal. Manages state, the timer,
   * cancellation, and error capture. Returns the resolved value, or undefined
   * if it was cancelled or failed.
   */
  run: <T>(op: (signal: AbortSignal) => Promise<T>, onError?: (err: unknown) => string) => Promise<T | undefined>
  cancel: () => void
  reset: () => void
}

const DEFAULT_PHASES: AiJobPhase[] = [
  { atSec: 0, label: 'Sending request…' },
  { atSec: 3, label: 'Reading the solicitation…' },
  { atSec: 10, label: 'Analyzing requirements…' },
  { atSec: 20, label: 'Finalizing…' },
  { atSec: 40, label: 'Still working — almost there…' },
]

function isAbortError(err: unknown): boolean {
  const e = err as { name?: string; code?: string } | undefined
  return e?.name === 'CanceledError' || e?.name === 'AbortError' || e?.code === 'ERR_CANCELED'
}

export function useAiJobProgress(opts?: { expectedSec?: number; phases?: AiJobPhase[] }): UseAiJobProgress {
  const expectedSec = opts?.expectedSec ?? 30
  const phases = opts?.phases ?? DEFAULT_PHASES

  const [state, setState] = useState<AiJobState>('idle')
  const [elapsedSec, setElapsedSec] = useState(0)
  const [error, setError] = useState('')
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null)
  const abortRef = useRef<AbortController | null>(null)

  const stopTimer = useCallback(() => {
    if (timerRef.current) {
      clearInterval(timerRef.current)
      timerRef.current = null
    }
  }, [])

  useEffect(() => () => stopTimer(), [stopTimer])

  const reset = useCallback(() => {
    stopTimer()
    abortRef.current = null
    setState('idle')
    setElapsedSec(0)
    setError('')
  }, [stopTimer])

  const cancel = useCallback(() => {
    abortRef.current?.abort()
    stopTimer()
    setState('cancelled')
  }, [stopTimer])

  const run = useCallback(
    async <T,>(op: (signal: AbortSignal) => Promise<T>, onError?: (err: unknown) => string): Promise<T | undefined> => {
      const controller = new AbortController()
      abortRef.current = controller
      setError('')
      setElapsedSec(0)
      setState('running')

      const startedAt = performance.now()
      stopTimer()
      timerRef.current = setInterval(() => {
        setElapsedSec(Math.floor((performance.now() - startedAt) / 1000))
      }, 250)

      try {
        const result = await op(controller.signal)
        stopTimer()
        setState('done')
        return result
      } catch (err) {
        stopTimer()
        if (isAbortError(err) || controller.signal.aborted) {
          setState('cancelled')
          return undefined
        }
        setState('error')
        setError(onError ? onError(err) : 'Something went wrong. Please try again.')
        return undefined
      }
    },
    [stopTimer],
  )

  const phase =
    [...phases].reverse().find((p) => elapsedSec >= p.atSec)?.label ?? phases[0]?.label ?? 'Working…'
  const etaHint = `usually ~${expectedSec}s`

  return {
    state,
    running: state === 'running',
    elapsedSec,
    phase,
    error,
    etaHint,
    run,
    cancel,
    reset,
  }
}
