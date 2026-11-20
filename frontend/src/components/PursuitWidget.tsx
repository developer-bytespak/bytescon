import { useState } from 'react'
import { Link } from 'react-router-dom'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { pursuitsApi, clientsApi } from '../services/api'
import { plainText } from './dashboard/format'

/**
 * Bids waiting for a decision — the standing dashboard prompt of the bid
 * pursuit tracker. Every solicitation the firm opens becomes a REVIEWING
 * pursuit; the firm declares Submitted / Passed / Later here. Submitted
 * pursuits create a SubmissionRecord whose WON/LOST outcome labels the
 * probability engine's calibration data, and award notices for submitted
 * solicitations surface on top as outcome prompts.
 */
export function PursuitWidget() {
  const qc = useQueryClient()
  const [expanded, setExpanded] = useState(false)
  const [clientPickerFor, setClientPickerFor] = useState<string | null>(null)
  const [errText, setErrText] = useState('')

  const { data: pursuitsData, isLoading } = useQuery({
    queryKey: ['pursuits', 'REVIEWING'],
    queryFn: () => pursuitsApi.list('REVIEWING'),
    refetchInterval: 300_000,
  })
  const { data: promptsData } = useQuery({
    queryKey: ['pursuit-award-prompts'],
    queryFn: () => pursuitsApi.awardPrompts(),
    refetchInterval: 300_000,
  })
  // Loaded only when a 'Submitted' declaration needs a client picker.
  const { data: clientsData } = useQuery({
    queryKey: ['clients-list'],
    queryFn: () => clientsApi.list({ limit: 200 }),
    enabled: clientPickerFor !== null,
  })

  const pursuits = (pursuitsData?.data ?? []) as any[]
  const prompts = (promptsData?.data ?? []) as any[]
  const clients = (clientsData?.data ?? []) as any[]

  const updateMut = useMutation({
    mutationFn: ({ id, body }: {
      id: string
      body: { action: 'submitted' | 'passed' | 'snooze'; clientCompanyId?: string; snoozeDays?: number }
    }) => pursuitsApi.update(id, body),
    onSuccess: () => {
      setErrText('')
      setClientPickerFor(null)
      qc.invalidateQueries({ queryKey: ['pursuits', 'REVIEWING'] })
      qc.invalidateQueries({ queryKey: ['pursuit-award-prompts'] })
    },
    onError: (err: any, vars) => {
      if (err?.response?.data?.code === 'CLIENT_REQUIRED') {
        // Several clients: ask which one the bid was for.
        setClientPickerFor(vars.id)
        return
      }
      setErrText(err?.response?.data?.error ?? 'The update did not save. Try again.')
    },
  })

  if (isLoading) return null

  const shown = expanded ? pursuits : pursuits.slice(0, 5)
  const daysLeft = (deadline: string) => Math.ceil((new Date(deadline).getTime() - Date.now()) / 86_400_000)

  return (
    <div>
      {errText && <p role="alert" className="mb-3 text-sm" style={{ color: 'var(--danger-text)' }}>{errText}</p>}

      {prompts.length > 0 && (
        <ul className="mb-4 space-y-2">
          {prompts.map((p) => (
            <li key={p.pursuit.id} className="flex flex-wrap items-center gap-3 rounded-2xl px-4 py-3" style={{ background: 'var(--accent-soft)' }}>
              <div className="flex-1 min-w-[220px]">
                <p className="text-[14px] font-semibold" style={{ color: 'var(--text)' }}>
                  An award was posted for {p.pursuit.opportunity.solicitationNumber}. Did you win?
                </p>
                <p className="text-[13px] truncate" style={{ color: 'var(--text-muted)' }}>
                  {plainText(p.pursuit.opportunity.title)}
                  {p.awardNotice?.historicalWinner ? `, awarded to ${p.awardNotice.historicalWinner}` : ''}
                </p>
              </div>
              <Link to="/submissions" className="v3-pill v3-pill-dark v3-pill-sm">Record the result</Link>
            </li>
          ))}
        </ul>
      )}

      {pursuits.length === 0 && prompts.length === 0 ? (
        <div className="v3-surface flex flex-wrap items-center justify-between gap-4">
          <p className="text-[15px]" style={{ color: 'var(--text-muted)' }}>
            No bids are waiting for a decision. Open a solicitation to start tracking it.
          </p>
          <Link to="/opportunities" className="v3-pill v3-pill-light">Browse opportunities</Link>
        </div>
      ) : (
        <ul className="v3-rule-list" style={{ borderTop: '1px solid var(--line-strong)', borderBottom: '1px solid var(--line-strong)' }}>
          {shown.map((p) => {
            const dl = p.opportunity.responseDeadline ? daysLeft(p.opportunity.responseDeadline) : null
            const win = Math.round((p.opportunity.probabilityScore ?? 0) * 100)
            return (
              <li key={p.id} className="py-5">
                <div className="grid gap-4 items-center md:grid-cols-[minmax(0,1.3fr)_minmax(0,1fr)_auto]">
                  <Link to={`/opportunities/${p.opportunity.id}`} className="v3-h3 hover:underline underline-offset-4 line-clamp-2" style={{ color: 'var(--text)' }}>
                    {plainText(p.opportunity.title)}
                  </Link>
                  <div className="min-w-0">
                    <p className="text-[14px]" style={{ color: dl != null && dl <= 3 ? 'var(--danger-text)' : 'var(--text-muted)' }}>
                      {dl == null ? 'No deadline on the notice.' : dl <= 0 ? 'The deadline has passed.' : `Decide before the deadline in ${dl} day${dl === 1 ? '' : 's'}.`}
                    </p>
                    <div className="mt-2 flex flex-wrap gap-1.5">
                      {p.opportunity.agency && <span className="v3-tag max-w-[260px]" title={p.opportunity.agency}>{p.opportunity.agency.split('.').filter(Boolean).pop()}</span>}
                      <span className="v3-tag tabular-nums">{win}% win</span>
                    </div>
                  </div>
                  <div className="flex flex-wrap gap-2 md:justify-end">
                    <button type="button" onClick={() => updateMut.mutate({ id: p.id, body: { action: 'submitted' } })} disabled={updateMut.isPending} className="v3-pill v3-pill-dark v3-pill-sm">Submitted</button>
                    <button type="button" onClick={() => updateMut.mutate({ id: p.id, body: { action: 'passed' } })} disabled={updateMut.isPending} className="v3-pill v3-pill-light v3-pill-sm">Passed</button>
                    <button type="button" onClick={() => updateMut.mutate({ id: p.id, body: { action: 'snooze' } })} disabled={updateMut.isPending} className="v3-pill v3-pill-light v3-pill-sm">Later</button>
                  </div>
                </div>

                {clientPickerFor === p.id && (
                  <div className="mt-3 flex flex-wrap items-center gap-2">
                    <span className="text-[13px]" style={{ color: 'var(--text-muted)' }}>Which client submitted this bid?</span>
                    {clients.map((c: any) => (
                      <button key={c.id} type="button" disabled={updateMut.isPending} className="v3-tag hover:bg-[color:var(--hover)]"
                        onClick={() => updateMut.mutate({ id: p.id, body: { action: 'submitted', clientCompanyId: c.id } })}>
                        {c.name}
                      </button>
                    ))}
                  </div>
                )}
              </li>
            )
          })}
        </ul>
      )}
      {pursuits.length > 5 && (
        <button type="button" onClick={() => setExpanded((e) => !e)} className="v3-pill v3-pill-light v3-pill-sm mt-4">
          {expanded ? 'Show fewer' : `Show all ${pursuits.length}`}
        </button>
      )}
    </div>
  )
}
