import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { penaltiesApi } from '../services/api';
import { PageHeader, StatCard, Spinner, EmptyState, ErrorBanner, formatCurrency } from '../components/ui';
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
        <div className="grid grid-cols-3 gap-4 mb-8">
          <StatCard label="Total Penalties" value={formatCurrency(summary.total.amount)} sub={`${summary.total.count} events`} color="default" />
          <StatCard label="Outstanding" value={formatCurrency(summary.outstanding.amount)} sub={`${summary.outstanding.count} unpaid`} color={summary.outstanding.count > 0 ? 'red' : 'default'} />
          <StatCard label="Collected" value={formatCurrency(summary.paid.amount)} sub={`${summary.paid.count} paid`} color="green" />
        </div>
      )}

      {isLoading && <div className="flex justify-center mt-10"><Spinner size="lg" /></div>}
      {error && <ErrorBanner message="Failed to load penalties" />}
      {!isLoading && penalties.length === 0 && <EmptyState message="No penalties recorded. All submissions on time." />}

      <div className="space-y-2">
        {penalties.map((p: any) => (
          <div key={p.id} className="card flex items-center gap-4">
            <div className="flex-shrink-0">
              <DollarSign className={`w-5 h-5 ${p.isPaid ? 'text-green-400' : 'text-red-400'}`} />
            </div>
            <div className="flex-1 min-w-0">
              <p className="text-sm font-medium text-gray-200">{p.clientCompany?.name}</p>
              <p className="text-xs text-gray-500 truncate">{p.submissionRecord?.opportunity?.title}</p>
              <p className="text-xs text-gray-600 mt-0.5">{p.calculationBasis}</p>
            </div>
            <div className="text-right flex-shrink-0">
              <p className="text-lg font-mono font-bold text-red-400">{formatCurrency(p.amount)}</p>
              <p className="text-xs text-gray-500">{p.penaltyType.replace('_', ' ')}</p>
            </div>
            <div className="text-right flex-shrink-0 w-24">
              <p className="text-xs text-gray-500">{p.createdAt ? format(new Date(p.createdAt), 'MMM d') : ''}</p>
              {p.isPaid ? (
                <span className="flex items-center gap-1 text-xs text-green-400 justify-end">
                  <CheckCircle className="w-3 h-3" />
                  Paid
                </span>
              ) : (
                <button
                  onClick={() => payMutation.mutate(p.id)}
                  disabled={payMutation.isPending}
                  className="text-xs text-blue-400 hover:text-blue-300 mt-0.5"
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
