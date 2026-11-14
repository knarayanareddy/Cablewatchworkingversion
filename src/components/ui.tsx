import { useState, type ReactNode } from 'react';
import { cn } from '@/utils/cn';
import type { AnomalyResult } from '@/lib/radar/model';

/* ------------------------------------------------------------------ icons */
const PATHS: Record<string, ReactNode> = {
  play: <path d="M8 5.5v13l11-6.5z" fill="currentColor" stroke="none" />,
  pause: (
    <>
      <rect x="6.5" y="5" width="4" height="14" rx="1" fill="currentColor" stroke="none" />
      <rect x="13.5" y="5" width="4" height="14" rx="1" fill="currentColor" stroke="none" />
    </>
  ),
  plus: <path d="M12 5v14M5 12h14" />,
  minus: <path d="M5 12h14" />,
  close: <path d="M6 6l12 12M18 6L6 18" />,
  fit: <path d="M4 9V4h5M20 9V4h-5M4 15v5h5M20 15v5h-5" />,
  globe: (
    <>
      <circle cx="12" cy="12" r="9" />
      <path d="M3 12h18M12 3c3 3.2 3 14.8 0 18M12 3c-3 3.2-3 14.8 0 18" />
    </>
  ),
  layers: <path d="M12 3l9 5-9 5-9-5 9-5zM3 13l9 5 9-5M3 17.5l9 5 9-5" />,
  alert: <path d="M12 3l10 18H2L12 3zM12 10v5M12 18h.01" />,
  radar: (
    <>
      <circle cx="12" cy="12" r="9" />
      <circle cx="12" cy="12" r="5" />
      <path d="M12 12l6-6" />
      <circle cx="12" cy="12" r="1" fill="currentColor" />
    </>
  ),
  drone: (
    <>
      <path d="M12 3l2.2 7.2L22 13v1.5l-7.8-1.3L13.5 19l2 1.5V22L12 21l-3.5 1v-1.5l2-1.5-.7-5.8L2 14.5V13l7.8-2.8L12 3z" />
    </>
  ),
  db: (
    <>
      <ellipse cx="12" cy="6" rx="8" ry="3" />
      <path d="M4 6v6c0 1.7 3.6 3 8 3s8-1.3 8-3V6M4 12v6c0 1.7 3.6 3 8 3s8-1.3 8-3v-6" />
    </>
  ),
  pin: (
    <>
      <path d="M12 21s7-6.2 7-11.5A7 7 0 005 9.5C5 14.8 12 21 12 21z" />
      <circle cx="12" cy="9.5" r="2.5" />
    </>
  ),
  upload: <path d="M12 16V4M7 9l5-5 5 5M4 17v3h16v-3" />,
  chevron: <path d="M7 10l5 5 5-5" />,
  info: (
    <>
      <circle cx="12" cy="12" r="9" />
      <path d="M12 11v6M12 7.5h.01" />
    </>
  ),
  flask: <path d="M9 3h6M10 3v6L4.5 19a1.5 1.5 0 001.3 2.2h12.4a1.5 1.5 0 001.3-2.2L14 9V3M7.5 15h9" />,
  target: (
    <>
      <circle cx="12" cy="12" r="8" />
      <circle cx="12" cy="12" r="3.5" />
      <path d="M12 2v3M12 19v3M2 12h3M19 12h3" />
    </>
  ),
  panel: <path d="M3 5h18v14H3zM9 5v14" />,
  menu: <path d="M4 7h16M4 12h16M4 17h16" />,
  bolt: <path d="M13 2L4 14h7l-1 8 9-12h-7l1-8z" />,
  ship: <path d="M3 17l2 3h14l2-3-9-3-9 3zM12 14V4l5 6h-5M5 12l7-2" />,
};

export function Icon({ name, className, size = 16 }: { name: keyof typeof PATHS | string; className?: string; size?: number }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      className={cn('shrink-0', className)}
      aria-hidden
    >
      {PATHS[name]}
    </svg>
  );
}

/* Vessel glyph path (pointed hull, drawn pointing "up" at heading 0°) */
export const VESSEL_PATH = 'M0,-10 C2.2,-6 4.6,-1 4.6,4.5 L4.6,8 L0,6 L-4.6,8 L-4.6,4.5 C-4.6,-1 -2.2,-6 0,-10 Z';

export function VesselGlyph({ color, size = 18, rotate = 0 }: { color: string; size?: number; rotate?: number }) {
  return (
    <svg width={size} height={size} viewBox="-12 -12 24 24" aria-hidden className="shrink-0">
      <path d={VESSEL_PATH} fill={color} stroke="#080d16" strokeWidth="1.4" transform={`rotate(${rotate})`} />
    </svg>
  );
}

/* ------------------------------------------------------------------ vessel colours */
export function vesselVisuals(a: AnomalyResult): { stroke: string; fill: string; alertTier: 'cue' | 'review' | 'normal' } {
  if (a.tier === 'cue') return { stroke: '#ff8595', fill: '#ff4259', alertTier: 'cue' };
  if (a.tier === 'review') return { stroke: '#ffbf5e', fill: '#ff9f1a', alertTier: 'review' };
  const type = (a.vessel.ship_type || '').toLowerCase();
  if (type.includes('fish') || type.includes('trawl')) return { stroke: '#ff9fcd', fill: '#ff6fb1', alertTier: 'normal' };
  if (type.includes('pass') || type.includes('ferry')) return { stroke: '#c9b6ff', fill: '#a98bff', alertTier: 'normal' };
  if (type.includes('cargo') || type.includes('tanker')) return { stroke: '#8fd5ff', fill: '#3db8ff', alertTier: 'normal' };
  return { stroke: '#a4f2d4', fill: '#2ee6a6', alertTier: 'normal' };
}

export function fmtAge(sec: number): string {
  return sec < 60 ? `${sec}s` : `${Math.floor(sec / 60)}m`;
}

/* ------------------------------------------------------------------ primitives */
type Tone = 'neutral' | 'brand' | 'cue' | 'review' | 'ok' | 'sky' | 'violet';
const TONES: Record<Tone, string> = {
  neutral: 'bg-ink-700 text-soft border-ink-600',
  brand: 'bg-brand/15 text-brand border-brand/40',
  cue: 'bg-cue/15 text-cue border-cue/50',
  review: 'bg-review/15 text-review border-review/50',
  ok: 'bg-ok/15 text-ok border-ok/40',
  sky: 'bg-sky/15 text-sky border-sky/40',
  violet: 'bg-violet/15 text-violet border-violet/40',
};

export function Badge({ tone = 'neutral', className, children, title }: { tone?: Tone; className?: string; children: ReactNode; title?: string }) {
  return (
    <span
      title={title}
      className={cn(
        'inline-flex items-center gap-1 rounded border px-1.5 py-0.5 text-[10px] font-bold uppercase leading-none tracking-wide',
        TONES[tone],
        className
      )}
    >
      {children}
    </span>
  );
}

export function TierBadge({ tier, className }: { tier: 'cue' | 'review' | 'normal'; className?: string }) {
  if (tier === 'cue') return <Badge tone="cue" className={className}>Cue</Badge>;
  if (tier === 'review') return <Badge tone="review" className={className}>Review</Badge>;
  return <Badge tone="neutral" className={cn('text-mute', className)}>Normal</Badge>;
}

export function Stat({ label, children, tone }: { label: string; children: ReactNode; tone?: 'cue' | 'ok' | 'review' | 'brand' }) {
  return (
    <div className="rounded-lg border border-ink-700 bg-ink-850 px-3 py-2">
      <div className="text-[10px] font-semibold uppercase tracking-wider text-mute">{label}</div>
      <div
        className={cn(
          'tabular mt-0.5 text-[15px] font-semibold text-white',
          tone === 'cue' && 'text-cue',
          tone === 'ok' && 'text-ok',
          tone === 'review' && 'text-review',
          tone === 'brand' && 'text-brand'
        )}
      >
        {children}
      </div>
    </div>
  );
}

export function Missing() {
  return <span className="text-xs font-normal italic text-mute">missing</span>;
}

export function Section({
  title,
  icon,
  right,
  defaultOpen = true,
  children,
  className,
}: {
  title: ReactNode;
  icon?: string;
  right?: ReactNode;
  defaultOpen?: boolean;
  children: ReactNode;
  className?: string;
}) {
  const [open, setOpen] = useState(defaultOpen);
  return (
    <section className={cn('border-t border-ink-700', className)}>
      <button
        type="button"
        onClick={() => setOpen(!open)}
        aria-expanded={open}
        className="flex w-full items-center gap-2 px-4 py-3 text-left transition-colors hover:bg-ink-850"
      >
        {icon && <Icon name={icon} size={15} className="text-brand" />}
        <span className="flex-1 text-xs font-bold uppercase tracking-wider text-soft">{title}</span>
        {right}
        <Icon name="chevron" size={14} className={cn('text-mute transition-transform', open && 'rotate-180')} />
      </button>
      {open && <div className="px-4 pb-4">{children}</div>}
    </section>
  );
}

export function FieldLabel({ children }: { children: ReactNode }) {
  return <div className="mb-1 text-[10px] font-semibold uppercase tracking-wider text-mute">{children}</div>;
}

export const selectCls =
  'w-full rounded-md border border-ink-600 bg-ink-900 px-2.5 py-1.5 text-xs text-white outline-none transition-colors hover:border-ink-500 focus:border-brand';
export const inputCls = selectCls;

export function IconButton({
  title,
  onClick,
  active,
  children,
  className,
  disabled,
}: {
  title: string;
  onClick: () => void;
  active?: boolean;
  children: ReactNode;
  className?: string;
  disabled?: boolean;
}) {
  return (
    <button
      type="button"
      title={title}
      aria-label={title}
      onClick={onClick}
      disabled={disabled}
      className={cn(
        'flex h-9 min-w-9 items-center justify-center gap-1 rounded-lg border px-2 text-xs font-bold shadow-lg shadow-black/30 backdrop-blur transition-colors disabled:opacity-50',
        active
          ? 'border-brand bg-brand text-ink-950'
          : 'border-ink-600 bg-ink-900/90 text-soft hover:border-ink-500 hover:bg-ink-800 hover:text-white',
        className
      )}
    >
      {children}
    </button>
  );
}
