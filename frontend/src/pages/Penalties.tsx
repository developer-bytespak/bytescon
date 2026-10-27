import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { penaltiesApi } from '../services/api';
import { PageHeader, StatCard, SkeletonRows, StatusPill, EmptyState, ErrorBanner, formatCurrency } from '../components/ui';
import { DollarSign, CheckCircle } from 'lucide-react';
import { format } from 'date-fns';

export function PenaltiesPage() {
  const qc = useQueryClient();

  const { data, isLoading, error } = useQuery({
    queryKey: ['penalties'],
    queryFn: () => penaltiesApi.list({ limit: 50 }),
  });

  const { data: summaryData } = useQuery({
    queryKey: ['penalties-summary'],
    queryFn: () => penaltiesApi.summary(),
  });

  const payMutation = useMutation({
    mutationFn: (id: string) => penaltiesApi.markPaid(id),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['penalties'] });
      qc.invalidateQueries({ queryKey: ['penalties-summary'] });
    },
  });

  const penalties = data?.data || [];
  const summary = summaryData?.data;

  return (
    <div>
      <PageHeader title="Financial Penalties" subtitle="Late submission enforcement and accountability" />

      {/* Summary */}
      {summary && (
        <div className="stagger grid grid-cols-1 sm:grid-cols-3 gap-4 mb-8">
          <StatCard label="Total Penalties" value={formatCurrency(summary.total.amount)} sub={`${summary.total.count} events`} color="default" icon={<DollarSign />} />
          <StatCard label="Outstanding" value={formatCurrency(summary.outstanding.amount)} sub={`${summary.outstanding.count} unpaid`} color={summary.outstanding.count > 0 ? 'red' : 'default'} />
          <StatCard label="Collected" value={formatCurrency(summary.paid.amount)} sub={`${summary.paid.count} paid`} color="green" />
        </div>
      )}

      {isLoading && <div className="card !py-2"><SkeletonRows rows={5} cols={4} /></div>}
      {error && <ErrorBanner message="Failed to load penalties" />}
      {!isLoading && penalties.length === 0 && <EmptyState message="No penalties recorded. All submissions on time." />}

      <div className="stagger space-y-2">
        {penalties.map((p: any) => (
          <div key={p.id} className="card flex flex-wrap sm:flex-nowrap items-center gap-4">
            <span className={`tile tile-sm flex-shrink-0 ${p.isPaid ? 'tile-success' : 'tile-danger'}`}>
              <DollarSign className="w-4 h-4" />
            </span>
            <div className="flex-1 min-w-0">
              <p className="text-sm font-medium text-gray-200">{p.clientCompany?.name}</p>
              <p className="text-xs text-gray-500 truncate">{p.submissionRecord?.opportunity?.title}</p>
              <p className="text-xs text-gray-600 mt-0.5">{p.calculationBasis}</p>
            </div>
            <div className="text-right flex-shrink-0">
              <p className="text-lg font-semibold tabular-nums text-red-400">{formatCurrency(p.amount)}</p>
              <p className="text-xs text-gray-500">{p.penaltyType.replace('_', ' ')}</p>
            </div>
            <div className="text-right flex-shrink-0 w-24">
              <p className="text-xs text-gray-500 tabular-nums">{p.createdAt ? format(new Date(p.createdAt), 'MMM d') : ''}</p>
              {p.isPaid ? (
                <StatusPill status="Paid" dot={false} className="mt-1">
                  <CheckCircle className="w-3 h-3" />
                  Paid
                </StatusPill>
              ) : (
                <button
                  onClick={() => payMutation.mutate(p.id)}
                  disabled={payMutation.isPending}
                  className="btn-ghost btn-sm mt-1"
                >
                  Mark Paid
                </button>
              )}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
