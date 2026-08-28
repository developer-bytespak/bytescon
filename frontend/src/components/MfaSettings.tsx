// MFA (TOTP) enroll/disable panel for Settings (FIXES.md FIX-3).
import { useState } from 'react'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { authApi } from '../services/api'
import { Shield, Loader, Check } from 'lucide-react'

type ApiErr = { response?: { data?: { error?: string } } }
const msg = (e: unknown, fallback: string) => (e as ApiErr)?.response?.data?.error || fallback

export function MfaSettings() {
  const qc = useQueryClient()
  const { data, isLoading } = useQuery({ queryKey: ['mfa-status'], queryFn: () => authApi.mfaStatus() })
  const enabled = !!data?.data?.enabled

  const [enrolling, setEnrolling] = useState<{ secret: string; otpauthUri: string } | null>(null)
  const [code, setCode] = useState('')
  const [recoveryCodes, setRecoveryCodes] = useState<string[] | null>(null)
  const [disableCode, setDisableCode] = useState('')
  const [error, setError] = useState('')

  const enroll = useMutation({
    mutationFn: () => authApi.mfaEnroll(),
    onSuccess: (r: { data: { secret: string; otpauthUri: string } }) => { setEnrolling(r.data); setError('') },
    onError: (e: unknown) => setError(msg(e, 'Could not start enrollment')),
  })
  const confirm = useMutation({
    mutationFn: () => authApi.mfaEnrollVerify(code.trim()),
    onSuccess: (r: { data: { recoveryCodes: string[] } }) => {
      setRecoveryCodes(r.data.recoveryCodes)
      setEnrolling(null)
      setCode('')
      setError('')
      qc.invalidateQueries({ queryKey: ['mfa-status'] })
    },
    onError: (e: unknown) => setError(msg(e, 'Invalid code')),
  })
  const disable = useMutation({
    mutationFn: () => authApi.mfaDisable(disableCode.trim()),
    onSuccess: () => { setDisableCode(''); setError(''); qc.invalidateQueries({ queryKey: ['mfa-status'] }) },
    onError: (e: unknown) => setError(msg(e, 'Invalid code')),
  })

  return (
    <div className="card lg:col-span-2">
      <div className="flex items-center gap-2 mb-1">
        <Shield className="w-5 h-5 text-blue-400" />
        <h2 className="font-semibold text-gray-200">Two-Factor Authentication (2FA)</h2>
        {enabled && <span className="badge-green ml-2">Enabled</span>}
      </div>
      <p className="text-xs text-gray-500 mb-4">
        Protect your account with a time-based code from an authenticator app (Google Authenticator, 1Password, Authy…).
      </p>

      {isLoading && <Loader className="w-4 h-4 animate-spin text-gray-500" />}

      {recoveryCodes && (
        <div className="card bg-yellow-950/10 border-yellow-800 mb-4">
          <p className="text-sm text-yellow-300 font-medium mb-2">Save your recovery codes</p>
          <p className="text-xs text-gray-400 mb-3">
            Each works once if you lose your authenticator. Store them somewhere safe — they won’t be shown again.
          </p>
          <div className="grid grid-cols-2 gap-1 font-mono text-xs text-gray-200">
            {recoveryCodes.map((c) => <div key={c}>{c}</div>)}
          </div>
          <button onClick={() => setRecoveryCodes(null)} className="btn-secondary text-xs mt-3">I’ve saved them</button>
        </div>
      )}

      {!enabled && !enrolling && !recoveryCodes && (
        <button onClick={() => enroll.mutate()} disabled={enroll.isPending} className="btn-primary text-sm">
          {enroll.isPending ? 'Starting…' : 'Enable 2FA'}
        </button>
      )}

      {enrolling && (
        <div className="space-y-3">
          <p className="text-xs text-gray-400">
            Add this key to your authenticator app (manual entry), then enter the 6-digit code to confirm:
          </p>
          <code className="block text-xs bg-gray-900 p-2 rounded text-gray-200 break-all">{enrolling.secret}</code>
          <input
            value={code}
            onChange={(e) => setCode(e.target.value)}
            placeholder="6-digit code"
            className="input w-40 text-center tracking-widest"
            autoComplete="one-time-code"
          />
          <div className="flex gap-2">
            <button
              onClick={() => confirm.mutate()}
              disabled={confirm.isPending || code.trim().length !== 6}
              className="btn-primary text-sm flex items-center gap-1 disabled:opacity-50"
            >
              <Check className="w-4 h-4" /> Confirm
            </button>
            <button onClick={() => { setEnrolling(null); setCode(''); setError('') }} className="btn-secondary text-sm">
              Cancel
            </button>
          </div>
        </div>
      )}

      {enabled && !recoveryCodes && (
        <div className="space-y-2">
          <p className="text-xs text-gray-400">To turn off 2FA, confirm with a current code or a recovery code.</p>
          <div className="flex gap-2">
            <input
              value={disableCode}
              onChange={(e) => setDisableCode(e.target.value)}
              placeholder="Code"
              className="input w-40 text-center"
            />
            <button
              onClick={() => disable.mutate()}
              disabled={disable.isPending || disableCode.trim().length < 6}
              className="btn-secondary text-sm disabled:opacity-50"
            >
              Disable 2FA
            </button>
          </div>
        </div>
      )}

      {error && <p className="text-xs text-red-400 mt-2">{error}</p>}
    </div>
  )
}

export default MfaSettings
