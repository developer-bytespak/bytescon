// =============================================================
// RecipientSidePanel
//
// Slide-out drawer that mirrors AgencyView's existing Prime Drill-Down
// panel, but for sub-recipients clicked in the Recent Subawards table.
// Replaces the previous "Link to /recipient/:uei full page navigation"
// which felt like an unwanted page change for what should be an inline
// preview.
//
// Operator can still open the full /recipient/:uei page via the
// "Open full profile" link inside the panel for the cases where they
// actually want the full drill-down view.
// =============================================================

import { useEffect } from 'react'
import { useQuery } from '@tanstack/react-query'
import { Link } from 'react-router-dom'
import { X, ExternalLink, Loader, Building2, Phone, Globe, MapPin } from 'lucide-react'
import { recipientApi } from '../services/api'
import { normalizeUrl } from '../lib/url'

interface Props {
  uei: string
  onClose: () => void
}

interface RecipientAddress {
  street: string | null
  city: string | null
  state: string | null
  zip: string | null
}

interface ContactRow {
  name: string | null
  title: string | null
  email: string | null
  phone: string | null
  role?: string | null
}

interface RecipientProfileData {
  uei: string
  legalName: string | null
  cageCode: string | null
  samRegStatus: string | null
  samRegExpiry: string | null
  website: string | null
  phone: string | null
  address?: RecipientAddress
  naicsCodes?: string[] | null
  certifications?: {
    sdvosb?: boolean
    wosb?: boolean
    hubzone?: boolean
    smallBusiness?: boolean
  }
  sdvosb?: boolean
  wosb?: boolean
  hubzone?: boolean
  smallBusiness?: boolean
  contacts?: ContactRow[]
  contactsProvider?: string | null
}

export function RecipientSidePanel({ uei, onClose }: Props) {
  // Esc-to-close
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])

  const { data, isLoading, error } = useQuery({
    queryKey: ['recipient-profile', uei],
    queryFn: () => recipientApi.profile(uei) as Promise<{ data: RecipientProfileData }>,
    enabled: !!uei,
  })

  const profile = data?.data

  // Cert flags can ship either as a `certifications` block or as flat
  // top-level booleans depending on which version of the API responded.
  const sdvosb = profile?.certifications?.sdvosb ?? profile?.sdvosb ?? false
  const wosb = profile?.certifications?.wosb ?? profile?.wosb ?? false
  const hubzone = profile?.certifications?.hubzone ?? profile?.hubzone ?? false
  const smallBusiness = profile?.certifications?.smallBusiness ?? profile?.smallBusiness ?? false

  return (
    <div className="fixed inset-y-0 right-0 w-full max-w-xl bg-gray-950 border-l border-gray-800 shadow-2xl z-50 overflow-y-auto">
      {/* Header */}
      <div className="p-5 border-b border-gray-800 flex items-start justify-between gap-3">
        <div className="min-w-0">
          <p className="text-[10px] uppercase tracking-widest text-gray-500">Sub-Recipient Profile</p>
          <h3 className="text-base font-semibold text-gray-100 truncate">
            {profile?.legalName || uei}
          </h3>
          <p className="text-[10px] font-mono text-gray-500">{uei}</p>
        </div>
        <button
          onClick={onClose}
          className="shrink-0 text-gray-500 hover:text-gray-200"
          aria-label="Close"
        >
          <X className="w-5 h-5" />
        </button>
      </div>

      <div className="p-5 space-y-4 text-xs">
        {isLoading && (
          <div className="flex items-center gap-2 text-gray-500">
            <Loader className="w-4 h-4 animate-spin" /> Loading profile...
          </div>
        )}

        {error && (
          <div className="text-red-300 bg-red-950/40 border border-red-800 rounded p-3">
            {(error as Error).message}
          </div>
        )}

        {profile && (
          <>
            {/* Certifications */}
            <div className="flex flex-wrap items-center gap-1.5">
              {sdvosb && (
                <Badge className="border-orange-800 bg-orange-950/40 text-orange-300">SDVOSB</Badge>
              )}
              {wosb && (
                <Badge className="border-pink-800 bg-pink-950/40 text-pink-300">WOSB</Badge>
              )}
              {hubzone && (
                <Badge className="border-blue-800 bg-blue-950/40 text-blue-300">HUBZone</Badge>
              )}
              {smallBusiness && !sdvosb && !wosb && !hubzone && (
                <Badge className="border-emerald-800 bg-emerald-950/40 text-emerald-300">Small Business</Badge>
              )}
              {!sdvosb && !wosb && !hubzone && !smallBusiness && (
                <Badge className="border-gray-700 bg-gray-900 text-gray-500">No SBA certifications on file</Badge>
              )}
            </div>

            {/* Identity */}
            <Section title="Identity">
              <Row label="Legal name" value={profile.legalName} />
              <Row label="CAGE code" value={profile.cageCode} mono />
              <Row label="SAM status" value={profile.samRegStatus} />
              {profile.samRegExpiry && (
                <Row
                  label="SAM expiry"
                  value={new Date(profile.samRegExpiry).toISOString().slice(0, 10)}
                />
              )}
            </Section>

            {/* Location */}
            {profile.address && (profile.address.city || profile.address.state) && (
              <Section title="Location" icon={<MapPin className="w-3.5 h-3.5" />}>
                <p className="text-gray-300">
                  {[profile.address.street, profile.address.city, profile.address.state, profile.address.zip]
                    .filter(Boolean)
                    .join(', ')}
                </p>
              </Section>
            )}

            {/* Web */}
            {(profile.website || profile.phone) && (
              <Section title="Contact channels">
                {profile.website && (
                  <div className="flex items-center gap-1.5 text-gray-300">
                    <Globe className="w-3 h-3 text-gray-500" />
                    <a
                      href={normalizeUrl(profile.website)}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="text-blue-400 hover:text-blue-300 truncate"
                    >
                      {profile.website}
                    </a>
                  </div>
                )}
                {profile.phone && (
                  <div className="flex items-center gap-1.5 text-gray-300">
                    <Phone className="w-3 h-3 text-gray-500" />
                    <span>{profile.phone}</span>
                  </div>
                )}
              </Section>
            )}

            {/* POCs */}
            {profile.contacts && profile.contacts.length > 0 && (
              <Section title={`Points of contact (${profile.contacts.length})`}>
                <ul className="space-y-1.5">
                  {profile.contacts.map((c, i) => (
                    <li key={i} className="border border-gray-800 rounded p-2 bg-gray-900/40">
                      <p className="text-gray-200">{c.name || '(no name on file)'}</p>
                      {c.title && <p className="text-gray-500">{c.title}</p>}
                      {c.role && <p className="text-[10px] text-gray-600 font-mono">{c.role}</p>}
                      {(c.email || c.phone) && (
                        <p className="text-gray-400 text-[11px] mt-0.5">
                          {[c.email, c.phone].filter(Boolean).join(' · ')}
                        </p>
                      )}
                    </li>
                  ))}
                </ul>
                {profile.contactsProvider && (
                  <p className="text-[10px] text-gray-600 mt-1.5">via {profile.contactsProvider}</p>
                )}
              </Section>
            )}

            {!profile.contacts || profile.contacts.length === 0 ? (
              <p className="text-[11px] text-gray-500 italic">
                No points of contact cached. Open the full profile to run an enrichment pass.
              </p>
            ) : null}

            {/* NAICS */}
            {profile.naicsCodes && profile.naicsCodes.length > 0 && (
              <Section title="NAICS on file">
                <p className="text-gray-400 font-mono">{profile.naicsCodes.join(', ')}</p>
              </Section>
            )}

            {/* Deep-link to full page */}
            <div className="pt-3 border-t border-gray-800">
              <Link
                to={`/recipient/${uei}`}
                className="inline-flex items-center gap-1.5 text-blue-400 hover:text-blue-300 text-xs"
                onClick={onClose}
              >
                Open full profile page <ExternalLink className="w-3 h-3" />
              </Link>
            </div>
          </>
        )}
      </div>
    </div>
  )
}

// =============================================================
// Small UI atoms
// =============================================================

function Section({
  title,
  icon,
  children,
}: {
  title: string
  icon?: React.ReactNode
  children: React.ReactNode
}) {
  return (
    <div>
      <p className="text-[10px] uppercase tracking-widest text-gray-500 mb-1.5 flex items-center gap-1">
        {icon}
        {title}
      </p>
      <div className="space-y-1">{children}</div>
    </div>
  )
}

function Row({
  label,
  value,
  mono,
}: {
  label: string
  value: string | null | undefined
  mono?: boolean
}) {
  if (!value) return null
  return (
    <div className="flex items-baseline gap-2">
      <span className="text-gray-500 w-24 shrink-0">{label}</span>
      <span className={`text-gray-300 ${mono ? 'font-mono' : ''}`}>{value}</span>
    </div>
  )
}

function Badge({
  children,
  className,
}: {
  children: React.ReactNode
  className: string
}) {
  return (
    <span className={`text-[9px] px-1.5 py-0.5 rounded border font-mono ${className}`}>
      {children}
    </span>
  )
}
