import { useState } from 'react'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { rewardsApi, clientsApi } from '../services/api'
import { PageHeader, Spinner, formatCurrency } from '../components/ui'
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
  const classes = {
    Active: 'bg-green-900/50 text-green-300 border border-green-700',
    Redeemed: 'bg-gray-700 text-gray-400 border border-gray-600',
    Expired: 'bg-red-900/50 text-red-300 border border-red-700',
  }[status]
  return (
    <span className={`text-xs px-2 py-0.5 rounded font-medium ${classes}`}>
      {status}
    </span>
  )
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
      icon: <CheckCircle className="w-5 h-5 text-green-400" />,
      title: 'First On-Time Submission',
      badge: 'FIRST_ONTIME',
      description:
        'Triggered when a client records their very first on-time submission. Grants a $50 subscription credit valid for 90 days.',
      reward: '$50 subscription credit · 90-day expiry',
      color: 'green',
    },
    {
      id: '5_CONSECUTIVE_ONTIME',
      icon: <Star className="w-5 h-5 text-yellow-400" />,
      title: '5 Consecutive On-Time Submissions',
      badge: '5_CONSECUTIVE_ONTIME',
      description:
        'Triggered when a client achieves 5 consecutive on-time submissions without any late submissions in between. Encourages consistent compliance.',
      reward: '10% late-fee discount · 6-month validity',
      color: 'yellow',
    },
    {
      id: 'PERFECT_COMPLIANCE',
      icon: <Trophy className="w-5 h-5 text-blue-400" />,
      title: 'Perfect Compliance',
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
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-4 mb-8">
        <div className="card">
          <div className="flex items-center gap-2 mb-1">
            <Gift className="w-4 h-4 text-purple-400" />
            <p className="text-xs text-gray-500 uppercase tracking-wider">Total Rewards</p>
          </div>
          <p className="text-3xl font-bold text-gray-100">{totalRewards}</p>
        </div>
        <div className="card">
          <div className="flex items-center gap-2 mb-1">
            <Zap className="w-4 h-4 text-green-400" />
            <p className="text-xs text-gray-500 uppercase tracking-wider">Active</p>
          </div>
          <p className="text-3xl font-bold text-green-400">{activeRewards}</p>
        </div>
        <div className="card">
          <div className="flex items-center gap-2 mb-1">
            <CheckCircle className="w-4 h-4 text-gray-400" />
            <p className="text-xs text-gray-500 uppercase tracking-wider">Redeemed</p>
          </div>
          <p className="text-3xl font-bold text-gray-300">{redeemedRewards}</p>
        </div>
        <div className="card">
          <div className="flex items-center gap-2 mb-1">
            <Trophy className="w-4 h-4 text-yellow-400" />
            <p className="text-xs text-gray-500 uppercase tracking-wider">Total Dollar Value</p>
          </div>
          <p className="text-3xl font-bold text-yellow-400">{formatCurrency(totalDollarValue)}</p>
        </div>
      </div>

      {/* ── Section 2: Automatic Rules ── */}
      <div className="mb-8">
        <div className="flex items-center justify-between mb-4">
          <h2 className="text-lg font-semibold text-gray-200">Automatic Reward Rules</h2>
          <button
            onClick={handleEvaluateAll}
            disabled={evaluatingAll || clients.length === 0}
            className="flex items-center gap-2 px-4 py-2 bg-blue-600 hover:bg-blue-700 disabled:opacity-50 text-white text-sm rounded-md transition-colors"
          >
            <RefreshCw className={`w-4 h-4 ${evaluatingAll ? 'animate-spin' : ''}`} />
            {evaluatingAll ? 'Evaluating…' : 'Evaluate All Clients'}
          </button>
        </div>

        {evalMsg && (
          <div className="mb-4 px-4 py-3 bg-green-900/30 border border-green-700 text-green-300 text-sm rounded-md">
            {evalMsg}
          </div>
        )}

        <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
          {RULES.map((rule) => (
            <div key={rule.id} className="card border border-gray-800">
              <div className="flex items-center gap-2 mb-3">
                {rule.icon}
                <h3 className="font-semibold text-gray-200 text-sm">{rule.title}</h3>
              </div>
              <span className="inline-block text-[10px] font-mono px-2 py-0.5 rounded bg-gray-700 text-gray-400 mb-3">
                {rule.badge}
              </span>
              <p className="text-xs text-gray-400 mb-3 leading-relaxed">{rule.description}</p>
              <div className="flex items-center gap-2 border-t border-gray-800 pt-3">
                <Gift className="w-3.5 h-3.5 text-gray-500 flex-shrink-0" />
                <p className="text-xs text-gray-300 font-medium">{rule.reward}</p>
              </div>
            </div>
          ))}
        </div>
      </div>

      {/* ── Section 3: Manual Grant Form ── */}
      <div className="card mb-8">
        <div className="flex items-center gap-2 mb-4">
          <Plus className="w-4 h-4 text-blue-400" />
          <h2 className="text-lg font-semibold text-gray-200">Manual Grant</h2>
        </div>
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4 mb-4">
          {/* Client */}
          <div>
            <label className="block text-xs text-gray-400 mb-1">Client *</label>
            <select
              value={form.clientCompanyId}
              onChange={(e) => setForm((f) => ({ ...f, clientCompanyId: e.target.value }))}
              className="w-full bg-gray-800 border border-gray-700 rounded-md px-3 py-2 text-sm text-gray-200 focus:outline-none focus:border-blue-500"
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
            <label className="block text-xs text-gray-400 mb-1">Reward Type *</label>
            <select
              value={form.rewardType}
              onChange={(e) => setForm((f) => ({ ...f, rewardType: e.target.value as RewardType }))}
              className="w-full bg-gray-800 border border-gray-700 rounded-md px-3 py-2 text-sm text-gray-200 focus:outline-none focus:border-blue-500"
            >
              <option value="SUBSCRIPTION_CREDIT">Subscription Credit</option>
              <option value="FEE_DISCOUNT">Fee Discount</option>
              <option value="PERK">Perk</option>
              <option value="CUSTOM">Custom</option>
            </select>
          </div>

          {/* Description */}
          <div>
            <label className="block text-xs text-gray-400 mb-1">Description *</label>
            <input
              type="text"
              value={form.description}
              onChange={(e) => setForm((f) => ({ ...f, description: e.target.value }))}
              placeholder="e.g. Q1 loyalty bonus"
              className="w-full bg-gray-800 border border-gray-700 rounded-md px-3 py-2 text-sm text-gray-200 focus:outline-none focus:border-blue-500 placeholder-gray-600"
            />
          </div>

          {/* Dollar Value */}
          <div>
            <label className="block text-xs text-gray-400 mb-1">Dollar Value (optional)</label>
            <input
              type="number"
              min="0"
              step="0.01"
              value={form.value}
              onChange={(e) => setForm((f) => ({ ...f, value: e.target.value }))}
              placeholder="50.00"
              className="w-full bg-gray-800 border border-gray-700 rounded-md px-3 py-2 text-sm text-gray-200 focus:outline-none focus:border-blue-500 placeholder-gray-600"
            />
          </div>

          {/* Percent Discount */}
          <div>
            <label className="block text-xs text-gray-400 mb-1">Percent Discount (optional)</label>
            <input
              type="number"
              min="0"
              max="100"
              step="0.1"
              value={form.percentDiscount}
              onChange={(e) => setForm((f) => ({ ...f, percentDiscount: e.target.value }))}
              placeholder="10"
              className="w-full bg-gray-800 border border-gray-700 rounded-md px-3 py-2 text-sm text-gray-200 focus:outline-none focus:border-blue-500 placeholder-gray-600"
            />
          </div>

          {/* Expires */}
          <div>
            <label className="block text-xs text-gray-400 mb-1">Expires (optional)</label>
            <input
              type="date"
              value={form.expiresAt}
              onChange={(e) => setForm((f) => ({ ...f, expiresAt: e.target.value }))}
              className="w-full bg-gray-800 border border-gray-700 rounded-md px-3 py-2 text-sm text-gray-200 focus:outline-none focus:border-blue-500"
            />
          </div>
        </div>

        <div className="flex items-center gap-3">
          <button
            onClick={handleGrant}
            disabled={createMutation.isPending || !form.clientCompanyId || !form.description}
            className="flex items-center gap-2 px-5 py-2 bg-blue-600 hover:bg-blue-700 disabled:opacity-50 text-white text-sm rounded-md transition-colors"
          >
            <Gift className="w-4 h-4" />
            {createMutation.isPending ? 'Granting…' : 'Grant Reward'}
          </button>
          {createMutation.isSuccess && (
            <span className="text-xs text-green-400 flex items-center gap-1">
              <CheckCircle className="w-3.5 h-3.5" /> Reward granted successfully
            </span>
          )}
          {createMutation.isError && (
            <span className="text-xs text-red-400">Failed to grant reward. Please try again.</span>
          )}
        </div>
      </div>

      {/* ── Section 4: Rewards Ledger ── */}
      <div className="card">
        <div className="flex items-center justify-between mb-4">
          <h2 className="text-lg font-semibold text-gray-200">Rewards Ledger</h2>
          <div className="flex items-center gap-2">
            <label className="text-xs text-gray-500">Filter by client:</label>
            <select
              value={filterClientId}
              onChange={(e) => setFilterClientId(e.target.value)}
              className="bg-gray-800 border border-gray-700 rounded-md px-3 py-1.5 text-sm text-gray-200 focus:outline-none focus:border-blue-500"
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
          <div className="flex justify-center py-12">
            <Spinner size="lg" />
          </div>
        ) : filteredRewards.length === 0 ? (
          <div className="text-center py-16 text-gray-500">
            <Gift className="w-10 h-10 mx-auto mb-3 opacity-30" />
            <p>No rewards found. Grant rewards manually or run evaluation above.</p>
          </div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="text-left text-xs text-gray-500 border-b border-gray-700">
                  <th className="pb-2 pr-4">Client</th>
                  <th className="pb-2 pr-4">Type</th>
                  <th className="pb-2 pr-4">Description</th>
                  <th className="pb-2 pr-4">Value</th>
                  <th className="pb-2 pr-4">Expires</th>
                  <th className="pb-2 pr-4">Status</th>
                  <th className="pb-2">Actions</th>
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
                    <tr key={reward.id} className="border-b border-gray-800 text-gray-300">
                      <td className="py-2.5 pr-4 font-medium text-xs">{clientName}</td>
                      <td className="py-2.5 pr-4">
                        <span className="text-xs font-mono px-1.5 py-0.5 rounded bg-gray-800 text-gray-400">
                          {reward.rewardType}
                        </span>
                      </td>
                      <td className="py-2.5 pr-4 text-xs text-gray-400 max-w-[200px] truncate">
                        {reward.description}
                      </td>
                      <td className="py-2.5 pr-4 text-xs">
                        {reward.value != null
                          ? formatCurrency(reward.value)
                          : reward.percentDiscount != null
                          ? `${reward.percentDiscount}%`
                          : '—'}
                      </td>
                      <td className="py-2.5 pr-4 text-xs text-gray-400">
                        {reward.expiresAt
                          ? new Date(reward.expiresAt).toLocaleDateString()
                          : '—'}
                      </td>
                      <td className="py-2.5 pr-4">
                        <StatusBadge status={status} />
                      </td>
                      <td className="py-2.5">
                        {status === 'Active' && (
                          <button
                            onClick={() => redeemMutation.mutate(reward.id)}
                            disabled={redeemMutation.isPending}
                            className="text-xs px-3 py-1 bg-purple-600 hover:bg-purple-700 disabled:opacity-50 text-white rounded transition-colors"
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
