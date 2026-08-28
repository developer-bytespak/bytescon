import { useState, useRef, useCallback, useEffect } from 'react'
import { useQueryClient } from '@tanstack/react-query'
import { api } from '../services/api'

type Status = 'idle' | 'queued' | 'running' | 'success' | 'error'

interface PortfolioEvalState {
  jobId: string | null
  status: Status
  message: string
  result: unknown | null
}

const defaultState: PortfolioEvalState = {
  jobId: null,
  status: 'idle',
  message: '',
  result: null,
}

/**
 * Triggers the async portfolio evaluation (POST /api/decision/run-all-async)
 * and polls GET /api/decision/job/:jobId until it completes, so the heavy
 * O(N×M) sweep no longer blocks an HTTP request. Mirrors useJobPolling, but
 * targets the BullMQ-backed decision job rather than the IngestionJob table.
 *
 * SCAFFOLD: wire `run` to the Decisions page "Run all" button and render
 * `state.status` (queued/running/success/error). The legacy synchronous
 * POST /api/decision/run-all still works for small portfolios.
 */
export function usePortfolioEvaluation(options?: {
  interval?: number
  invalidateKeys?: string[][]
}) {
  const [state, setState] = useState<PortfolioEvalState>(defaultState)
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null)
  const qc = useQueryClient()

  const clearPoll = useCallback(() => {
    if (pollRef.current) {
      clearInterval(pollRef.current)
      pollRef.current = null
    }
  }, [])

  const poll = useCallback(
    (jobId: string) => {
      const interval = options?.interval ?? 3000
      // Terminate on repeated 404s (job evicted by removeOnComplete, or BullMQ
      // state lost on a deploy restart) and on an absolute deadline — without
      // these, a vanished job left the UI on "Evaluating…" polling forever.
      const startedAt = Date.now()
      const MAX_WAIT_MS = 15 * 60 * 1000
      let consecutiveMisses = 0
      const giveUp = (message: string) => {
        clearPoll()
        setState((s) => ({ ...s, status: 'error', message, result: null }))
      }
      pollRef.current = setInterval(async () => {
        if (Date.now() - startedAt > MAX_WAIT_MS) {
          giveUp('Evaluation is taking longer than expected — refresh the page to check results.')
          return
        }
        try {
          const r = await api.get(`/decision/job/${jobId}`)
          const job = r.data?.data
          if (!job) return

          consecutiveMisses = 0
          if (job.status === 'completed') {
            clearPoll()
            setState((s) => ({
              ...s,
              status: 'success',
              message: 'Portfolio evaluation complete',
              result: job.result ?? null,
            }))
            for (const key of options?.invalidateKeys ?? []) {
              qc.invalidateQueries({ queryKey: key })
            }
          } else if (job.status === 'failed') {
            clearPoll()
            setState((s) => ({
              ...s,
              status: 'error',
              message: job.failedReason || 'Evaluation failed',
              result: null,
            }))
          } else {
            setState((s) => ({ ...s, status: 'running' }))
          }
        } catch (err) {
          const status = (err as { response?: { status?: number } })?.response?.status
          if (status === 404) {
            // Three misses in a row = the job record is gone for good.
            consecutiveMisses += 1
            if (consecutiveMisses >= 3) {
              giveUp('Lost track of the evaluation job (it may have completed during a restart). Refresh to see results.')
            }
            return
          }
          // Transient network errors — keep polling until the deadline.
        }
      }, interval)
    },
    [clearPoll, qc, options?.interval, options?.invalidateKeys],
  )

  const run = useCallback(async () => {
    clearPoll()
    setState({ ...defaultState, status: 'queued', message: 'Queued…' })
    try {
      const r = await api.post('/decision/run-all-async')
      const jobId = r.data?.data?.jobId as string | undefined
      if (!jobId) throw new Error('No job id returned')
      setState((s) => ({ ...s, jobId, status: 'running', message: 'Evaluating portfolio…' }))
      poll(jobId)
    } catch {
      setState((s) => ({ ...s, status: 'error', message: 'Failed to start evaluation' }))
    }
  }, [clearPoll, poll])

  const reset = useCallback(() => {
    clearPoll()
    setState(defaultState)
  }, [clearPoll])

  useEffect(() => clearPoll, [clearPoll])

  return { state, run, reset }
}
