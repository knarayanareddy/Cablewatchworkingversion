import { useEffect, useState } from 'react';
import { cn } from '@/utils/cn';
import type { Radar } from '@/lib/radar/useRadar';
import { BALTIC_CORRIDOR_NETWORK, PRESET_BASES } from '@/lib/radar/model';
import { Badge, FieldLabel, Icon, TierBadge, VesselGlyph, fmtAge, selectCls, vesselVisuals } from '@/components/ui';

type Tab = 'alerts' | 'infra' | 'isr';

const REGION_GROUPS: { label: string; regions: (string | undefined)[] }[] = [
  { label: 'Bornholm Basin & Approaches (Judges Demo Area)', regions: ['Bornholm'] },
  { label: 'Western Baltic & German Approaches', regions: ['Western Baltic'] },
  { label: 'Danish Belts & Straits (Storebælt, Lillebælt, Øresund)', regions: ['Straits'] },
  { label: 'Kattegat & Regional Baltic Pipelines', regions: ['Kattegat', 'Regional'] },
];

export function LeftPanel({ r }: { r: Radar }) {
  const [tab, setTab] = useState<Tab>('alerts');

  // The ISR tab exists only while the planner is switched on (top-bar toggle).
  useEffect(() => {
    if (r.showISRPlan) setTab('isr');
    else setTab((t) => (t === 'isr' ? 'alerts' : t));
  }, [r.showISRPlan]);

  const tabs: { id: Tab; label: string; icon: string; badge?: number }[] = [
    { id: 'alerts', label: 'Alerts', icon: 'alert', badge: r.alertCounts.cues + r.alertCounts.reviews },
    { id: 'infra', label: 'Infrastructure', icon: 'layers' },
    ...(r.showISRPlan ? [{ id: 'isr' as Tab, label: 'ISR Sortie', icon: 'drone', badge: r.isrPlan.targetsInvestigated }] : []),
  ];

  return (
    <aside className="flex h-full w-full min-h-0 flex-col border-r border-ink-700 bg-ink-900 lg:w-[360px]">
      <div className="flex shrink-0 border-b border-ink-700" role="tablist">
        {tabs.map((t) => (
          <button
            key={t.id}
            role="tab"
            aria-selected={tab === t.id}
            onClick={() => setTab(t.id)}
            className={cn(
              'relative flex flex-1 items-center justify-center gap-1.5 px-2 py-3 text-xs font-bold transition-colors',
              tab === t.id ? 'text-brand' : 'text-mute hover:text-white'
            )}
          >
            <Icon name={t.icon} size={14} />
            {t.label}
            {!!t.badge && t.badge > 0 && (
              <span className={cn('rounded-full px-1.5 py-px text-[10px] font-bold', t.id === 'alerts' ? 'bg-cue text-white' : 'bg-ok text-ink-950')}>{t.badge}</span>
            )}
            {tab === t.id && <span className="absolute inset-x-3 bottom-0 h-0.5 rounded-full bg-brand" />}
          </button>
        ))}
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto">
        {tab === 'alerts' && <AlertsTab r={r} />}
        {tab === 'infra' && <InfraTab r={r} />}
        {tab === 'isr' && r.showISRPlan && <IsrTab r={r} />}
      </div>
    </aside>
  );
}

/* ---------------------------------------------------------------- alerts */
function AlertsTab({ r }: { r: Radar }) {
  const normal = r.analyzedVessels.length - r.alertCounts.cues - r.alertCounts.reviews;
  return (
    <div>
      <div className="flex items-center justify-between px-4 pb-2 pt-4">
        <h2 className="text-sm font-bold text-white">Prioritized Alert Queue</h2>
        <span className="text-[11px] text-mute">{r.analyzedVessels.length} tracked</span>
      </div>

      <div className="grid grid-cols-3 gap-2 px-4">
        <CountTile label="Cue" value={r.alertCounts.cues} cls="text-cue border-cue/40 bg-cue/10" />
        <CountTile label="Review" value={r.alertCounts.reviews} cls="text-review border-review/40 bg-review/10" />
        <CountTile label="Normal" value={Math.max(0, normal)} cls="text-soft border-ink-600 bg-ink-850" />
      </div>

      <div className="mx-4 mt-3 flex items-center justify-between rounded-lg border border-ink-700 bg-ink-850 px-3 py-2 text-[11px]">
        <span className="text-mute">24h Alert Episodes</span>
        <span
          className="cursor-help font-semibold text-brand"
          title="Reproducible Episode Rule: Requires contiguous 24h archive with 30m continuity threshold. Snapshot count is not an episode count."
        >
          Unavailable (Requires 24h baseline)
        </span>
      </div>

      <div className="mt-3 grid grid-cols-[1fr_auto_auto] items-center gap-3 border-y border-ink-700 bg-ink-850 px-4 py-1.5 text-[10px] font-bold uppercase tracking-wider text-mute">
        <span>Vessel</span>
        <span>Tier</span>
        <span className="w-12 text-right">Anomaly</span>
      </div>

      {r.analyzedVessels.length === 0 && <p className="px-4 py-8 text-center text-xs text-mute">No vessels in the current lookback window.</p>}

      <ul>
        {r.analyzedVessels.map((a) => {
          const sel = a.vessel.mmsi === r.selectedMmsi;
          const vis = vesselVisuals(a);
          return (
            <li key={a.vessel.mmsi}>
              <button
                onClick={() => r.setSelectedMmsi(a.vessel.mmsi)}
                className={cn(
                  'grid w-full grid-cols-[1fr_auto_auto] items-center gap-3 border-b border-ink-800 border-l-2 px-4 py-2.5 text-left transition-colors',
                  sel ? 'border-l-brand bg-brand/10' : 'border-l-transparent hover:bg-ink-850',
                  !sel && a.tier === 'cue' && 'bg-cue/5',
                  !sel && a.tier === 'review' && 'bg-review/5'
                )}
              >
                <div className="flex min-w-0 items-center gap-2.5">
                  <VesselGlyph color={vis.fill} rotate={a.vessel.cog ?? a.vessel.heading ?? 0} />
                  <div className="min-w-0">
                    <div className="flex items-center gap-1.5">
                      <span className={cn('truncate text-[13px] font-semibold', sel ? 'text-brand' : 'text-white')}>{a.vessel.name || a.vessel.mmsi}</span>
                      {a.isStale && <Badge tone="neutral" className="text-[8px]">Stale</Badge>}
                    </div>
                    <div className="truncate font-mono text-[10.5px] text-mute">
                      {a.vessel.ship_type || 'Unknown'} · {a.vessel.sog !== null ? `${a.vessel.sog}kn` : 'null'} · {fmtAge(a.fixAgeSec)} ago
                    </div>
                  </div>
                </div>
                <TierBadge tier={a.tier} />
                <span className={cn('tabular w-12 text-right font-mono text-xs font-bold', a.tier === 'cue' ? 'text-cue' : a.tier === 'review' ? 'text-review' : 'text-mute')}>
                  {a.score.toFixed(1)}
                </span>
              </button>
            </li>
          );
        })}
      </ul>
    </div>
  );
}

function CountTile({ label, value, cls }: { label: string; value: number; cls: string }) {
  return (
    <div className={cn('rounded-lg border px-3 py-2', cls)}>
      <div className="text-[9px] font-bold uppercase tracking-widest opacity-80">{label}</div>
      <div className="tabular text-xl font-bold leading-tight">{value}</div>
    </div>
  );
}

/* ---------------------------------------------------------------- infrastructure */
function InfraTab({ r }: { r: Radar }) {
  const custom = r.geomName.startsWith('Custom:');
  return (
    <div className="space-y-5 p-4">
      <div className="flex items-center justify-between">
        <h2 className="text-sm font-bold text-white">Subsea Infrastructure</h2>
        <Badge tone="brand">{r.activeCorridors.length} corridors active</Badge>
      </div>

      <div>
        <div className="mb-1 flex items-center justify-between">
          <FieldLabel>Buffer width</FieldLabel>
          <span className="tabular font-mono text-xs font-bold text-brand">{r.corridorKm} km</span>
        </div>
        <input
          aria-label="Corridor buffer width"
          type="range"
          min={1}
          max={12}
          step={1}
          value={r.corridorKm}
          onChange={(e) => r.setCorridorKm(Number(e.target.value))}
          className="fr-range w-full"
        />
        <p className="mt-1 text-[10.5px] text-mute">Vessels inside the buffer contribute to the proximity term of the anomaly score.</p>
      </div>

      <div className="rounded-xl border border-ink-700 bg-ink-850 p-3">
        <div className="flex items-center justify-between">
          <span className="text-[10px] font-bold uppercase tracking-wider text-mute">Active cable infrastructure</span>
          <button onClick={r.resetDefaultRoute} className="text-[11px] font-semibold text-brand hover:underline">
            Reset Default
          </button>
        </div>
        <p className="mt-1 truncate text-sm font-semibold text-white" title={r.geomName}>
          {r.geomName}
        </p>
        <label className="mt-2.5 flex cursor-pointer items-center justify-center gap-2 rounded-lg border border-dashed border-ink-500 px-3 py-2 text-xs font-semibold text-soft transition-colors hover:border-brand hover:text-brand">
          <Icon name="upload" size={14} />
          Load Custom GeoJSON
          <input type="file" accept=".geojson,.json" onChange={r.loadGeoJson} className="sr-only" />
        </label>
        <p className="mt-1.5 text-[10.5px] text-mute">WGS84 LineString / MultiLineString · max 2 MB · 3,000 vertices.</p>
      </div>

      <div>
        <FieldLabel>Corridors</FieldLabel>
        <ul className="overflow-hidden rounded-xl border border-ink-700">
          <CorridorRow
            active={r.geomName === 'ALL'}
            onClick={() => r.selectCorridor('ALL')}
            color="#ffc400"
            title={`★ All Corridors (${BALTIC_CORRIDOR_NETWORK.length} built-in Baltic infrastructure lines)`}
          />
          {custom && <CorridorRow active onClick={() => undefined} color="#f43f5e" title={r.geomName} sub="User uploaded GeoJSON" />}
          {REGION_GROUPS.map((g) => (
            <li key={g.label}>
              <div className="border-y border-ink-700 bg-ink-850 px-3 py-1.5 text-[9.5px] font-bold uppercase tracking-wider text-mute">{g.label}</div>
              <ul>
                {BALTIC_CORRIDOR_NETWORK.filter((c) => g.regions.includes(c.region)).map((c) => (
                  <CorridorRow
                    key={c.name}
                    active={r.geomName === c.name}
                    onClick={() => r.selectCorridor(c.name)}
                    color={c.color}
                    title={c.name}
                    sub={`${c.type}${c.endpoints ? ` · ${c.endpoints[0]} ↔ ${c.endpoints[1]}` : ''}`}
                  />
                ))}
              </ul>
            </li>
          ))}
        </ul>
      </div>
    </div>
  );
}

function CorridorRow({ active, onClick, color, title, sub }: { active: boolean; onClick: () => void; color: string; title: string; sub?: string }) {
  return (
    <li>
      <button
        onClick={onClick}
        className={cn(
          'flex w-full items-start gap-2.5 border-b border-ink-800 border-l-2 px-3 py-2 text-left transition-colors',
          active ? 'border-l-brand bg-brand/10' : 'border-l-transparent hover:bg-ink-850'
        )}
      >
        <span className="mt-1 h-2.5 w-2.5 shrink-0 rounded-full" style={{ background: color, boxShadow: `0 0 0 3px ${color}22` }} />
        <span className="min-w-0">
          <span className={cn('block text-xs font-semibold', active ? 'text-brand' : 'text-white')}>{title}</span>
          {sub && <span className="block truncate text-[10.5px] text-mute">{sub}</span>}
        </span>
      </button>
    </li>
  );
}

/* ---------------------------------------------------------------- ISR sortie */
function IsrTab({ r }: { r: Radar }) {
  const plan = r.isrPlan;
  const usedPct = Math.min(100, (plan.totalTimeMin / r.isrEnduranceMin) * 100);
  return (
    <div className="space-y-4 p-4">
      <div>
        <div className="flex items-center justify-between">
          <h2 className="flex items-center gap-2 text-sm font-bold text-white">
            <Icon name="drone" size={15} className="text-ok" /> ISR Sortie Route
          </h2>
          <Badge tone="ok">Fuel reserve ~{plan.fuelMarginMin.toFixed(0)} min</Badge>
        </div>
        <p className="mt-0.5 text-[11px] text-mute">
          {r.isrEnduranceMin}m endurance @ {r.isrSpeedMs}m/s
        </p>
      </div>

      {/* launch base */}
      <div className="space-y-2 rounded-xl border border-ink-700 bg-ink-850 p-3">
        <div className="flex items-center justify-between">
          <FieldLabel>Launch base station</FieldLabel>
          {r.customBase && (
            <button
              onClick={() => {
                r.setCustomBase(null);
                r.setIsPlacingBase(false);
              }}
              className="text-[11px] font-semibold text-brand hover:underline"
            >
              Reset to Default
            </button>
          )}
        </div>
        <select
          className={selectCls}
          value={r.customBase ? 'custom' : r.isrBaseId}
          onChange={(e) => {
            const val = e.target.value;
            if (val !== 'custom') {
              r.setIsrBaseId(val);
              r.setCustomBase(null);
              r.setIsPlacingBase(false);
            }
          }}
        >
          {PRESET_BASES.map((b) => (
            <option key={b.id} value={b.id}>
              {b.name} ({b.coords[0].toFixed(2)}°E, {b.coords[1].toFixed(2)}°N)
            </option>
          ))}
          {r.customBase && (
            <option value="custom">
              Custom Point ({r.customBase[0].toFixed(2)}°E, {r.customBase[1].toFixed(2)}°N)
            </option>
          )}
        </select>
        <button
          onClick={() => r.setIsPlacingBase(!r.isPlacingBase)}
          className={cn(
            'flex w-full items-center justify-center gap-2 rounded-lg border px-3 py-2 text-xs font-bold transition-colors',
            r.isPlacingBase ? 'blink border-brand bg-brand text-ink-950' : 'border-ok/50 bg-ok/10 text-ok hover:bg-ok/20'
          )}
        >
          <Icon name="target" size={14} />
          {r.isPlacingBase ? 'Click Map to Deploy Base…' : 'Deploy Base by Clicking Radar Map'}
        </button>
      </div>

      {/* flight envelope */}
      <div className="grid grid-cols-3 gap-2">
        <div>
          <FieldLabel>Max endurance</FieldLabel>
          <select className={selectCls} value={r.isrEnduranceMin} onChange={(e) => r.setIsrEnduranceMin(Number(e.target.value))}>
            <option value={45}>45 min</option>
            <option value={60}>60 min (std)</option>
            <option value={90}>90 min</option>
            <option value={120}>120 min</option>
          </select>
        </div>
        <div>
          <FieldLabel>Flight speed</FieldLabel>
          <select className={selectCls} value={r.isrSpeedMs} onChange={(e) => r.setIsrSpeedMs(Number(e.target.value))}>
            <option value={20}>20 m/s</option>
            <option value={25}>25 m/s (std)</option>
            <option value={30}>30 m/s</option>
            <option value={40}>40 m/s</option>
          </select>
        </div>
        <div>
          <FieldLabel>Target dwell</FieldLabel>
          <select className={selectCls} value={r.isrDwellMin} onChange={(e) => r.setIsrDwellMin(Number(e.target.value))}>
            <option value={2}>2 min</option>
            <option value={4}>4 min (std)</option>
            <option value={6}>6 min</option>
            <option value={10}>10 min</option>
          </select>
        </div>
      </div>

      {plan.legs.length > 0 ? (
        <div className="rounded-xl border border-ok/30 bg-ok/5 p-3">
          <div className="flex items-center justify-between text-xs">
            <span className="text-soft">Total mission time</span>
            <b className="tabular font-mono text-ok">
              {plan.totalTimeMin.toFixed(1)} min / {r.isrEnduranceMin} min
            </b>
          </div>
          <div className="mt-2 h-1.5 overflow-hidden rounded-full bg-ink-700">
            <div className="h-full rounded-full bg-ok" style={{ width: `${usedPct}%` }} />
          </div>
          <ol className="mt-3 space-y-1.5">
            {plan.legs.map((leg, idx) => (
              <li key={`plan-leg-${idx}`} className="rounded-lg border border-ink-700 bg-ink-900 px-3 py-2">
                <div className="flex items-center justify-between gap-2">
                  <span className="flex min-w-0 items-center gap-2 text-xs font-semibold text-white">
                    <span className="flex h-5 w-5 shrink-0 items-center justify-center rounded-full bg-ok text-[10px] font-bold text-ink-950">{idx + 1}</span>
                    <span className="truncate">{leg.name}</span>
                  </span>
                  <span className="tabular font-mono text-[11px] text-ok">+{leg.cumTimeMin.toFixed(0)}m</span>
                </div>
                <div className="mt-0.5 pl-7 text-[10.5px] text-mute">
                  Leg: {leg.distKm.toFixed(1)} km ({leg.flightMin.toFixed(1)}m flight + {leg.dwellMin}m dwell)
                </div>
              </li>
            ))}
          </ol>
        </div>
      ) : (
        <div className="rounded-xl border border-ink-700 bg-ink-850 p-3 text-xs text-mute">
          No active targets currently meet the threshold to justify dispatching the ISR platform from this base.
        </div>
      )}

      {plan.droppedTargets.length > 0 && (
        <div className="rounded-xl border border-cue/30 bg-cue/5 p-3">
          <div className="text-[10px] font-bold uppercase tracking-wider text-cue">Dropped targets (exceeds range)</div>
          <ul className="mt-1.5 space-y-1 text-[11px] text-soft">
            {plan.droppedTargets.map((d, i) => (
              <li key={`drop-${i}`}>
                • <b className="text-white">{d.name}</b>: {d.reason}
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}
