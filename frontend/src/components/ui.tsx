// =============================================================
// Shared UI Components — Premium Design System
// =============================================================
import { ReactNode } from 'react';
import {
  AlertTriangle, Clock, CheckCircle, Loader2,
  TrendingUp, TrendingDown, Minus,
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

  const gradient =
    pct >= 60
      ? 'linear-gradient(90deg, #059669, #10b981)'
      : pct >= 35
      ? 'linear-gradient(90deg, #0891b2, #06b6d4)'
      : 'linear-gradient(90deg, #dc2626, #ef4444)';

  const textColor =
    pct >= 60 ? '#6ee7b7' : pct >= 35 ? '#a5f3fc' : '#f87171';

  return (
    <div className="flex items-center gap-2.5">
      <div className="prob-bar-track flex-1">
        <div
          className="h-full rounded-full transition-all duration-700"
          style={{ width: `${pct}%`, background: gradient }}
        />
      </div>
      <span
        className="text-[11px] font-mono font-bold w-9 text-right tabular-nums"
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
      style={{ color: '#06b6d4' }}
    />
  );
}

// ---- Empty State ----
export function EmptyState({ message }: { message: string }) {
  return (
    <div className="text-center py-20 animate-fade-in">
      <div
        className="w-16 h-16 rounded-2xl flex items-center justify-center mx-auto mb-5 animate-float"
        style={{
          background: 'linear-gradient(135deg, rgba(6,182,212,0.08), rgba(6,182,212,0.03))',
          border: '1px solid rgba(6,182,212,0.15)',
          boxShadow: '0 8px 32px rgba(0,0,0,0.3)',
        }}
      >
        <span className="text-3xl">☂</span>
      </div>
      <p className="text-sm font-medium" style={{ color: '#475569' }}>{message}</p>
      <p className="text-xs mt-1" style={{ color: '#334155' }}>
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
        background: 'rgba(239,68,68,0.08)',
        border: '1px solid rgba(239,68,68,0.2)',
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
  const valueColors: Record<string, string> = {
    default: '#e2e8f0',
    red:     '#f87171',
    yellow:  '#a5f3fc',
    green:   '#6ee7b7',
    blue:    '#93c5fd',
    gold:    '#22d3ee',
  };

  const accentClass: Record<string, string> = {
    default: 'stat-accent-subtle',
    red:     'stat-accent-red',
    yellow:  'stat-accent-gold',
    green:   'stat-accent-green',
    blue:    'stat-accent-blue',
    gold:    'stat-accent-gold',
  };

  return (
    <div
      className={`card${glow ? ' animate-gold-pulse' : ''}`}
      style={{
        transition: 'box-shadow 0.2s, transform 0.15s',
      }}
    >
      {/* Top accent line */}
      <div
        className={accentClass[color]}
        style={{ position: 'absolute', top: 0, left: 0, right: 0, height: '2px' }}
      />

      {/* Header row */}
      <div className="flex items-start justify-between mb-3">
        <p
          className="text-[10px] font-bold uppercase tracking-[0.12em]"
          style={{ color: '#475569' }}
        >
          {label}
        </p>
        {icon && (
          <div
            className="w-8 h-8 rounded-lg flex items-center justify-center flex-shrink-0"
            style={{
              background: 'rgba(26,46,74,0.6)',
              border: '1px solid rgba(26,46,74,0.8)',
            }}
          >
            {icon}
          </div>
        )}
      </div>

      {/* Value */}
      <p
        className="text-3xl font-black leading-none animate-count-in"
        style={{ color: valueColors[color] ?? valueColors.default, letterSpacing: '-0.02em' }}
      >
        {value}
      </p>

      {/* Sub + trend */}
      <div className="flex items-center justify-between mt-2.5 gap-2">
        {sub && (
          <p className="text-xs truncate" style={{ color: '#475569' }}>
            {sub}
          </p>
        )}
        {trend !== undefined && (
          <TrendBadge value={trend} />
        )}
      </div>
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
    <div className="flex items-start justify-between mb-8">
      <div>
        <div className="flex items-center gap-2.5 mb-1">
          <h1
            className="text-2xl font-black text-slate-100"
            style={{ letterSpacing: '-0.02em' }}
          >
            {title}
          </h1>
          {live && (
            <div className="flex items-center gap-1.5 mt-0.5">
              <div className="live-dot" />
              <span className="text-[9px] text-emerald-600 font-bold tracking-widest uppercase">
                Live
              </span>
            </div>
          )}
        </div>
        {subtitle && (
          <p className="text-sm" style={{ color: '#475569' }}>
            {subtitle}
          </p>
        )}
        {/* Gold underline */}
        <div
          className="mt-2.5 h-0.5 rounded-full"
          style={{
            width: '40px',
            background: 'linear-gradient(90deg, #06b6d4, transparent)',
          }}
        />
      </div>
      {children && (
        <div className="flex gap-2 items-center flex-wrap justify-end">
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
      <div className="flex items-center gap-2">
        <div
          className="w-1 h-4 rounded-full"
          style={{ background: 'linear-gradient(180deg, #22d3ee, #0891b2)' }}
        />
        <h2 className="text-sm font-bold text-slate-300 tracking-wide">{title}</h2>
      </div>
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
    <div className="flex items-start justify-between gap-3 py-2" style={{ borderBottom: '1px solid rgba(26,46,74,0.4)' }}>
      <span className="text-xs font-medium flex-shrink-0" style={{ color: '#475569' }}>{label}</span>
      <span className="text-xs text-slate-300 text-right">{value}</span>
    </div>
  );
}
