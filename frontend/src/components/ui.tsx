// =============================================================
// Shared UI primitives — Obsidian design system, lively edition.
// Colours come from the CSS tokens in index.css so every page that uses
// these stays consistent with the shell and the Tailwind palette.
// =============================================================
import { ReactNode } from 'react';
import {
  AlertTriangle, Clock, CheckCircle, Loader2,
  TrendingUp, TrendingDown, Minus, Inbox,
} from 'lucide-react';

export type Tone = 'accent' | 'gold' | 'success' | 'danger' | 'neutral';

/** Small icon tile; the tone tints its background and icon. */
export function Tile({ tone = 'neutral', size = 'md', children, className = '' }: { tone?: Tone; size?: 'sm' | 'md'; children: ReactNode; className?: string }) {
  return <span className={`tile tile-${tone}${size === 'sm' ? ' tile-sm' : ''} ${className}`}>{children}</span>;
}

/** Pill chip with an optional status dot. */
export function Chip({ tone = 'neutral', dot = false, children, className = '' }: { tone?: Tone; dot?: boolean; children: ReactNode; className?: string }) {
  return (
    <span className={`chip chip-${tone} ${className}`}>
      {dot && <span className="chip-dot" aria-hidden="true" />}
      {children}
    </span>
  );
}

/** Tiny inline trend line for stat cards. */
export function Sparkline({ data, stroke = 'var(--gold)', width = 96, height = 30, className = '' }: { data: number[]; stroke?: string; width?: number; height?: number; className?: string }) {
  if (!data || data.length < 2) return null;
  const min = Math.min(...data);
  const max = Math.max(...data);
  const span = max - min || 1;
  const step = width / (data.length - 1);
  const pts = data.map((v, i) => [i * step, height - 3 - ((v - min) / span) * (height - 6)] as const);
  const d = pts.map(([x, y], i) => `${i === 0 ? 'M' : 'L'}${x.toFixed(1)},${y.toFixed(1)}`).join(' ');
  const area = `${d} L${width},${height} L0,${height} Z`;
  const id = `spark-${Math.round(min)}-${Math.round(max)}-${data.length}`;
  return (
    <svg className={`sparkline ${className}`} width={width} height={height} viewBox={`0 0 ${width} ${height}`} aria-hidden="true">
      <defs>
        <linearGradient id={id} x1="0" x2="0" y1="0" y2="1">
          <stop offset="0%" stopColor={stroke} stopOpacity="0.35" />
          <stop offset="100%" stopColor={stroke} stopOpacity="0" />
        </linearGradient>
      </defs>
      <path d={area} fill={`url(#${id})`} />
      <path d={d} fill="none" stroke={stroke} strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round" />
      <circle cx={pts[pts.length - 1][0]} cy={pts[pts.length - 1][1]} r="2.2" fill={stroke} />
    </svg>
  );
}

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
    pct >= 60 ? 'linear-gradient(90deg, var(--success), #6ee7b7)'
    : pct >= 35 ? 'linear-gradient(90deg, var(--accent), var(--accent-3))'
    : 'linear-gradient(90deg, var(--danger), #fca5a5)';

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
      <div className="empty-ring mx-auto mb-5">
        <Tile tone="accent"><Inbox /></Tile>
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
      <Tile tone="danger" size="sm"><AlertTriangle /></Tile>
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
  /** Legacy colour prop; maps to a tone. */
  color?: 'default' | 'red' | 'yellow' | 'green' | 'blue' | 'gold';
  /** Tints the icon tile and, when featured, the whole card. */
  tone?: Tone;
  /** Gradient card for the one number that matters most on the page. */
  featured?: boolean;
  /** Small trend line drawn in the corner. */
  series?: number[];
  trend?: number;
  icon?: ReactNode;
  glow?: boolean;
}

const COLOR_TONE: Record<NonNullable<StatCardProps['color']>, Tone> = {
  default: 'neutral', red: 'danger', yellow: 'gold', green: 'success', blue: 'accent', gold: 'gold',
};

export function StatCard({
  label,
  value,
  sub,
  color = 'default',
  tone,
  featured = false,
  series,
  trend,
  icon,
  glow = false,
}: StatCardProps) {
  const t: Tone = tone ?? COLOR_TONE[color];
  // Values stay neutral; a status dot on the caption flags attention states.
  const status = t === 'danger' ? 'var(--danger)' : t === 'gold' && (color === 'yellow') ? 'var(--warning)' : null;

  return (
    <div className={`card stat-card${featured ? ' card-accent stat-featured' : ''}${glow ? ' animate-gold-pulse' : ''}`}>
      <div className="flex items-start justify-between gap-3">
        <p className="text-xs font-medium" style={{ color: featured ? 'var(--accent-3)' : 'var(--text-muted)' }}>
          {label}
        </p>
        {icon && <Tile tone={featured ? 'accent' : t} size="sm" className="stat-icon">{icon}</Tile>}
      </div>

      <div className="mt-3 flex items-end justify-between gap-3">
        <p
          className="text-[1.75rem] font-semibold leading-none tabular-nums animate-count-in"
          style={{ color: 'var(--text)', letterSpacing: '-0.02em' }}
        >
          {value}
        </p>
        {series && series.length > 1 && <Sparkline data={series} stroke={featured ? 'var(--gold-2)' : 'var(--accent-2)'} />}
      </div>

      {(sub || trend !== undefined) && (
        <div className="flex items-center justify-between mt-2.5 gap-2">
          {sub && (
            <p className="flex items-center gap-1.5 text-xs truncate" style={{ color: featured ? 'var(--text-2)' : 'var(--text-faint)' }}>
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
  icon,
}: {
  title: string;
  subtitle?: string;
  children?: ReactNode;
  live?: boolean;
  icon?: ReactNode;
}) {
  return (
    <div className="flex flex-col gap-4 mb-7 sm:flex-row sm:items-end sm:justify-between">
      <div className="min-w-0 flex items-start gap-3">
        {icon && <Tile tone="accent" className="mt-0.5">{icon}</Tile>}
        <div className="min-w-0">
          <div className="flex items-center gap-2.5">
            <h1 className="page-title truncate">{title}</h1>
            {live && (
              <span className="live-pill" title="Refreshes automatically">
                <span className="live-dot" />
                Live
              </span>
            )}
          </div>
          {subtitle && <p className="page-subtitle">{subtitle}</p>}
        </div>
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
  subtitle,
  icon,
  tone = 'accent',
  action,
}: {
  title: string;
  subtitle?: string;
  icon?: ReactNode;
  tone?: Tone;
  action?: ReactNode;
}) {
  return (
    <div className="flex items-center justify-between gap-4 mb-4">
      <div className="flex items-center gap-3 min-w-0">
        {icon && <Tile tone={tone}>{icon}</Tile>}
        <div className="min-w-0">
          <h2 className="text-sm font-semibold truncate" style={{ color: 'var(--text)' }}>{title}</h2>
          {subtitle && <p className="text-xs mt-0.5 truncate" style={{ color: 'var(--text-faint)' }}>{subtitle}</p>}
        </div>
      </div>
      {action && <div className="flex-shrink-0">{action}</div>}
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
