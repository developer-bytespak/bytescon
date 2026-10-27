// =============================================================
// Motion + data-display primitives shared across the app.
// Colours come only from the CSS tokens in index.css. Motion follows
// prefers-reduced-motion (MotionConfig in main.tsx + CSS fallbacks).
// =============================================================
import { CSSProperties, ReactNode, useEffect, useRef, useState } from 'react';
import { motion, useReducedMotion } from 'framer-motion';
import { X } from 'lucide-react';

const IS_TEST = import.meta.env.MODE === 'test';

/** Shared easing for framer-motion, matching --ease-out in CSS. */
export const EASE_OUT = [0.22, 1, 0.36, 1] as const;

// ---- CountUp ----------------------------------------------------
// Animates the numeric part of a value ("$1.2M", "42%", 1280) from 0 on
// first render. Anything that isn't a plain number renders unchanged.
const NUM_RE = /^([^0-9-]*)(-?[\d,]*\.?\d+)(.*)$/;

export function CountUp({ value, duration = 900, className = '' }: { value: string | number; duration?: number; className?: string }) {
  const text = String(value);
  const m = NUM_RE.exec(text);
  const reduce = useReducedMotion();
  const target = m ? parseFloat(m[2].replace(/,/g, '')) : NaN;
  const animate = !IS_TEST && !reduce && m !== null && Number.isFinite(target);
  const [shown, setShown] = useState(animate ? 0 : target);
  const from = useRef(0);

  useEffect(() => {
    if (!animate) return;
    let raf = 0;
    const start = performance.now();
    const begin = from.current;
    const tick = (now: number) => {
      const t = Math.min(1, (now - start) / duration);
      const eased = 1 - Math.pow(1 - t, 3);
      setShown(begin + (target - begin) * eased);
      if (t < 1) raf = requestAnimationFrame(tick);
      else from.current = target;
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [animate, target, duration]);

  if (!animate || !m) return <span className={className}>{text}</span>;
  const decimals = (m[2].split('.')[1] ?? '').length;
  const grouped = m[2].includes(',');
  const num = grouped
    ? shown.toLocaleString('en-US', { minimumFractionDigits: decimals, maximumFractionDigits: decimals })
    : shown.toFixed(decimals);
  return <span className={className}>{m[1]}{num}{m[3]}</span>;
}

// ---- Skeletons ----------------------------------------------------
export function Skeleton({ className = '', style }: { className?: string; style?: CSSProperties }) {
  return <div className={`skeleton ${className}`} style={style} aria-hidden="true" />;
}

export function SkeletonStats({ count = 4 }: { count?: number }) {
  return (
    <div className="grid grid-cols-2 lg:grid-cols-4 gap-4" aria-busy="true" aria-label="Loading">
      {Array.from({ length: count }).map((_, i) => (
        <div key={i} className="card">
          <Skeleton className="h-3 w-24" />
          <Skeleton className="h-7 w-20 mt-4" />
          <Skeleton className="h-3 w-32 mt-3" />
        </div>
      ))}
    </div>
  );
}

export function SkeletonRows({ rows = 6, cols = 4 }: { rows?: number; cols?: number }) {
  return (
    <div className="space-y-0" aria-busy="true" aria-label="Loading">
      {Array.from({ length: rows }).map((_, r) => (
        <div key={r} className="flex items-center gap-4 py-3.5" style={{ borderBottom: '1px solid var(--line)' }}>
          {Array.from({ length: cols }).map((_, c) => (
            <Skeleton key={c} className="h-3.5" style={{ flex: c === 0 ? 2 : 1, opacity: 1 - r * 0.08 }} />
          ))}
        </div>
      ))}
    </div>
  );
}

export function SkeletonCards({ count = 3 }: { count?: number }) {
  return (
    <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3" aria-busy="true" aria-label="Loading">
      {Array.from({ length: count }).map((_, i) => (
        <div key={i} className="card space-y-3">
          <Skeleton className="h-4 w-2/3" />
          <Skeleton className="h-3 w-full" />
          <Skeleton className="h-3 w-5/6" />
          <Skeleton className="h-8 w-28 mt-2" />
        </div>
      ))}
    </div>
  );
}

/** Generic page-body placeholder: a KPI row and a list. */
export function PageSkeleton() {
  return (
    <div className="space-y-6">
      <SkeletonStats />
      <div className="card"><SkeletonRows /></div>
    </div>
  );
}

// ---- Status pill ----------------------------------------------------
// One mapping from any status word the API returns to a tone, so the same
// word always looks the same everywhere.
type PillTone = 'accent' | 'gold' | 'success' | 'danger' | 'neutral';

const STATUS_TONES: Array<[RegExp, PillTone]> = [
  [/^(critical|overdue|failed|error|rejected|lost|declined|expired|blocked|no[-_ ]?bid|high[-_ ]?risk|cancel+ed|void(ed)?)$/i, 'danger'],
  [/^(elevated|pending|due|due[-_ ]soon|warning|review|in[-_ ]?review|needs[-_ ]?review|draft|medium|at[-_ ]?risk|awaiting.*|requested|pending[-_ ]review|on[-_ ]?hold)$/i, 'gold'],
  [/^(normal|active|submitted|won|approved|complete(d)?|paid|signed|verified|success|ok|healthy|bid|low|accepted|awarded|live|connected|done|go)$/i, 'success'],
  [/^(in[-_ ]?progress|open|new|qualifying|capture|proposal|running|queued|sent|scheduled|info)$/i, 'accent'],
];

export function statusTone(status: string | null | undefined): PillTone {
  const s = (status ?? '').trim();
  for (const [re, tone] of STATUS_TONES) if (re.test(s)) return tone;
  return 'neutral';
}

export function StatusPill({ status, children, size = 'md', dot = true, className = '' }: { status: string | null | undefined; children?: ReactNode; size?: 'md' | 'lg'; dot?: boolean; className?: string }) {
  const tone = statusTone(status);
  // A changed status replays a short highlight; the first render does not.
  const first = useRef(true);
  const [flash, setFlash] = useState(false);
  useEffect(() => {
    if (first.current) { first.current = false; return; }
    setFlash(true);
    const t = setTimeout(() => setFlash(false), 700);
    return () => clearTimeout(t);
  }, [status]);
  return (
    <span className={`chip chip-${tone}${size === 'lg' ? ' chip-lg' : ''}${flash ? ' status-flash' : ''} ${className}`}>
      {dot && <span className="chip-dot" aria-hidden="true" />}
      {children ?? status}
    </span>
  );
}

// ---- Tabs -----------------------------------------------------------
// Underline tabs with an animated indicator. Buttons keep their native
// button role so existing labels and tests are unaffected.
export interface TabItem<K extends string> { key: K; label: ReactNode; icon?: ReactNode; count?: number | null }

export function Tabs<K extends string>({ items, value, onChange, id, className = '', ariaLabel }: { items: TabItem<K>[]; value: K; onChange: (k: K) => void; id: string; className?: string; ariaLabel?: string }) {
  return (
    <div className={`tabs ${className}`} aria-label={ariaLabel}>
      {items.map((t) => {
        const active = t.key === value;
        return (
          <button key={t.key} type="button" className="tab" data-active={active} aria-pressed={active} onClick={() => onChange(t.key)}>
            {t.icon}
            {t.label}
            {t.count != null && t.count > 0 && <span className="tab-count">{t.count}</span>}
            {active && <TabIndicator id={id} />}
          </button>
        );
      })}
    </div>
  );
}

/** The sliding underline; drop inside any relatively-positioned active tab. */
export function TabIndicator({ id }: { id: string }) {
  return <motion.span layoutId={`tab-ind-${id}`} className="tab-indicator" transition={{ type: 'spring', stiffness: 500, damping: 40 }} aria-hidden="true" />;
}

// ---- Filter chips ----------------------------------------------------
export function FilterChips({ chips, onClearAll }: { chips: Array<{ key: string; label: ReactNode; onRemove: () => void }>; onClearAll?: () => void }) {
  if (chips.length === 0) return null;
  return (
    <div className="flex flex-wrap items-center gap-2">
      {chips.map((c) => (
        <motion.span
          key={c.key}
          layout
          initial={{ opacity: 0, scale: 0.92 }}
          animate={{ opacity: 1, scale: 1 }}
          transition={{ duration: 0.18, ease: EASE_OUT }}
          className="chip chip-accent"
        >
          {c.label}
          <button type="button" className="chip-remove" onClick={c.onRemove} aria-label={`Remove filter ${typeof c.label === 'string' ? c.label : c.key}`}>
            <X className="w-3 h-3" />
          </button>
        </motion.span>
      ))}
      {onClearAll && chips.length > 1 && (
        <button type="button" onClick={onClearAll} className="text-xs font-medium px-2 py-1 rounded-md transition-colors hover:bg-ink/5" style={{ color: 'var(--text-muted)' }}>
          Clear all
        </button>
      )}
    </div>
  );
}

// ---- Score ring -------------------------------------------------------
/** Circular gauge that sweeps to `value` (0-100) on mount. */
export function ScoreRing({ value, size = 132, stroke = 10, color = 'var(--accent)', children }: { value: number; size?: number; stroke?: number; color?: string; children?: ReactNode }) {
  const r = (size - stroke) / 2;
  const c = 2 * Math.PI * r;
  const pct = Math.max(0, Math.min(100, value)) / 100;
  const reduce = useReducedMotion();
  return (
    <div className="relative inline-grid place-items-center" style={{ width: size, height: size }}>
      <svg width={size} height={size} viewBox={`0 0 ${size} ${size}`} className="-rotate-90" aria-hidden="true">
        <circle cx={size / 2} cy={size / 2} r={r} fill="none" strokeWidth={stroke} className="ring-track" />
        <motion.circle
          cx={size / 2} cy={size / 2} r={r} fill="none" stroke={color} strokeWidth={stroke} strokeLinecap="round"
          strokeDasharray={c}
          initial={{ strokeDashoffset: IS_TEST || reduce ? c * (1 - pct) : c }}
          animate={{ strokeDashoffset: c * (1 - pct) }}
          transition={{ duration: 1.1, ease: EASE_OUT, delay: 0.1 }}
        />
      </svg>
      <div className="absolute inset-0 grid place-items-center text-center">{children}</div>
    </div>
  );
}

/** Horizontal bar that grows to `pct` (0-100) with an optional delay. */
export function GrowBar({ pct, color = 'var(--accent)', delay = 0, height = 6 }: { pct: number; color?: string; delay?: number; height?: number }) {
  const w = Math.max(0, Math.min(100, pct));
  return (
    <div className="progress-track" style={{ height }}>
      <div className="h-full rounded-full bar-grow" style={{ width: `${w}%`, background: color, animationDelay: `${delay}ms` }} />
    </div>
  );
}

// ---- Table wrapper ------------------------------------------------------
/** Scroll container for `.data-table`; header stays visible while scrolling. */
export function TableWrap({ children, maxHeight = false, className = '' }: { children: ReactNode; maxHeight?: boolean; className?: string }) {
  return <div className={`table-wrap${maxHeight ? ' max-h' : ''} ${className}`}>{children}</div>;
}

// ---- Card spotlight ---------------------------------------------------
/**
 * Feeds the pointer position to whichever `.card` is under the cursor as
 * --mx/--my, which the CSS turns into a soft glow that follows the mouse.
 * One passive listener for the whole page, throttled to animation frames.
 */
export function useCardSpotlight() {
  useEffect(() => {
    let raf = 0;
    let last: PointerEvent | null = null;
    const onMove = (e: PointerEvent) => {
      last = e;
      if (raf) return;
      raf = requestAnimationFrame(() => {
        raf = 0;
        const ev = last;
        const card = (ev?.target as Element | null)?.closest?.('.card') as HTMLElement | null;
        if (!ev || !card) return;
        const r = card.getBoundingClientRect();
        card.style.setProperty('--mx', `${ev.clientX - r.left}px`);
        card.style.setProperty('--my', `${ev.clientY - r.top}px`);
      });
    };
    window.addEventListener('pointermove', onMove, { passive: true });
    return () => {
      window.removeEventListener('pointermove', onMove);
      cancelAnimationFrame(raf);
    };
  }, []);
}
