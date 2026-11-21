import { useState } from 'react'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { rewardsApi, clientsApi } from '../services/api'
import { PageHeader, formatCurrency, StatCard, StatusPill, EmptyState, SkeletonRows } from '../components/ui'
import { humanize } from '../lib/humanize'
import {
  Gift,
  CheckCircle,
  Star,
  Trophy,
  Zap,
  RefreshCw,
  Plus,
} from 'lucide-react'

type RewardType = 'SUBSCRIPTION_CREDIT' | 'FEE_DISCOUNT' | 'PERK' | 'CUSTOM'

interface Reward {
  id: string
  rewardType: RewardType
  description: string
  value?: number | null
  percentDiscount?: number | null
  expiresAt?: string | null
  redeemedAt?: string | null
  triggerReason?: string | null
  clientCompanyId: string
  clientCompany?: { name: string }
}

interface Client {
  id: string
  name: string
}

function getRewardStatus(reward: Reward): 'Active' | 'Redeemed' | 'Expired' {
  if (reward.redeemedAt) return 'Redeemed'
  if (reward.expiresAt && new Date(reward.expiresAt) < new Date()) return 'Expired'
  return 'Active'
}

function StatusBadge({ status }: { status: 'Active' | 'Redeemed' | 'Expired' }) {
  return <StatusPill status={status} />
}

export function RewardsPage() {
  const queryClient = useQueryClient()

  const [filterClientId, setFilterClientId] = useState('')
  const [form, setForm] = useState({
    clientCompanyId: '',
    rewardType: 'SUBSCRIPTION_CREDIT' as RewardType,
    description: '',
    value: '',
    percentDiscount: '',
    expiresAt: '',
  })
  const [evaluatingAll, setEvaluatingAll] = useState(false)
  const [evalMsg, setEvalMsg] = useState<string | null>(null)

  const { data: rewardsData, isLoading: rewardsLoading } = useQuery({
    queryKey: ['rewards', filterClientId],
    queryFn: () =>
      rewardsApi.list(filterClientId ? { clientCompanyId: filterClientId } : undefined),
  })

  const { data: clientsData } = useQuery({
    queryKey: ['clients-list'],
    queryFn: () => clientsApi.list(),
  })

  const clients: Client[] = clientsData?.data ?? []
  const rewards: Reward[] = rewardsData?.data ?? []

  const createMutation = useMutation({
    mutationFn: (data: any) => rewardsApi.create(data),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['rewards'] })
      setForm({
        clientCompanyId: '',
        rewardType: 'SUBSCRIPTION_CREDIT',
        description: '',
        value: '',
        percentDiscount: '',
        expiresAt: '',
      })
    },
  })

  const redeemMutation = useMutation({
    mutationFn: (id: string) => rewardsApi.redeem(id),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['rewards'] })
    },
  })

  const handleEvaluateAll = async () => {
    setEvaluatingAll(true)
    setEvalMsg(null)
    let count = 0
    for (const client of clients) {
      try {
        await rewardsApi.evaluate(client.id)
        count++
      } catch {
        // continue
      }
    }
    await queryClient.invalidateQueries({ queryKey: ['rewards'] })
    setEvaluatingAll(false)
    setEvalMsg(`Evaluated ${count} client(s). Rewards ledger updated.`)
    setTimeout(() => setEvalMsg(null), 5000)
  }

  const handleGrant = () => {
    if (!form.clientCompanyId || !form.description) return
    createMutation.mutate({
      clientCompanyId: form.clientCompanyId,
      rewardType: form.rewardType,
      description: form.description,
      value: form.value ? parseFloat(form.value) : undefined,
      percentDiscount: form.percentDiscount ? parseFloat(form.percentDiscount) : undefined,
      expiresAt: form.expiresAt || undefined,
      triggerReason: 'MANUAL',
    })
  }

  // KPI stats
  const totalRewards = rewards.length
  const activeRewards = rewards.filter((r) => getRewardStatus(r) === 'Active').length
  const redeemedRewards = rewards.filter((r) => getRewardStatus(r) === 'Redeemed').length
  const totalDollarValue = rewards.reduce((sum, r) => sum + (r.value ?? 0), 0)

  const filteredRewards = filterClientId
    ? rewards.filter((r) => r.clientCompanyId === filterClientId)
    : rewards

  const RULES = [
    {
      id: 'FIRST_ONTIME',
      icon: <CheckCircle className="w-5 h-5" />,
      title: 'First on-time submission',
      badge: 'FIRST_ONTIME',
      description:
        'Triggered when a client records their very first on-time submission. Grants a $50 subscription credit valid for 90 days.',
      reward: '$50 subscription credit · 90-day expiry',
      color: 'green',
    },
    {
      id: '5_CONSECUTIVE_ONTIME',
      icon: <Star className="w-5 h-5" />,
      title: '5 consecutive on-time submissions',
      badge: '5_CONSECUTIVE_ONTIME',
      description:
        'Triggered when a client achieves 5 consecutive on-time submissions without any late submissions in between. Encourages consistent compliance.',
      reward: '10% late-fee discount · 6-month validity',
      color: 'yellow',
    },
    {
      id: 'PERFECT_COMPLIANCE',
      icon: <Trophy className="w-5 h-5" />,
      title: 'Perfect compliance',
      badge: 'PERFECT_COMPLIANCE',
      description:
        'Triggered when a client maintains a 100% on-time submission rate with at least 10 total submissions. Recognizes sustained excellence.',
      reward: 'Priority matching perk (permanent)',
      color: 'blue',
    },
  ]

  return (
    <div>
      <PageHeader
        title="Rewards"
        subtitle="Manage compliance incentives, loyalty rewards, and client perks"
      />

      {/* ── Section 1: Stats bar ── */}
      <div className="stagger grid grid-cols-2 lg:grid-cols-4 gap-4 mb-8">
        <StatCard label="Total rewards" value={totalRewards} tone="neutral" icon={<Gift className="w-4 h-4" />} />
        <StatCard label="Active" value={activeRewards} tone="neutral" icon={<Zap className="w-4 h-4" />} />
        <StatCard label="Redeemed" value={redeemedRewards} tone="neutral" icon={<CheckCircle className="w-4 h-4" />} />
        <StatCard label="Total dollar value" value={formatCurrency(totalDollarValue)} tone="neutral" icon={<Trophy className="w-4 h-4" />} />
      </div>

      {/* ── Section 2: Automatic Rules ── */}
      <div className="mb-8">
        <div className="flex flex-wrap items-center justify-between gap-3 mb-4">
          <h2 className="text-base font-semibold text-gray-100">Automatic reward rules</h2>
          <button
            onClick={handleEvaluateAll}
            disabled={evaluatingAll || clients.length === 0}
            className="btn-primary disabled:opacity-50"
          >
            <RefreshCw className={`w-4 h-4 ${evaluatingAll ? 'animate-spin' : ''}`} />
            {evaluatingAll ? 'Evaluating…' : 'Evaluate all clients'}
          </button>
        </div>

        {evalMsg && (
          <div className="mb-4 px-4 py-3 bg-[var(--success-bg)] text-[color:var(--success-text)] text-sm rounded-2xl animate-fade-up">
            {evalMsg}
          </div>
        )}

        <div className="stagger grid grid-cols-1 md:grid-cols-3 gap-4">
          {RULES.map((rule) => (
            <div key={rule.id} className="card flex flex-col">
              <div className="flex items-center gap-2.5 mb-3">
                <span className="tile tile-sm tile-neutral">{rule.icon}</span>
                <h3 className="font-semibold text-gray-100 text-base">{rule.title}</h3>
              </div>
              <p className="text-[13px] text-gray-400 mb-3 leading-relaxed flex-1">{rule.description}</p>
              <div className="flex items-center gap-2 pt-3" style={{ borderTop: '1px solid var(--line)' }}>
                <Gift className="w-3.5 h-3.5 text-gray-500 flex-shrink-0" />
                <p className="text-[13px] text-gray-200 font-medium">{rule.reward}</p>
              </div>
            </div>
          ))}
        </div>
      </div>

      {/* ── Section 3: Manual Grant Form ── */}
      <div className="card mb-8">
        <div className="flex items-center gap-2.5 mb-5">
          <span className="tile tile-sm"><Plus className="w-3.5 h-3.5" /></span>
          <h2 className="text-xl font-semibold text-gray-100">Manual grant</h2>
        </div>
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4 mb-4">
          {/* Client */}
          <div>
            <label className="label">Client *</label>
            <select
              value={form.clientCompanyId}
              onChange={(e) => setForm((f) => ({ ...f, clientCompanyId: e.target.value }))}
              className="input"
            >
              <option value="">Select client…</option>
              {clients.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.name}
                </option>
              ))}
            </select>
          </div>

          {/* Reward Type */}
          <div>
            <label className="label">Reward type *</label>
            <select
              value={form.rewardType}
              onChange={(e) => setForm((f) => ({ ...f, rewardType: e.target.value as RewardType }))}
              className="input"
            >
              <option value="SUBSCRIPTION_CREDIT">Subscription credit</option>
              <option value="FEE_DISCOUNT">Fee discount</option>
              <option value="PERK">Perk</option>
              <option value="CUSTOM">Custom</option>
            </select>
          </div>

          {/* Description */}
          <div>
            <label className="label">Description *</label>
            <input
              type="text"
              value={form.description}
              onChange={(e) => setForm((f) => ({ ...f, description: e.target.value }))}
              placeholder="e.g. Q1 loyalty bonus"
              className="input"
            />
          </div>

          {/* Dollar Value */}
          <div>
            <label className="label">Dollar value (optional)</label>
            <input
              type="number"
              min="0"
              step="0.01"
              value={form.value}
              onChange={(e) => setForm((f) => ({ ...f, value: e.target.value }))}
              placeholder="50.00"
              className="input"
            />
          </div>

          {/* Percent Discount */}
          <div>
            <label className="label">Percent discount (optional)</label>
            <input
              type="number"
              min="0"
              max="100"
              step="0.1"
              value={form.percentDiscount}
              onChange={(e) => setForm((f) => ({ ...f, percentDiscount: e.target.value }))}
              placeholder="10"
              className="input"
            />
          </div>

          {/* Expires */}
          <div>
            <label className="label">Expires (optional)</label>
            <input
              type="date"
              value={form.expiresAt}
              onChange={(e) => setForm((f) => ({ ...f, expiresAt: e.target.value }))}
              className="input"
            />
          </div>
        </div>

        <div className="flex flex-wrap items-center gap-3">
          <button
            onClick={handleGrant}
            disabled={createMutation.isPending || !form.clientCompanyId || !form.description}
            className="btn-primary disabled:opacity-50"
          >
            <Gift className="w-4 h-4" />
            {createMutation.isPending ? 'Granting…' : 'Grant reward'}
          </button>
          {createMutation.isSuccess && (
            <span className="text-xs text-[color:var(--success-text)] flex items-center gap-1">
              <CheckCircle className="w-3.5 h-3.5" /> Reward granted successfully
            </span>
          )}
          {createMutation.isError && (
            <span className="text-xs text-[color:var(--danger-text)]">Failed to grant reward. Please try again.</span>
          )}
        </div>
      </div>

      {/* ── Section 4: Rewards Ledger ── */}
      <div className="card">
        <div className="flex flex-wrap items-center justify-between gap-3 mb-4">
          <h2 className="text-xl font-semibold text-gray-100">Rewards ledger</h2>
          <div className="flex items-center gap-2 min-w-0">
            <label className="label mb-0 whitespace-nowrap">Filter by client:</label>
            <select
              value={filterClientId}
              onChange={(e) => setFilterClientId(e.target.value)}
              className="input w-auto py-1.5"
            >
              <option value="">All clients</option>
              {clients.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.name}
                </option>
              ))}
            </select>
          </div>
        </div>

        {rewardsLoading ? (
          <div>
            <span className="sr-only">Loading…</span>
            <SkeletonRows rows={5} cols={6} />
          </div>
        ) : filteredRewards.length === 0 ? (
          <EmptyState
            message="No rewards found. Grant rewards manually or run evaluation above."
            icon={<Gift className="w-5 h-5" />}
            hint={null}
          />
        ) : (
          <div className="table-wrap">
            <table className="data-table">
              <thead>
                <tr>
                  <th>Client</th>
                  <th>Type</th>
                  <th>Description</th>
                  <th className="text-right">Value</th>
                  <th>Expires</th>
                  <th>Status</th>
                  <th>Actions</th>
                </tr>
              </thead>
              <tbody>
                {filteredRewards.map((reward) => {
                  const status = getRewardStatus(reward)
                  const clientName =
                    reward.clientCompany?.name ??
                    clients.find((c) => c.id === reward.clientCompanyId)?.name ??
                    reward.clientCompanyId.slice(0, 8)
                  return (
                    <tr key={reward.id}>
                      <td className="font-medium text-xs text-gray-200">{clientName}</td>
                      <td>
                        <span className="chip chip-neutral">
                          {humanize(reward.rewardType)}
                        </span>
                      </td>
                      <td className="text-xs text-gray-400 max-w-[200px] truncate">
                        {reward.description}
                      </td>
                      <td className="text-xs text-right tabular-nums">
                        {reward.value != null
                          ? formatCurrency(reward.value)
                          : reward.percentDiscount != null
                          ? `${reward.percentDiscount}%`
                          : '—'}
                      </td>
                      <td className="text-xs text-gray-400 tabular-nums">
                        {reward.expiresAt
                          ? new Date(reward.expiresAt).toLocaleDateString()
                          : '—'}
                      </td>
                      <td>
                        <StatusBadge status={status} />
                      </td>
                      <td>
                        {status === 'Active' && (
                          <button
                            onClick={() => redeemMutation.mutate(reward.id)}
                            disabled={redeemMutation.isPending}
                            className="btn-secondary btn-sm disabled:opacity-50"
                          >
                            Redeem
                          </button>
                        )}
                      </td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  )
}
