import { useMemo, useState } from 'react'
import { Link, useParams } from 'react-router-dom'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import {
  ArrowLeft,
  Building2,
  Copy,
  ExternalLink,
  Globe,
  Loader,
  Mail,
  MapPin,
  Phone,
  RefreshCw,
  Sparkles,
  Users,
} from 'lucide-react'
import { recipientApi } from '../services/api'
import { useAuth } from '../hooks/useAuth'
import { useBranding } from '../hooks/useBranding'
import { PageHeader, formatCurrency } from '../components/ui'
import { normalizeUrl } from '../lib/url'
import { useTabParam } from '../hooks/useTabParam'

interface RecipientProfileData {
  uei: string
  legalName: string | null
  cageCode: string | null
  samRegStatus: string | null
  samRegExpiry: string | null
  website: string | null
  phone: string | null
  address: {
    street: string | null
    city: string | null
    state: string | null
    zip: string | null
  }
  naicsCodes: string[] | null
  certifications: {
    sdvosb: boolean
    wosb: boolean
    hubzone: boolean
    smallBusiness: boolean
  }
  samFetchedAt: string | null
  contacts: ContactRow[]
  contactsProvider: string | null
  contactsFetchedAt: string | null
  providers: { key: string; label: string; available: boolean }[]
}

interface ContactRow {
  name: string | null
  title: string | null
  email: string | null
  phone: string | null
  source: string
  role?: string | null
}

interface SubawardRow {
  id: string
  subAmount: number
  subActionDate: string | null
  subNaics: string | null
  subDescription: string | null
  primeAwardId: string
  primeRecipientName: string | null
  primeRecipientUei: string | null
  agencyToptierName: string | null
  agencyToptierCode: string | null
}

interface PrimeAwardRow {
  id: string
  usaspendingAwardId: string
  agencyToptierName: string | null
  agencyToptierCode: string | null
  naics: string | null
  pscCode: string | null
  totalObligation: number
  baseAndAllOptions: number
  awardDate: string | null
  periodOfPerformanceStart: string | null
  periodOfPerformanceEnd: string | null
  setAsideType: string | null
}

type TabKey = 'subawards' | 'primes' | 'contacts'

export default function RecipientProfile() {
  const { uei: rawUei } = useParams<{ uei: string }>()
  const uei = (rawUei ?? '').trim().toUpperCase()
  const { firm } = useAuth()
  const { branding } = useBranding(firm?.id)
  const queryClient = useQueryClient()
  const [tab, setTab] = useTabParam(['subawards', 'primes', 'contacts'] as const, 'subawards')

  const profileQ = useQuery({
    queryKey: ['recipient', 'profile', uei],
    queryFn: () =>
      recipientApi.profile(uei) as Promise<{ success: boolean; data: RecipientProfileData; error?: string }>,
    enabled: !!uei,
  })

  const subawardsQ = useQuery({
    queryKey: ['recipient', 'subawards', uei],
    queryFn: () =>
      recipientApi.subawards(uei) as Promise<{
        success: boolean
        data: { rows: SubawardRow[]; totals: { count: number; totalAmount: number } }
      }>,
    enabled: !!uei,
  })

  const primesQ = useQuery({
    queryKey: ['recipient', 'primes', uei],
    queryFn: () =>
      recipientApi.primes(uei) as Promise<{
        success: boolean
        data: { rows: PrimeAwardRow[]; totals: { count: number; totalAmount: number } }
      }>,
    enabled: !!uei,
  })

  const refreshMut = useMutation({
    mutationFn: () => recipientApi.profile(uei, { refresh: true }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['recipient', 'profile', uei] })
    },
  })

  const enrichMut = useMutation({
    mutationFn: (provider?: string) => recipientApi.enrichContacts(uei, provider),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['recipient', 'profile', uei] })
    },
  })

  const profile = profileQ.data?.data ?? null
  const subawards = subawardsQ.data?.data
  const primes = primesQ.data?.data

  const certs = useMemo(() => {
    if (!profile) return []
    const out: { key: string; label: string; tone: string }[] = []
    if (profile.certifications.sdvosb) out.push({ key: 'sdvosb', label: 'SDVOSB', tone: 'amber' })
    if (profile.certifications.wosb) out.push({ key: 'wosb', label: 'WOSB', tone: 'pink' })
    if (profile.certifications.hubzone) out.push({ key: 'hubzone', label: 'HUBZone', tone: 'blue' })
    if (profile.certifications.smallBusiness) out.push({ key: 'sb', label: 'Small Business', tone: 'emerald' })
    return out
  }, [profile])

  if (!uei) {
    return (
      <div className="p-6">
        <PageHeader title="Recipient" subtitle="Missing UEI in URL" />
      </div>
    )
  }

  return (
    <div className="p-6 space-y-6">
      <div>
        <Link
          to="/agency"
          className="inline-flex items-center gap-1.5 text-xs text-gray-500 hover:text-gray-300 transition-colors"
        >
          <ArrowLeft className="w-3.5 h-3.5" />
          Back to Agency view
        </Link>
      </div>

      {/* Header */}
      <div className="bg-gray-900 border border-gray-800 rounded-xl p-5">
        <div className="flex items-start justify-between gap-4">
          <div className="flex items-start gap-3 min-w-0">
            <div
              className="w-10 h-10 rounded-lg flex items-center justify-center flex-shrink-0"
              style={{ background: `${branding.secondaryColor}26`, border: `1px solid ${branding.secondaryColor}66` }}
            >
              <Building2 className="w-5 h-5" style={{ color: branding.secondaryColor }} />
            </div>
            <div className="min-w-0">
              <h1 className="text-xl font-semibold text-gray-100 truncate">
                {profileQ.isLoading ? 'Loading…' : profile?.legalName || `Recipient ${uei}`}
              </h1>
              <div className="mt-1 flex flex-wrap items-center gap-2">
                <UeiBadge uei={uei} />
                {profile?.cageCode && (
                  <span className="text-[10px] px-1.5 py-0.5 rounded border border-gray-700 bg-gray-800 text-gray-300 font-mono">
                    CAGE {profile.cageCode}
                  </span>
                )}
                {profile?.samRegStatus && (
                  <span
                    className={`text-[10px] px-1.5 py-0.5 rounded border font-mono ${
                      profile.samRegStatus.toLowerCase() === 'active'
                        ? 'bg-emerald-950/60 border-emerald-800 text-emerald-300'
                        : 'bg-red-950/60 border-red-800 text-red-300'
                    }`}
                  >
                    SAM {profile.samRegStatus}
                  </span>
                )}
                {certs.map((c) => (
                  <span
                    key={c.key}
                    className={`text-[10px] px-1.5 py-0.5 rounded border font-mono ${toneClasses(c.tone)}`}
                  >
                    {c.label}
                  </span>
                ))}
              </div>
            </div>
          </div>

          <button
            type="button"
            onClick={() => refreshMut.mutate()}
            disabled={refreshMut.isPending}
            className="text-xs px-3 py-1.5 rounded bg-gray-800 hover:bg-gray-700 text-gray-300 border border-gray-700 transition-colors inline-flex items-center gap-1.5 disabled:opacity-50"
            title="Re-fetch from SAM.gov"
          >
            {refreshMut.isPending ? (
              <Loader className="w-3.5 h-3.5 animate-spin" />
            ) : (
              <RefreshCw className="w-3.5 h-3.5" />
            )}
            Refresh
          </button>
        </div>

        {profileQ.error && (
          <p className="mt-3 text-xs text-red-400">
            Failed to load profile. {String((profileQ.error as Error).message ?? '')}
          </p>
        )}

        {/* Company info row */}
        {profile && (
          <div className="mt-5 grid grid-cols-1 md:grid-cols-3 gap-4 text-sm">
            <InfoBlock icon={MapPin} label="Address">
              {formatAddress(profile.address)}
            </InfoBlock>
            <InfoBlock icon={Globe} label="Website">
              {profile.website ? (
                <a
                  href={normalizeUrl(profile.website)}
                  target="_blank"
                  rel="noreferrer"
                  className="text-blue-400 hover:text-blue-300 inline-flex items-center gap-1 truncate"
                >
                  <span className="truncate">{profile.website}</span>
                  <ExternalLink className="w-3 h-3 flex-shrink-0" />
                </a>
              ) : (
                <span className="text-gray-500">—</span>
              )}
            </InfoBlock>
            <InfoBlock icon={Phone} label="Phone">
              {profile.phone || <span className="text-gray-500">—</span>}
            </InfoBlock>
          </div>
        )}

        {profile?.naicsCodes && profile.naicsCodes.length > 0 && (
          <div className="mt-4">
            <div className="text-[10px] uppercase tracking-widest text-gray-500 mb-2">NAICS codes</div>
            <div className="flex flex-wrap gap-1.5">
              {profile.naicsCodes.slice(0, 30).map((n) => (
                <span
                  key={n}
                  className="text-[10px] px-1.5 py-0.5 rounded border border-gray-700 bg-gray-800 text-gray-300 font-mono"
                >
                  {n}
                </span>
              ))}
              {profile.naicsCodes.length > 30 && (
                <span className="text-[10px] text-gray-500">+{profile.naicsCodes.length - 30} more</span>
              )}
            </div>
          </div>
        )}

        {profile?.samFetchedAt && (
          <p className="mt-4 text-[10px] text-gray-600">
            SAM data cached {formatRelative(profile.samFetchedAt)}
          </p>
        )}
      </div>

      {/* Tabs */}
      <div className="flex items-center gap-1 border-b border-gray-800">
        <TabButton active={tab === 'subawards'} onClick={() => setTab('subawards')}>
          Subawards{subawards ? ` · ${subawards.totals.count}` : ''}
        </TabButton>
        <TabButton active={tab === 'primes'} onClick={() => setTab('primes')}>
          Prime contracts{primes ? ` · ${primes.totals.count}` : ''}
        </TabButton>
        <TabButton active={tab === 'contacts'} onClick={() => setTab('contacts')}>
          Contacts{profile?.contacts?.length ? ` · ${profile.contacts.length}` : ''}
        </TabButton>
      </div>

      {/* Tab content */}
      {tab === 'subawards' && (
        <SubawardsPanel data={subawards?.rows ?? []} loading={subawardsQ.isLoading} totals={subawards?.totals} />
      )}
      {tab === 'primes' && (
        <PrimesPanel data={primes?.rows ?? []} loading={primesQ.isLoading} totals={primes?.totals} />
      )}
      {tab === 'contacts' && (
        <ContactsPanel
          profile={profile}
          loading={profileQ.isLoading}
          enrichLoading={enrichMut.isPending}
          enrichError={enrichMut.error ? String((enrichMut.error as Error).message) : null}
          onEnrich={(provider) => enrichMut.mutate(provider)}
          branding={branding}
        />
      )}
    </div>
  )
}

// ---- Subcomponents ----------------------------------------------------------

function TabButton({
  active,
  onClick,
  children,
}: {
  active: boolean
  onClick: () => void
  children: React.ReactNode
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={`px-3 py-2 text-sm transition-colors border-b-2 -mb-px ${
        active
          ? 'border-amber-500 text-gray-100'
          : 'border-transparent text-gray-500 hover:text-gray-300'
      }`}
    >
      {children}
    </button>
  )
}

function InfoBlock({
  icon: Icon,
  label,
  children,
}: {
  icon: React.ComponentType<{ className?: string }>
  label: string
  children: React.ReactNode
}) {
  return (
    <div>
      <div className="flex items-center gap-1.5 text-[10px] uppercase tracking-widest text-gray-500 mb-1">
        <Icon className="w-3 h-3" />
        {label}
      </div>
      <div className="text-sm text-gray-300 break-words">{children}</div>
    </div>
  )
}

function UeiBadge({ uei }: { uei: string }) {
  const [copied, setCopied] = useState(false)
  return (
    <button
      type="button"
      onClick={() => {
        navigator.clipboard?.writeText(uei).then(() => {
          setCopied(true)
          window.setTimeout(() => setCopied(false), 1200)
        })
      }}
      className="text-[10px] px-1.5 py-0.5 rounded border border-gray-700 bg-gray-800 text-gray-300 font-mono inline-flex items-center gap-1 hover:bg-gray-700 transition-colors"
      title="Copy UEI"
    >
      UEI {uei}
      <Copy className="w-2.5 h-2.5 text-gray-500" />
      {copied && <span className="text-emerald-400 ml-1">copied</span>}
    </button>
  )
}

function SubawardsPanel({
  data,
  loading,
  totals,
}: {
  data: SubawardRow[]
  loading: boolean
  totals?: { count: number; totalAmount: number }
}) {
  if (loading) return <CenteredSpinner />
  if (data.length === 0) {
    return (
      <EmptyMsg msg="No subawards on record for this UEI. The WinnersIntel staging tables only cover the most recent refresh batches." />
    )
  }
  return (
    <div className="space-y-3">
      {totals && (
        <div className="flex items-center gap-4 text-xs text-gray-400">
          <span>{totals.count} subawards</span>
          <span className="text-gray-600">·</span>
          <span>Total {formatCurrency(totals.totalAmount)}</span>
        </div>
      )}
      <div className="bg-gray-900 border border-gray-800 rounded-xl overflow-hidden">
        <table className="w-full text-sm">
          <thead className="bg-gray-950/40 text-[10px] uppercase tracking-widest text-gray-500">
            <tr>
              <th className="text-left px-4 py-2">Prime</th>
              <th className="text-left px-4 py-2">Agency</th>
              <th className="text-left px-4 py-2">NAICS</th>
              <th className="text-right px-4 py-2">Amount</th>
              <th className="text-right px-4 py-2">Action date</th>
            </tr>
          </thead>
          <tbody>
            {data.map((r) => (
              <tr key={r.id} className="border-t border-gray-800 hover:bg-gray-800/40">
                <td className="px-4 py-2 text-gray-200 truncate max-w-[18rem]">
                  {r.primeRecipientUei ? (
                    <Link to={`/recipient/${r.primeRecipientUei}`} className="hover:text-amber-300 transition-colors">
                      {r.primeRecipientName || r.primeRecipientUei}
                    </Link>
                  ) : (
                    r.primeRecipientName || '—'
                  )}
                </td>
                <td className="px-4 py-2 text-gray-400 truncate max-w-[14rem] text-xs">
                  {r.agencyToptierName || r.agencyToptierCode || '—'}
                </td>
                <td className="px-4 py-2 text-gray-400 font-mono text-xs">{r.subNaics || '—'}</td>
                <td className="px-4 py-2 text-right text-gray-300">{formatCurrency(r.subAmount)}</td>
                <td className="px-4 py-2 text-right text-gray-500 text-xs">{formatDate(r.subActionDate)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  )
}

function PrimesPanel({
  data,
  loading,
  totals,
}: {
  data: PrimeAwardRow[]
  loading: boolean
  totals?: { count: number; totalAmount: number }
}) {
  if (loading) return <CenteredSpinner />
  if (data.length === 0) {
    return <EmptyMsg msg="This UEI has not appeared as a prime contractor in the current staging window." />
  }
  return (
    <div className="space-y-3">
      {totals && (
        <div className="flex items-center gap-4 text-xs text-gray-400">
          <span>{totals.count} prime awards</span>
          <span className="text-gray-600">·</span>
          <span>Total obligation {formatCurrency(totals.totalAmount)}</span>
        </div>
      )}
      <div className="bg-gray-900 border border-gray-800 rounded-xl overflow-hidden">
        <table className="w-full text-sm">
          <thead className="bg-gray-950/40 text-[10px] uppercase tracking-widest text-gray-500">
            <tr>
              <th className="text-left px-4 py-2">Agency</th>
              <th className="text-left px-4 py-2">NAICS / PSC</th>
              <th className="text-left px-4 py-2">Set-aside</th>
              <th className="text-right px-4 py-2">Obligated</th>
              <th className="text-right px-4 py-2">Award date</th>
            </tr>
          </thead>
          <tbody>
            {data.map((r) => (
              <tr key={r.id} className="border-t border-gray-800 hover:bg-gray-800/40">
                <td className="px-4 py-2 text-gray-300 truncate max-w-[16rem]">
                  {r.agencyToptierName || r.agencyToptierCode || '—'}
                </td>
                <td className="px-4 py-2 text-gray-400 font-mono text-xs">
                  {r.naics || '—'}
                  {r.pscCode ? <span className="text-gray-600"> · {r.pscCode}</span> : null}
                </td>
                <td className="px-4 py-2 text-gray-400 text-xs">{r.setAsideType || '—'}</td>
                <td className="px-4 py-2 text-right text-gray-300">{formatCurrency(r.totalObligation)}</td>
                <td className="px-4 py-2 text-right text-gray-500 text-xs">{formatDate(r.awardDate)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  )
}

function ContactsPanel({
  profile,
  loading,
  enrichLoading,
  enrichError,
  onEnrich,
  branding,
}: {
  profile: RecipientProfileData | null
  loading: boolean
  enrichLoading: boolean
  enrichError: string | null
  onEnrich: (provider?: string) => void
  branding: { primaryColor: string; secondaryColor: string }
}) {
  if (loading) return <CenteredSpinner />
  const contacts = profile?.contacts ?? []
  const providers = profile?.providers ?? []
  const availableProviders = providers.filter((p) => p.available)

  return (
    <div className="space-y-4">
      <div className="bg-gray-900 border border-gray-800 rounded-xl p-4 flex items-start justify-between gap-4">
        <div>
          <div className="text-sm text-gray-200 inline-flex items-center gap-2">
            <Users className="w-4 h-4 text-gray-500" />
            {contacts.length > 0
              ? `${contacts.length} contact${contacts.length === 1 ? '' : 's'} cached`
              : 'No contacts yet'}
          </div>
          {profile?.contactsFetchedAt && (
            <p className="text-[10px] text-gray-500 mt-1">
              Last enriched {formatRelative(profile.contactsFetchedAt)}
              {profile.contactsProvider ? ` via ${profile.contactsProvider}` : ''}
            </p>
          )}
          {availableProviders.length === 0 && (
            <p className="text-[10px] text-amber-400 mt-1">
              No contact provider is configured. Set SAM_API_KEY (or add Apollo / Hunter) to enable enrichment.
            </p>
          )}
        </div>
        <button
          type="button"
          onClick={() => onEnrich()}
          disabled={enrichLoading || availableProviders.length === 0}
          className="text-xs px-3 py-1.5 rounded inline-flex items-center gap-1.5 disabled:opacity-50 transition-colors"
          style={{
            background: `linear-gradient(90deg, ${branding.primaryColor}, ${branding.secondaryColor})`,
            color: '#0b0f1a',
            fontWeight: 600,
          }}
        >
          {enrichLoading ? <Loader className="w-3.5 h-3.5 animate-spin" /> : <Sparkles className="w-3.5 h-3.5" />}
          {contacts.length > 0 ? 'Refresh contacts' : 'Enrich contacts'}
        </button>
      </div>

      {enrichError && (
        <div className="bg-red-950/40 border border-red-800 text-red-300 rounded-lg p-3 text-xs">
          Enrichment failed: {enrichError}
        </div>
      )}

      {contacts.length === 0 ? (
        <EmptyMsg msg="No contacts cached. Click Enrich to pull from the configured provider (SAM.gov POCs by default)." />
      ) : (
        <div className="bg-gray-900 border border-gray-800 rounded-xl overflow-hidden">
          <table className="w-full text-sm">
            <thead className="bg-gray-950/40 text-[10px] uppercase tracking-widest text-gray-500">
              <tr>
                <th className="text-left px-4 py-2">Name</th>
                <th className="text-left px-4 py-2">Title / Role</th>
                <th className="text-left px-4 py-2">Email</th>
                <th className="text-left px-4 py-2">Phone</th>
                <th className="text-left px-4 py-2">Source</th>
              </tr>
            </thead>
            <tbody>
              {contacts.map((c, i) => (
                <tr key={`${c.email ?? c.name ?? 'c'}-${i}`} className="border-t border-gray-800 hover:bg-gray-800/40">
                  <td className="px-4 py-2 text-gray-200 truncate max-w-[14rem]">{c.name || '—'}</td>
                  <td className="px-4 py-2 text-gray-400 text-xs truncate max-w-[14rem]">
                    {c.title || c.role || '—'}
                  </td>
                  <td className="px-4 py-2">
                    {c.email ? (
                      <a
                        href={`mailto:${c.email}`}
                        className="text-blue-400 hover:text-blue-300 inline-flex items-center gap-1"
                      >
                        <Mail className="w-3 h-3" />
                        <span className="truncate max-w-[12rem]">{c.email}</span>
                      </a>
                    ) : (
                      <span className="text-gray-600">—</span>
                    )}
                  </td>
                  <td className="px-4 py-2 text-gray-400 text-xs">{c.phone || '—'}</td>
                  <td className="px-4 py-2 text-[10px] text-gray-500 font-mono">{c.source}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  )
}

// ---- Small helpers ----------------------------------------------------------

function CenteredSpinner() {
  return (
    <div className="flex items-center justify-center py-8 text-gray-500">
      <Loader className="w-5 h-5 animate-spin" />
    </div>
  )
}

function EmptyMsg({ msg }: { msg: string }) {
  return <div className="py-8 text-center text-sm text-gray-500">{msg}</div>
}

function toneClasses(tone: string): string {
  switch (tone) {
    case 'amber':
      return 'bg-amber-950/60 border-amber-800 text-amber-300'
    case 'pink':
      return 'bg-pink-950/60 border-pink-800 text-pink-300'
    case 'blue':
      return 'bg-blue-950/60 border-blue-800 text-blue-300'
    case 'emerald':
    default:
      return 'bg-emerald-950/60 border-emerald-800 text-emerald-300'
  }
}

function formatAddress(addr: RecipientProfileData['address']): React.ReactNode {
  const street = addr.street?.trim()
  const city = addr.city?.trim()
  const state = addr.state?.trim()
  const zip = addr.zip?.trim()
  const cityLine = [city, state].filter(Boolean).join(', ')
  const second = [cityLine, zip].filter(Boolean).join(' ')
  if (!street && !second) return <span className="text-gray-500">—</span>
  return (
    <>
      {street && <div>{street}</div>}
      {second && <div className="text-gray-400">{second}</div>}
    </>
  )
}

function formatDate(d: string | null): string {
  if (!d) return '—'
  const dt = new Date(d)
  if (isNaN(dt.getTime())) return '—'
  return dt.toLocaleDateString()
}

function formatRelative(d: string | null): string {
  if (!d) return ''
  const dt = new Date(d)
  if (isNaN(dt.getTime())) return ''
  const ms = Date.now() - dt.getTime()
  const days = Math.floor(ms / (1000 * 60 * 60 * 24))
  if (days <= 0) return 'today'
  if (days === 1) return 'yesterday'
  if (days < 30) return `${days}d ago`
  const months = Math.floor(days / 30)
  return `${months}mo ago`
}
