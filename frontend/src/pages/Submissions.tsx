import { useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { Link } from 'react-router-dom';
import { submissionsApi, submissionApi, clientsApi, opportunitiesApi, type SubmissionOutcome } from '../services/api';
import { PageHeader, SkeletonRows, EmptyState, ErrorBanner, StatusPill } from '../components/ui';
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

  // Per-opportunity submission workspaces (checklist + readiness) are a separate
  // store from the outcome records below; list them so in-flight work is visible here.
  const { data: workspacesData } = useQuery({
    queryKey: ['submission-workspaces'],
    queryFn: () => submissionApi.listWorkspaces(),
  });
  const workspaces: any[] = workspacesData?.data ?? [];

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
        <div className="card flex items-start gap-3 mb-6" style={{ background: 'var(--warning-bg)', borderColor: 'var(--warning-border)' }}>
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
          <h2 className="text-sm font-semibold text-gray-100 mb-4">Log Bid Submission</h2>
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

      {workspaces.length > 0 && (
        <div className="card mb-6">
          <h2 className="text-sm font-semibold text-gray-100 mb-1">Submission workspaces</h2>
          <p className="text-xs text-gray-500 mb-3">Checklists being prepared per opportunity. Once you record a bid as submitted, log it below to track the outcome.</p>
          <div className="space-y-2">
            {workspaces.map((w) => (
              <Link
                key={w.id}
                to={`/opportunities/${w.opportunityId}/submission`}
                className="panel flex flex-wrap sm:flex-nowrap items-center gap-x-4 gap-y-1 px-4 py-2.5 text-sm hover:opacity-90"
              >
                <div className="flex-1 min-w-0">
                  <p className="text-gray-200 font-medium truncate">{w.title}</p>
                  <p className="text-xs text-gray-500 truncate">{w.opportunity?.title ?? 'Opportunity'}{w.opportunity?.agency ? ` · ${w.opportunity.agency}` : ''}</p>
                </div>
                <span className="text-xs text-gray-400 tabular-nums">{w.readinessPercent}% ready</span>
                <span className="chip chip-neutral !text-[10px] !py-0">{String(w.status).replace(/_/g, ' ')}</span>
              </Link>
            ))}
          </div>
        </div>
      )}

      {isLoading && <div className="card"><span className="sr-only">Loading…</span><SkeletonRows rows={5} cols={4} /></div>}
      {error && <ErrorBanner message="Failed to load submissions" />}
      {!isLoading && submissions.length === 0 && <EmptyState message="No submissions logged yet." />}

      <div className="stagger space-y-2">
        {submissions.map((sub: any) => (
          <div key={sub.id} className="card flex flex-wrap sm:flex-nowrap items-center gap-x-4 gap-y-3">
            <div className="flex-shrink-0">
              {sub.wasOnTime
                ? <CheckCircle className="w-5 h-5 text-green-400" />
                : <XCircle className="w-5 h-5 text-red-400" />
              }
            </div>
            <div className="flex-1 min-w-0">
              <p className="text-sm font-medium text-gray-200 truncate">{sub.opportunity?.title}</p>
              <p className="text-xs text-gray-500 truncate mt-0.5">
                {sub.clientCompany?.name} · Submitted by {sub.submittedBy?.firstName} {sub.submittedBy?.lastName}
              </p>
            </div>
            <div className="text-right flex-shrink-0 flex flex-col items-end gap-1">
              <p className="text-xs text-gray-400 tabular-nums">{sub.submittedAt ? format(new Date(sub.submittedAt), 'MMM d, yyyy HH:mm') : 'N/A'}</p>
              <StatusPill status={sub.wasOnTime ? 'ok' : 'overdue'}>
                {sub.wasOnTime ? 'ON TIME' : 'LATE'}
              </StatusPill>
            </div>
            {!sub.wasOnTime && sub.penaltyAmount > 0 && (
              <div className="text-right flex-shrink-0">
                <p className="text-xs text-gray-500">Penalty</p>
                <p className="text-sm font-mono tabular-nums text-red-400">${sub.penaltyAmount.toFixed(2)}</p>
              </div>
            )}
            <div className="flex-shrink-0 min-w-[120px] text-right">
              {sub.outcome ? (
                <OutcomeBadge outcome={sub.outcome} />
              ) : isAdmin ? (
                <button
                  onClick={() => setOutcomeModal({ submissionId: sub.id, opportunityTitle: sub.opportunity?.title ?? 'this submission' })}
                  className="btn-secondary btn-sm text-xs"
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

const OUTCOME_TONE: Record<SubmissionOutcome, string> = { WON: 'won', LOST: 'lost', NO_AWARD: 'no-award', WITHDRAWN: 'on-hold' };

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
    <StatusPill status={OUTCOME_TONE[outcome]} dot={false}>
      <Icon className="w-3 h-3" />
      {meta.label}
    </StatusPill>
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
    <div className="modal-backdrop fixed inset-0 z-50 flex items-center justify-center p-4" style={{ background: 'rgba(0,0,0,0.7)' }}>
      <div
        className="modal-panel w-full max-w-lg rounded-xl p-6"
        style={{ background: 'var(--surface)', border: '1px solid var(--line-strong)', boxShadow: 'var(--shadow-3)' }}
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
              className="input w-full resize-none"
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
