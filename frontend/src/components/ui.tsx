// =============================================================
// Shared UI primitives — Obsidian design system.
// Colours come from the CSS tokens in index.css so every page that uses
// these stays consistent with the shell and the Tailwind palette.
// =============================================================
import { ReactNode } from 'react';
import {
  AlertTriangle, Clock, CheckCircle, Loader2,
  TrendingUp, TrendingDown, Minus, Inbox,
} from 'lucide-react';

// ---- Deadline Badge ----
interface DeadlineBadgeProps {
  priority: 'RED' | 'YELLOW' | 'GREEN';
  label: string;
}

export function DeadlineBadge({ priority, label }: DeadlineBadgeProps) {
  const classes = {
    RED: 'badge-red',
    YELLOW: 'badge-yellow',
    GREEN: 'badge-green',
  }[priority];

  const icons = {
    RED: <AlertTriangle className="w-3 h-3" />,
    YELLOW: <Clock className="w-3 h-3" />,
    GREEN: <CheckCircle className="w-3 h-3" />,
  }[priority];

  return (
    <span className={classes}>
      {icons}
      {label}
    </span>
  );
}

// ---- Probability Bar ----
interface ProbabilityBarProps {
  probability: number;
}

export function ProbabilityBar({ probability }: ProbabilityBarProps) {
  const pct = Math.round(probability * 100);

  const fill =
    pct >= 60 ? 'var(--success)'
    : pct >= 35 ? 'var(--accent)'
    : 'var(--danger)';

  const textColor =
    pct >= 60 ? '#6ee7b7' : pct >= 35 ? 'var(--accent-3)' : '#fca5a5';

  return (
    <div className="flex items-center gap-2.5">
      <div className="prob-bar-track flex-1">
        <div
          className="h-full rounded-full transition-all duration-700"
          style={{ width: `${pct}%`, background: fill }}
        />
      </div>
      <span
        className="text-[11px] font-mono font-semibold w-9 text-right tabular-nums"
        style={{ color: textColor }}
      >
        {pct}%
      </span>
    </div>
  );
}

// ---- Loading Spinner ----
export function Spinner({ size = 'md' }: { size?: 'sm' | 'md' | 'lg' }) {
  const sizes = { sm: 'w-4 h-4', md: 'w-6 h-6', lg: 'w-10 h-10' };
  return (
    <Loader2
      className={`animate-spin ${sizes[size]}`}
      style={{ color: 'var(--accent-2)' }}
    />
  );
}

// ---- Empty State ----
export function EmptyState({ message }: { message: string }) {
  return (
    <div className="text-center py-16 animate-fade-in">
      <div
        className="w-11 h-11 rounded-xl flex items-center justify-center mx-auto mb-4"
        style={{ background: 'var(--surface-2)', border: '1px solid var(--line-strong)', color: 'var(--text-faint)' }}
      >
        <Inbox className="w-5 h-5" />
      </div>
      <p className="text-sm font-medium" style={{ color: 'var(--text-2)' }}>{message}</p>
      <p className="text-xs mt-1" style={{ color: 'var(--text-faint)' }}>
        Data will appear here once available.
      </p>
    </div>
  );
}

// ---- Error Banner ----
export function ErrorBanner({ message }: { message: string }) {
  return (
    <div
      className="rounded-xl px-4 py-3 text-sm flex items-center gap-3"
      style={{
        background: 'var(--danger-bg)',
        border: '1px solid var(--danger-border)',
        color: '#fca5a5',
      }}
    >
      <AlertTriangle className="w-4 h-4 flex-shrink-0 text-red-400" />
      <span>{message}</span>
    </div>
  );
}

// ---- Trend Badge ----
export function TrendBadge({
  value,
  suffix = '%',
  label,
}: {
  value: number;
  suffix?: string;
  label?: string;
}) {
  const up = value > 0;
  const neutral = value === 0;

  if (neutral) {
    return (
      <span className="badge-neutral flex items-center gap-1">
        <Minus className="w-3 h-3" />
        {label ?? `0${suffix}`}
      </span>
    );
  }

  return (
    <span className={up ? 'badge-green flex items-center gap-1' : 'badge-red flex items-center gap-1'}>
      {up ? <TrendingUp className="w-3 h-3" /> : <TrendingDown className="w-3 h-3" />}
      {label ?? `${up ? '+' : ''}${value.toFixed(1)}${suffix}`}
    </span>
  );
}

// ---- Stat Card ----
interface StatCardProps {
  label: string;
  value: string | number;
  sub?: string;
  color?: 'default' | 'red' | 'yellow' | 'green' | 'blue' | 'gold';
  trend?: number;
  icon?: ReactNode;
  glow?: boolean;
}

export function StatCard({
  label,
  value,
  sub,
  color = 'default',
  trend,
  icon,
  glow = false,
}: StatCardProps) {
  // Values stay neutral; colour is reserved for a state that needs attention.
  const status = color === 'red' ? 'var(--danger)' : color === 'yellow' ? 'var(--warning)' : null

  return (
    <div className={`card${glow ? ' animate-gold-pulse' : ''}`}>
      <div className="flex items-start justify-between gap-3">
        <p className="text-xs font-medium" style={{ color: 'var(--text-muted)' }}>
          {label}
        </p>
        {icon && (
          <div
            className="stat-icon w-7 h-7 rounded-lg flex items-center justify-center flex-shrink-0"
            style={{ background: 'var(--surface-2)', border: '1px solid var(--line)' }}
          >
            {icon}
          </div>
        )}
      </div>

      <p
        className="mt-3 text-[1.75rem] font-semibold leading-none tabular-nums animate-count-in"
        style={{ color: 'var(--text)', letterSpacing: '-0.02em' }}
      >
        {value}
      </p>

      {(sub || trend !== undefined) && (
        <div className="flex items-center justify-between mt-2.5 gap-2">
          {sub && (
            <p className="flex items-center gap-1.5 text-xs truncate" style={{ color: 'var(--text-faint)' }}>
              {status && <span className="w-1.5 h-1.5 rounded-full flex-shrink-0" style={{ background: status }} aria-hidden="true" />}
              {sub}
            </p>
          )}
          {trend !== undefined && <TrendBadge value={trend} />}
        </div>
      )}
    </div>
  );
}

// ---- Page Header ----
export function PageHeader({
  title,
  subtitle,
  children,
  live,
}: {
  title: string;
  subtitle?: string;
  children?: ReactNode;
  live?: boolean;
}) {
  return (
    <div className="flex flex-col gap-4 mb-7 sm:flex-row sm:items-end sm:justify-between">
      <div className="min-w-0">
        <div className="flex items-center gap-2.5">
          <h1 className="page-title truncate">{title}</h1>
          {live && (
            <span className="flex items-center gap-1.5" title="Refreshes automatically">
              <span className="live-dot" />
              <span className="text-[10px] font-medium tracking-wide uppercase" style={{ color: 'var(--text-faint)' }}>
                Live
              </span>
            </span>
          )}
        </div>
        {subtitle && <p className="page-subtitle">{subtitle}</p>}
      </div>
      {children && (
        <div className="flex gap-2 items-center flex-wrap sm:justify-end flex-shrink-0">
          {children}
        </div>
      )}
    </div>
  );
}

// ---- Section Header (within a page) ----
export function SectionHeader({
  title,
  action,
}: {
  title: string;
  action?: ReactNode;
}) {
  return (
    <div className="flex items-center justify-between mb-4">
      <h2 className="text-sm font-semibold" style={{ color: 'var(--text)' }}>{title}</h2>
      {action && <div>{action}</div>}
    </div>
  );
}

// ---- Currency formatter ----
export function formatCurrency(value: number | string | null | undefined): string {
  if (value == null || value === '') return 'N/A';
  const n = typeof value === 'string' ? parseFloat(value) : value;
  if (isNaN(n)) return 'N/A';
  if (n >= 1_000_000_000) return `$${(n / 1_000_000_000).toFixed(1)}B`;
  if (n >= 1_000_000)     return `$${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000)         return `$${(n / 1_000).toFixed(0)}K`;
  return `$${n.toFixed(0)}`;
}

// ---- Info Row (label + value pair) ----
export function InfoRow({ label, value }: { label: string; value?: string | number | null }) {
  if (value == null || value === '') return null;
  return (
    <div className="flex items-start justify-between gap-3 py-2" style={{ borderBottom: '1px solid var(--line)' }}>
      <span className="text-xs font-medium flex-shrink-0" style={{ color: 'var(--text-muted)' }}>{label}</span>
      <span className="text-xs text-right" style={{ color: 'var(--text-2)' }}>{value}</span>
    </div>
  );
}
