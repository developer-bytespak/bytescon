import { useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { submissionsApi, clientsApi, opportunitiesApi, type SubmissionOutcome } from '../services/api';
import { PageHeader, Spinner, EmptyState, ErrorBanner } from '../components/ui';
import { Plus, CheckCircle, XCircle, Trophy, X as XIcon, Loader, AlertTriangle } from 'lucide-react';
import { format } from 'date-fns';
import { useAuth } from '../hooks/useAuth';

export function SubmissionsPage() {
  const qc = useQueryClient();
  const { user } = useAuth();
  const isAdmin = user?.role === 'ADMIN';
  const [showCreate, setShowCreate] = useState(false);
  const [form, setForm] = useState({ clientCompanyId: '', opportunityId: '', submittedAt: '', notes: '' });
  const [formError, setFormError] = useState('');
  const [outcomeModal, setOutcomeModal] = useState<{ submissionId: string; opportunityTitle: string } | null>(null);

  const outcomeMutation = useMutation({
    mutationFn: ({ id, outcome, notes }: { id: string; outcome: SubmissionOutcome; notes?: string }) =>
      submissionsApi.recordOutcome(id, outcome, notes),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['submissions'] });
      qc.invalidateQueries({ queryKey: ['dashboard'] });
      setOutcomeModal(null);
    },
  });

  const { data, isLoading, error } = useQuery({
    queryKey: ['submissions'],
    queryFn: () => submissionsApi.list({ limit: 50 }),
  });

  const { data: clientsData, isLoading: clientsLoading } = useQuery({
    queryKey: ['clients-select'],
    queryFn: () => clientsApi.list({ limit: 100, active: true }),
  });

  const { data: oppsData, isLoading: oppsLoading } = useQuery({
    queryKey: ['opps-select'],
    queryFn: () => opportunitiesApi.search({ status: 'ACTIVE', limit: 100 }),
  });

  // Section 4 #8: the create form's required dropdowns are populated from these
  // two queries. Until both resolve, opening the form would present empty
  // required selects, so the action stays disabled with a loading affordance.
  const createFormReady = !clientsLoading && !oppsLoading;

  // FIX-1 flywheel nudge: bids past their deadline still awaiting an outcome.
  const { data: pendingData } = useQuery({
    queryKey: ['submissions-pending-outcomes'],
    queryFn: () => submissionsApi.pendingOutcomes(),
  });
  const pendingCount = pendingData?.meta?.pendingCount ?? 0;
  const captureRate = pendingData?.meta?.captureRatePct;

  const createMutation = useMutation({
    mutationFn: (body: any) => submissionsApi.create(body),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['submissions'] });
      qc.invalidateQueries({ queryKey: ['dashboard'] });
      setShowCreate(false);
      setForm({ clientCompanyId: '', opportunityId: '', submittedAt: '', notes: '' });
    },
    onError: (err: any) => setFormError(err.response?.data?.error || 'Submission failed'),
  });

  const submissions = data?.data || [];
  const clients = clientsData?.data || [];
  const opportunities = oppsData?.data || [];

  return (
    <div>
      <PageHeader title="Submission Records" subtitle="Bid submission tracking and accountability">
        <button
          onClick={() => setShowCreate(!showCreate)}
          disabled={!createFormReady}
          aria-busy={!createFormReady}
          className="btn-primary flex items-center gap-2 disabled:opacity-60 disabled:cursor-not-allowed"
        >
          {createFormReady ? <Plus className="w-4 h-4" /> : <Loader className="w-4 h-4 animate-spin" />}
          Log Submission
        </button>
      </PageHeader>

      {pendingCount > 0 && (
        <div className="card border-yellow-800 bg-yellow-950/10 flex items-start gap-3 mb-6">
          <AlertTriangle className="w-5 h-5 text-yellow-400 flex-shrink-0 mt-0.5" />
          <div className="text-sm text-gray-300">
            <span className="font-medium text-yellow-300">
              {pendingCount} bid{pendingCount === 1 ? '' : 's'} awaiting an outcome.
            </span>{' '}
            Record WON / LOST below — real outcomes sharpen every client's Fit score.
            {captureRate != null && (
              <span className="text-gray-500"> · Outcome capture rate: {captureRate}%</span>
            )}
          </div>
        </div>
      )}

      {showCreate && (
        <div className="card mb-6">
          <h2 className="font-semibold text-gray-200 mb-4">Log Bid Submission</h2>
          <form
            onSubmit={(e) => { e.preventDefault(); setFormError(''); createMutation.mutate({ ...form, submittedAt: new Date(form.submittedAt).toISOString() }); }}
            className="grid grid-cols-1 md:grid-cols-2 gap-4"
          >
            <div>
              <label className="label">Client Company *</label>
              <select className="input" value={form.clientCompanyId} onChange={(e) => setForm({ ...form, clientCompanyId: e.target.value })} required>
                <option value="">Select client...</option>
                {clients.map((c: any) => <option key={c.id} value={c.id}>{c.name}</option>)}
              </select>
            </div>
            <div>
              <label className="label">Opportunity *</label>
              <select className="input" value={form.opportunityId} onChange={(e) => setForm({ ...form, opportunityId: e.target.value })} required>
                <option value="">Select opportunity...</option>
                {opportunities.map((o: any) => <option key={o.id} value={o.id}>{o.title.substring(0, 60)}</option>)}
              </select>
            </div>
            <div>
              <label className="label">Submission Date/Time *</label>
              <input type="datetime-local" className="input" value={form.submittedAt} onChange={(e) => setForm({ ...form, submittedAt: e.target.value })} required />
            </div>
            <div>
              <label className="label">Notes</label>
              <input className="input" value={form.notes} onChange={(e) => setForm({ ...form, notes: e.target.value })} placeholder="Optional notes..." />
            </div>

            {formError && <div className="md:col-span-2"><ErrorBanner message={formError} /></div>}

            <div className="md:col-span-2 flex gap-2">
              <button type="submit" disabled={createMutation.isPending} className="btn-primary">
                {createMutation.isPending ? 'Logging...' : 'Log Submission'}
              </button>
              <button type="button" onClick={() => setShowCreate(false)} className="btn-secondary">Cancel</button>
            </div>
          </form>
        </div>
      )}

      {isLoading && <div className="flex justify-center mt-10"><Spinner size="lg" /></div>}
      {error && <ErrorBanner message="Failed to load submissions" />}
      {!isLoading && submissions.length === 0 && <EmptyState message="No submissions logged yet." />}

      <div className="space-y-2">
        {submissions.map((sub: any) => (
          <div key={sub.id} className="card flex items-center gap-4">
            <div className="flex-shrink-0">
              {sub.wasOnTime
                ? <CheckCircle className="w-5 h-5 text-green-400" />
                : <XCircle className="w-5 h-5 text-red-400" />
              }
            </div>
            <div className="flex-1 min-w-0">
              <p className="text-sm font-medium text-gray-200 truncate">{sub.opportunity?.title}</p>
              <p className="text-xs text-gray-500">
                {sub.clientCompany?.name} · Submitted by {sub.submittedBy?.firstName} {sub.submittedBy?.lastName}
              </p>
            </div>
            <div className="text-right flex-shrink-0">
              <p className="text-xs text-gray-400">{sub.submittedAt ? format(new Date(sub.submittedAt), 'MMM d, yyyy HH:mm') : 'N/A'}</p>
              <p className={`text-xs font-semibold ${sub.wasOnTime ? 'text-green-400' : 'text-red-400'}`}>
                {sub.wasOnTime ? 'ON TIME' : 'LATE'}
              </p>
            </div>
            {!sub.wasOnTime && sub.penaltyAmount > 0 && (
              <div className="text-right flex-shrink-0">
                <p className="text-xs text-gray-500">Penalty</p>
                <p className="text-sm font-mono text-red-400">${sub.penaltyAmount.toFixed(2)}</p>
              </div>
            )}
            <div className="flex-shrink-0 min-w-[120px] text-right">
              {sub.outcome ? (
                <OutcomeBadge outcome={sub.outcome} />
              ) : isAdmin ? (
                <button
                  onClick={() => setOutcomeModal({ submissionId: sub.id, opportunityTitle: sub.opportunity?.title ?? 'this submission' })}
                  className="btn-secondary text-xs px-3 py-1"
                >
                  Record outcome
                </button>
              ) : (
                <span className="text-[11px] text-gray-600">awaiting outcome</span>
              )}
            </div>
          </div>
        ))}
      </div>

      {outcomeModal && (
        <OutcomeModal
          opportunityTitle={outcomeModal.opportunityTitle}
          submitting={outcomeMutation.isPending}
          onClose={() => setOutcomeModal(null)}
          onSubmit={(outcome, notes) =>
            outcomeMutation.mutate({ id: outcomeModal.submissionId, outcome, notes })
          }
        />
      )}
    </div>
  );
}

const OUTCOME_META: Record<SubmissionOutcome, { label: string; color: string; icon: React.ComponentType<{ className?: string }> }> = {
  WON:        { label: 'Won',        color: 'text-green-400 bg-green-950/40 border-green-800',     icon: Trophy },
  LOST:       { label: 'Lost',       color: 'text-red-400 bg-red-950/40 border-red-800',           icon: XIcon },
  NO_AWARD:   { label: 'No award',   color: 'text-gray-300 bg-gray-800 border-gray-700',           icon: XCircle },
  WITHDRAWN:  { label: 'Withdrawn',  color: 'text-yellow-300 bg-yellow-950/40 border-yellow-800',  icon: XCircle },
};

function OutcomeBadge({ outcome }: { outcome: SubmissionOutcome }) {
  const meta = OUTCOME_META[outcome];
  const Icon = meta.icon;
  return (
    <span className={`inline-flex items-center gap-1 px-2 py-1 rounded text-[11px] font-semibold border ${meta.color}`}>
      <Icon className="w-3 h-3" />
      {meta.label}
    </span>
  );
}

function OutcomeModal({
  opportunityTitle,
  submitting,
  onClose,
  onSubmit,
}: {
  opportunityTitle: string;
  submitting: boolean;
  onClose: () => void;
  onSubmit: (outcome: SubmissionOutcome, notes?: string) => void;
}) {
  const [selected, setSelected] = useState<SubmissionOutcome | null>(null);
  const [notes, setNotes] = useState('');

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (!selected) return;
    onSubmit(selected, notes.trim() || undefined);
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4" style={{ background: 'rgba(0,0,0,0.7)' }}>
      <div
        className="w-full max-w-lg rounded-xl p-6"
        style={{ background: '#0f172a', border: '1px solid rgba(6,182,212,0.3)' }}
      >
        <h2 className="text-lg font-semibold text-slate-100 mb-1">Record submission outcome</h2>
        <p className="text-xs text-slate-500 mb-5 truncate">{opportunityTitle}</p>

        <form onSubmit={handleSubmit} className="space-y-5">
          <div className="grid grid-cols-2 gap-2">
            {(Object.keys(OUTCOME_META) as SubmissionOutcome[]).map((key) => {
              const meta = OUTCOME_META[key];
              const Icon = meta.icon;
              const isSelected = selected === key;
              return (
                <button
                  key={key}
                  type="button"
                  onClick={() => setSelected(key)}
                  className={`flex items-center gap-2 px-3 py-2.5 rounded-lg text-sm border transition ${
                    isSelected ? meta.color : 'border-slate-700 text-slate-400 hover:border-slate-500'
                  }`}
                >
                  <Icon className="w-4 h-4" />
                  {meta.label}
                </button>
              );
            })}
          </div>

          <div>
            <label className="block text-xs text-slate-400 mb-1">Notes (optional)</label>
            <textarea
              value={notes}
              onChange={(e) => setNotes(e.target.value)}
              rows={3}
              maxLength={2000}
              placeholder="e.g. competitor name, lessons learned, debrief comments"
              className="w-full bg-gray-900 border border-gray-700 rounded-lg px-3 py-2 text-sm text-slate-100 outline-none focus:border-amber-500 resize-none"
              disabled={submitting}
            />
          </div>

          <div className="flex justify-end gap-2">
            <button type="button" onClick={onClose} disabled={submitting} className="btn-secondary text-sm">
              Cancel
            </button>
            <button
              type="submit"
              disabled={submitting || !selected}
              className="btn-primary text-sm flex items-center gap-2 disabled:opacity-60 disabled:cursor-not-allowed"
            >
              {submitting ? <><Loader className="w-4 h-4 animate-spin" /> Saving…</> : 'Record outcome'}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
