import { useState, useEffect } from 'react'
import { Bell, Loader, Save, Phone, Mail } from 'lucide-react'
import axios from 'axios'

const API_BASE = (import.meta as any).env?.VITE_API_URL || 'http://localhost:3001'

interface NotificationPrefsProps {
  clientAuth: any
  brandingColor?: string
}

interface Prefs {
  notifyDeliverables: boolean
  notifyDeadlines: boolean
  notifyApprovals: boolean
  smsPhone: string | null
  smsEnabled: boolean
  email?: string
}

export function NotificationPreferences({ clientAuth, brandingColor = '#22d3ee' }: NotificationPrefsProps) {
  const [prefs, setPrefs] = useState<Prefs | null>(null)
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const [saved, setSaved] = useState(false)
  const [error, setError] = useState('')

  useEffect(() => {
    loadPrefs()
  }, [])

  const loadPrefs = async () => {
    try {
      setLoading(true)
      const res = await axios.get(`${API_BASE}/api/client-portal/notification-preferences`, {
        headers: { Authorization: `Bearer ${clientAuth?.token}` },
      })
      setPrefs(res.data.data)
    } catch (err: any) {
      setError(err?.response?.data?.error || 'Failed to load preferences')
    } finally {
      setLoading(false)
    }
  }

  const handleSave = async () => {
    if (!prefs) return
    setSaving(true)
    setError('')
    setSaved(false)
    try {
      await axios.put(
        `${API_BASE}/api/client-portal/notification-preferences`,
        {
          notifyDeliverables: prefs.notifyDeliverables,
          notifyDeadlines: prefs.notifyDeadlines,
          notifyApprovals: prefs.notifyApprovals,
          smsPhone: prefs.smsPhone,
          smsEnabled: prefs.smsEnabled,
        },
        { headers: { Authorization: `Bearer ${clientAuth?.token}` } }
      )
      setSaved(true)
      setTimeout(() => setSaved(false), 3000)
    } catch (err: any) {
      setError(err?.response?.data?.error || 'Failed to save preferences')
    } finally {
      setSaving(false)
    }
  }

  const toggle = (field: keyof Prefs) => {
    if (!prefs) return
    setPrefs({ ...prefs, [field]: !prefs[field] })
  }

  if (loading) {
    return (
      <div className="flex items-center justify-center py-8">
        <Loader className="w-5 h-5 animate-spin text-gray-500" />
      </div>
    )
  }

  if (!prefs) {
    return <div className="text-red-400 text-sm">{error || 'Unable to load preferences'}</div>
  }

  const Toggle = ({ on, onClick }: { on: boolean; onClick: () => void }) => (
    <button
      type="button"
      onClick={onClick}
      className="relative w-11 h-6 rounded-full transition-colors"
      style={{ background: on ? brandingColor : '#374151' }}
    >
      <span
        className="absolute top-0.5 left-0.5 w-5 h-5 bg-white rounded-full transition-transform"
        style={{ transform: on ? 'translateX(20px)' : 'translateX(0)' }}
      />
    </button>
  )

  return (
    <div className="space-y-6">
      <div className="flex items-center gap-2 mb-2">
        <Bell className="w-5 h-5" style={{ color: brandingColor }} />
        <h2 className="text-lg font-semibold text-gray-100">Notification Preferences</h2>
      </div>

      <p className="text-sm text-gray-500">
        Control which alerts you receive at <span className="text-gray-300">{prefs.email}</span>
      </p>

      {error && (
        <div className="bg-red-900/30 border border-red-700 text-red-300 rounded-lg px-4 py-3 text-sm">
          {error}
        </div>
      )}

      {saved && (
        <div className="bg-green-900/30 border border-green-700 text-green-300 rounded-lg px-4 py-3 text-sm">
          Preferences saved
        </div>
      )}

      {/* Email notifications */}
      <div className="space-y-3 border border-gray-800 rounded-lg p-4">
        <div className="flex items-center gap-2 mb-2">
          <Mail className="w-4 h-4 text-gray-400" />
          <h3 className="text-sm font-medium text-gray-200">Email Notifications</h3>
        </div>

        <div className="flex items-center justify-between py-2">
          <div>
            <p className="text-sm text-gray-200">New deliverables ready for review</p>
            <p className="text-xs text-gray-500">Get notified when your consultant uploads a proposal or document</p>
          </div>
          <Toggle on={prefs.notifyDeliverables} onClick={() => toggle('notifyDeliverables')} />
        </div>

        <div className="flex items-center justify-between py-2 border-t border-gray-800">
          <div>
            <p className="text-sm text-gray-200">Deadline reminders</p>
            <p className="text-xs text-gray-500">Reminders at 14, 7, 3, and 1 day before document deadlines</p>
          </div>
          <Toggle on={prefs.notifyDeadlines} onClick={() => toggle('notifyDeadlines')} />
        </div>

        <div className="flex items-center justify-between py-2 border-t border-gray-800">
          <div>
            <p className="text-sm text-gray-200">Approval confirmations</p>
            <p className="text-xs text-gray-500">Confirm receipts when you approve or request changes</p>
          </div>
          <Toggle on={prefs.notifyApprovals} onClick={() => toggle('notifyApprovals')} />
        </div>
      </div>

      {/* SMS notifications */}
      <div className="space-y-3 border border-gray-800 rounded-lg p-4">
        <div className="flex items-center gap-2 mb-2">
          <Phone className="w-4 h-4 text-gray-400" />
          <h3 className="text-sm font-medium text-gray-200">SMS Notifications</h3>
          <span className="text-[10px] px-1.5 py-0.5 bg-gray-800 text-gray-400 rounded">Optional</span>
        </div>

        <div className="space-y-2">
          <input
            type="tel"
            placeholder="+1 555 555 1234"
            value={prefs.smsPhone || ''}
            onChange={(e) => setPrefs({ ...prefs, smsPhone: e.target.value })}
            className="w-full bg-gray-800 border border-gray-700 rounded px-3 py-2 text-sm text-gray-200 outline-none focus:border-blue-500"
          />
          <div className="flex items-center justify-between pt-2">
            <p className="text-xs text-gray-500">Enable urgent SMS alerts (deadline {'<'} 24h, deliverables ready)</p>
            <Toggle on={prefs.smsEnabled} onClick={() => toggle('smsEnabled')} />
          </div>
        </div>
      </div>

      <button
        onClick={handleSave}
        disabled={saving}
        className="flex items-center gap-2 disabled:opacity-50 font-medium px-4 py-2 rounded text-sm transition-colors"
        style={{
          background: brandingColor,
          color: '#0b0f1a',
        }}
      >
        {saving ? <Loader className="w-4 h-4 animate-spin" /> : <Save className="w-4 h-4" />}
        Save Preferences
      </button>
    </div>
  )
}
