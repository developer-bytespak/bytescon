import { useState, useRef, useCallback, useEffect } from 'react'
import { useQueryClient } from '@tanstack/react-query'
import { jobsApi } from '../services/api'

interface JobState {
  jobId: string | null
  status: 'idle' | 'running' | 'success' | 'error'
  message: string
  detail: string
}

const defaultState: JobState = {
  jobId: null,
  status: 'idle',
  message: '',
  detail: '',
}

export function useJobPolling(options?: {
  interval?: number
  invalidateKeys?: string[][]
}) {
  const [state, setState] = useState<JobState>(defaultState)
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null)
  const qc = useQueryClient()

  const clearPoll = useCallback(() => {
    if (pollRef.current) {
      clearInterval(pollRef.current)
      pollRef.current = null
    }
  }, [])

  const startPolling = useCallback(
    (jobId: string, message?: string) => {
      clearPoll()
      setState({
        jobId,
        status: 'running',
        message: message || 'Processing...',
        detail: '',
      })

      const interval = options?.interval || 3000

      pollRef.current = setInterval(async () => {
        try {
          const result = await jobsApi.getJob(jobId)
          const job = result?.data

          if (!job) return

          if (job.status === 'completed') {
            clearPoll()
            setState((s) => ({
              ...s,
              status: 'success',
              message: 'Completed successfully',
              detail: job.result
                ? JSON.stringify(job.result).substring(0, 200)
                : '',
            }))

            // Invalidate specified query keys
            const keys = options?.invalidateKeys || []
            for (const key of keys) {
              qc.invalidateQueries({ queryKey: key })
            }
          } else if (job.status === 'failed') {
            clearPoll()
            setState((s) => ({
              ...s,
              status: 'error',
              message: 'Job failed',
              detail: job.errorDetail || 'Unknown error',
            }))
          }
          // Still running — keep polling
        } catch {
          // Non-fatal — keep polling
        }
      }, interval)
    },
    [clearPoll, qc, options?.interval, options?.invalidateKeys]
  )

  const reset = useCallback(() => {
    clearPoll()
    setState(defaultState)
  }, [clearPoll])

  // Cleanup on unmount
  useEffect(() => clearPoll, [clearPoll])

  return { state, startPolling, reset }
}
