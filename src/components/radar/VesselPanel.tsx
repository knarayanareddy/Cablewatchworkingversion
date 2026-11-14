import { cn } from '@/utils/cn';
import type { Radar } from '@/lib/radar/useRadar';
import { formatFeatureName, formatFeatureValue } from '@/lib/radar/model';
import { Badge, Icon, Missing, Section, Stat, TierBadge, VesselGlyph, vesselVisuals } from '@/components/ui';

export function VesselPanel({ r }: { r: Radar }) {
  const sel = r.selectedVessel;
  if (!sel) return null;
  const v = sel.vessel;
  const vis = vesselVisuals(sel);
  const tone = sel.tier === 'cue' ? 'text-cue' : sel.tier === 'review' ? 'text-review' : 'text-white';
  const proximityPct = sel.dist !== null ? Math.max(0, Math.min(100, (sel.dist / Math.max(r.corridorKm, 0.001)) * 100)) : null;
  const ageText = sel.fixAgeSec < 60 ? `${sel.fixAgeSec}s ago` : `${Math.floor(sel.fixAgeSec / 60)}m ago`;
  const ts = r.experimentalTrackScore;

  return (
    <aside className="slide-in-right absolute inset-y-0 right-0 z-30 flex w-full flex-col border-l border-ink-700 bg-ink-900 shadow-2xl shadow-black/60 sm:w-[390px]" aria-label="Threat diagnostic HUD">
      {/* header */}
      <div className="relative shrink-0 overflow-hidden border-b border-ink-700 bg-linear-to-b from-ink-800 to-ink-900 px-4 pb-4 pt-3">
        <div className="mb-2 flex items-center justify-between">
          <span className="text-[10px] font-bold uppercase tracking-widest text-mute">Threat Diagnostic HUD</span>
          <button onClick={() => r.setSelectedMmsi(null)} aria-label="Close vessel panel" className="rounded-md p-1 text-mute transition-colors hover:bg-ink-700 hover:text-white">
            <Icon name="close" size={16} />
          </button>
        </div>
        <div className="flex items-start gap-3">
          <div className="mt-0.5 flex h-11 w-11 shrink-0 items-center justify-center rounded-xl border border-ink-600 bg-ink-950">
            <VesselGlyph color={vis.fill} size={26} rotate={v.cog ?? v.heading ?? 0} />
          </div>
          <div className="min-w-0 flex-1">
            <h2 className="truncate text-xl font-bold leading-tight text-white" title={v.name || 'UNSPECIFIED'}>
              {v.name || 'UNSPECIFIED'}
            </h2>
            <div className="mt-0.5 flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-mute">
              <span className="font-mono">MMSI {v.mmsi}</span>
              <span>·</span>
              <span>{v.ship_type || 'Undefined'}</span>
            </div>
          </div>
        </div>
        <div className="mt-3 flex items-center justify-between rounded-xl border border-ink-700 bg-ink-950/70 px-3 py-2">
          <div>
            <div className="text-[9px] font-bold uppercase tracking-widest text-mute">Single-fix score</div>
            <div className={cn('tabular font-mono text-2xl font-bold leading-none', tone)}>{sel.score.toFixed(2)}</div>
          </div>
          <div className="flex flex-col items-end gap-1">
            <TierBadge tier={sel.tier} className={cn('text-[11px]', sel.tier === 'cue' && 'blink')} />
            <span className="text-[10px] text-mute">{sel.tier === 'cue' ? 'tier · cue ≥ 4.2' : sel.tier === 'review' ? 'tier · review ≥ 2.2' : 'tier · below 2.2'}</span>
          </div>
        </div>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto">
        {/* corridor proximity (route-progress style bar) */}
        <div className="px-4 pt-4">
          <div className="mb-1.5 flex items-center justify-between text-[10px] font-bold uppercase tracking-wider text-mute">
            <span>Cable corridor proximity</span>
            <span className="font-mono normal-case text-soft">buffer {r.corridorKm} km</span>
          </div>
          <div className="relative h-2 overflow-hidden rounded-full bg-ink-700">
            {proximityPct !== null && (
              <div
                className={cn('absolute inset-y-0 left-0 rounded-full', sel.dist! <= 2 ? 'bg-cue' : sel.dist! <= r.corridorKm ? 'bg-review' : 'bg-ok')}
                style={{ width: `${Math.max(3, 100 - proximityPct)}%` }}
              />
            )}
          </div>
          <div className="mt-1 flex justify-between text-[10px] text-mute">
            <span>inside corridor</span>
            <span>≥ buffer edge</span>
          </div>
        </div>

        {/* telemetry */}
        <div className="grid grid-cols-2 gap-2 p-4">
          <Stat label="Speed (SOG)">{v.sog !== null ? `${v.sog} kn` : <Missing />}</Stat>
          <Stat label="Heading drift (Δ)">{sel.driftAngle !== null ? `${sel.driftAngle.toFixed(0)}°` : <Missing />}</Stat>
          <Stat label="Cable distance" tone={sel.dist !== null && sel.dist <= 2 ? 'cue' : 'ok'}>
            {sel.dist !== null ? `~${sel.dist.toFixed(2)} km` : 'N/A'}
          </Stat>
          <Stat label="Fix freshness (age)" tone={sel.isStale ? 'review' : undefined}>
            <span className="text-sm">
              {ageText} <span className={cn('text-[11px] font-medium', sel.isStale ? 'text-review' : 'text-ok')}>{sel.isStale ? '(STALE >15m)' : '(Fresh)'}</span>
            </span>
          </Stat>
        </div>

        {/* assessment */}
        <div className="px-4 pb-4">
          <div
            className={cn(
              'rounded-xl border p-3 text-[12.5px] leading-relaxed',
              sel.tier === 'cue' ? 'border-cue/40 bg-cue/10 text-red-100' : sel.tier === 'review' ? 'border-review/40 bg-review/10 text-amber-100' : 'border-ink-700 bg-ink-850 text-soft'
            )}
          >
            <b className="mb-1 block text-[10px] font-bold uppercase tracking-wider opacity-80">Single-Fix Heuristic Assessment</b>
            {sel.reason}
          </div>
        </div>

        {/* experimental track score */}
        <Section
          title="Experimental Track Score"
          icon="flask"
          right={
            ts ? (
              <Badge tone={ts.tier === 'cue' ? 'cue' : ts.tier === 'review' ? 'review' : 'neutral'}>
                {ts.score.toFixed(2)} · {ts.tier}
              </Badge>
            ) : r.trackLoading ? (
              <span className="text-[10px] text-mute">Loading track…</span>
            ) : (
              <span className="text-[10px] text-mute">No track data</span>
            )
          }
        >
          {r.trackData?.truncated && (
            <div className="mb-3 flex gap-2 rounded-lg border border-review/40 bg-review/10 p-2.5 text-[11px] text-amber-100">
              <span>⚠️</span>
              <div>
                <strong>Track Truncated:</strong> Replay query reached safety limit ({r.trackData.limit || 5000} fixes). Older fixes in this {r.trackData.window_minutes}m window were omitted to prioritize latest observations up to replay time.
              </div>
            </div>
          )}
          {ts && (
            <div className="space-y-2.5">
              <dl className="divide-y divide-ink-700 rounded-xl border border-ink-700 bg-ink-850 text-xs">
                <Row k="Track observations">
                  {ts.contributingFixesCount} fixes over {ts.timeSpanMin} min
                </Row>
                <Row k="Contiguous slow dwell" tone={ts.contiguousSlowMin >= 15 ? 'cue' : undefined}>
                  ~{ts.contiguousSlowMin} min ({ts.distinctSlowFixesCount} distinct obs)
                </Row>
                <Row k="Mean velocity">{ts.meanSog !== null ? `${ts.meanSog.toFixed(1)} kn` : 'N/A'}</Row>
                <Row k="Mean divergence">{ts.meanDriftAngle !== null ? `${ts.meanDriftAngle.toFixed(0)}°` : 'N/A'}</Row>
              </dl>
              <div className="rounded-lg border border-ink-700 bg-ink-950/60 p-2.5 text-[11.5px] leading-relaxed text-soft">{ts.reason}</div>
              <p className="text-[10.5px] italic leading-snug text-mute">
                * Note: AIS data provides behavioral telemetry only; it does not prove physical anchor deployment, seabed contact, damage, or intent.
              </p>
            </div>
          )}
          {!ts && !r.trackLoading && <p className="text-xs text-mute">No multi-fix track is available for this vessel at the replay time.</p>}
        </Section>

        {/* ML shadow */}
        <Section
          title={
            <span className="flex items-center gap-2">
              Pattern Comparison <Badge tone="violet">Shadow mode</Badge>
            </span>
          }
          icon="info"
          right={
            <span
              role="switch"
              aria-checked={r.enableMLShadow}
              tabIndex={0}
              title="Toggle ML shadow-mode second-opinion evaluation"
              onClick={(e) => {
                e.stopPropagation();
                r.toggleMLShadow();
              }}
              onKeyDown={(e) => {
                if (e.key === 'Enter' || e.key === ' ') {
                  e.preventDefault();
                  e.stopPropagation();
                  r.toggleMLShadow();
                }
              }}
              className={cn(
                'cursor-pointer rounded border px-1.5 py-0.5 font-mono text-[9px] font-bold transition-colors',
                r.enableMLShadow ? 'border-violet bg-violet/20 text-violet' : 'border-ink-600 bg-ink-800 text-mute hover:text-white'
              )}
            >
              {r.enableMLShadow ? 'SHADOW: ON' : 'SHADOW: OFF'}
            </span>
          }
        >
          <MLBlock r={r} />
        </Section>

        {/* evidence timeline */}
        <div className="border-t border-ink-700 p-4">
          <button
            onClick={() => r.setShowTimeline(!r.showTimeline)}
            className="flex w-full items-center justify-between rounded-lg border border-ink-600 bg-ink-850 px-3 py-2.5 text-xs font-bold text-soft transition-colors hover:border-brand hover:text-brand"
          >
            <span>{r.showTimeline ? '▲ Hide Evidence Timeline' : '▼ View Evidence Timeline'}</span>
            <span className="font-mono text-[11px] text-mute">({r.trackData?.fixes_count || 0} fixes)</span>
          </button>
          {r.showTimeline && r.trackData && (
            <div className="fade-in mt-3 rounded-xl border border-ink-700 bg-ink-850">
              <div className="flex items-center justify-between border-b border-ink-700 px-3 py-2 text-[10px] font-bold uppercase tracking-wider text-mute">
                <span>Evidence Observations (ts ≤ at)</span>
                <span>{r.trackData.fixes_count} fixes</span>
              </div>
              {r.trackData.truncated && (
                <div className="border-b border-ink-700 bg-review/10 px-3 py-2 text-[10.5px] text-amber-100">
                  ⚠️ Oldest observations in {r.trackData.window_minutes}m window omitted (safety cap {r.trackData.limit || 5000} fixes). Latest observations preserved up to replay time.
                </div>
              )}
              <ol className="max-h-72 divide-y divide-ink-700/60 overflow-y-auto font-mono text-[11px]">
                {ts?.contributingFixes.map((f, i) => (
                  <li key={`fix-${i}`} className={cn('flex items-center justify-between gap-2 px-3 py-1.5', f.isConflicting && 'bg-cue/10 text-red-200')}>
                    <div className="flex items-center gap-1.5">
                      <span className="inline-block h-1.5 w-1.5 rounded-full bg-brand" />
                      <span className="text-white">{f.timestamp.slice(11, 19)}Z</span>
                      {f.gapSec !== null && f.gapSec > 0 && <span className="text-mute">(+{(f.gapSec / 60).toFixed(1)}m)</span>}
                      {f.isConflicting && <Badge tone="cue" className="text-[8px]">Conflicting pos</Badge>}
                    </div>
                    <div className="flex gap-2.5 text-mute">
                      <span>
                        SOG <b className="text-soft">{f.sog !== null ? `${f.sog.toFixed(1)}kn` : <i>missing</i>}</b>
                      </span>
                      <span>
                        HDG <b className="text-soft">{f.heading !== null ? `${f.heading.toFixed(0)}°` : <i>missing</i>}</b>
                      </span>
                      <span>
                        Dist <b className="text-soft">{f.distKm !== null ? `${f.distKm.toFixed(1)}km` : 'N/A'}</b>
                      </span>
                    </div>
                  </li>
                ))}
              </ol>
              <div className="border-t border-ink-700 px-3 py-2 text-[10.5px] italic leading-snug text-mute">
                Evidence timeline displays observations up to replay time. Single-fix score uses latest fix; experimental score evaluates sustained sequence.
              </div>
            </div>
          )}
        </div>
      </div>
    </aside>
  );
}

function Row({ k, children, tone }: { k: string; children: React.ReactNode; tone?: 'cue' }) {
  return (
    <div className="flex items-center justify-between gap-3 px-3 py-2">
      <dt className="text-mute">{k}</dt>
      <dd className={cn('tabular text-right font-semibold', tone === 'cue' ? 'text-cue' : 'text-white')}>{children}</dd>
    </div>
  );
}

function MLBlock({ r }: { r: Radar }) {
  const ml = r.mlScore;
  if (!r.enableMLShadow) {
    return (
      <div className="rounded-lg border border-dashed border-ink-600 p-3 text-center text-[11.5px] text-mute">
        Historical pattern comparison is disabled (default-off).
        <br />
        <span className="text-violet">Click toggle to enable</span>
      </div>
    );
  }
  if (r.mlLoading) return <div className="blink text-xs text-soft">⏳ Evaluating 60m track window against baseline model…</div>;
  if (!ml) return <div className="text-xs text-mute">No ML shadow evaluation available for this vessel.</div>;

  if (ml.status === 'ok') {
    const pct = ml.anomaly_percentile ?? 0;
    return (
      <div className="space-y-3">
        <div className="grid grid-cols-2 gap-2">
          <div className="rounded-lg border border-violet/30 bg-violet/10 p-2.5">
            <div className="text-[9px] font-bold uppercase tracking-widest text-violet">Historical anomaly rank</div>
            <div className="mt-0.5 flex items-baseline gap-1.5">
              <span className="font-mono text-xl font-bold text-white">P{ml.anomaly_percentile !== undefined ? ml.anomaly_percentile.toFixed(1) : '--'}</span>
            </div>
            <div className="text-[10px] text-soft">({pct >= 95 ? 'Unusual local pattern' : 'Consistent with baseline'})</div>
          </div>
          <div className="rounded-lg border border-ink-700 bg-ink-850 p-2.5">
            <div className="text-[9px] font-bold uppercase tracking-widest text-mute">Baseline deviation</div>
            <div className="mt-0.5 font-mono text-xl font-bold text-white">{ml.baseline_robust_score !== undefined ? `${ml.baseline_robust_score.toFixed(2)}σ` : '--'}</div>
          </div>
        </div>

        {ml.is_synthetic_demo && (
          <div className="flex gap-2 rounded-lg border border-review/40 bg-review/10 p-2.5 text-[11px] text-amber-100">
            <span>⚠️</span>
            <div>
              <strong>DEMONSTRATION ONLY:</strong> Synthetic reference baseline. Real multi-day historical AIS archive was unavailable; real-data fitting is blocked. Do not rely on for operational decisions.
            </div>
          </div>
        )}

        {ml.comparison_features && ml.comparison_features.length > 0 && (
          <div>
            <div className="mb-1 text-[10px] font-bold uppercase tracking-wider text-mute">Observed vs historical baseline (60m window)</div>
            <div className="overflow-x-auto rounded-lg border border-ink-700">
              <table className="w-full text-left text-[11px]">
                <thead className="bg-ink-850 text-[9.5px] uppercase tracking-wider text-mute">
                  <tr>
                    <th className="p-1.5 font-semibold">Feature</th>
                    <th className="p-1.5 font-semibold">Observed</th>
                    <th className="p-1.5 font-semibold">Ref median ± IQR</th>
                    <th className="p-1.5 text-right font-semibold">Deviation</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-ink-700/60 font-mono">
                  {ml.comparison_features.map((feat) => (
                    <tr key={feat.name}>
                      <td className="p-1.5 font-sans text-soft">{formatFeatureName(feat.name)}</td>
                      <td className="p-1.5 text-white">{formatFeatureValue(feat.name, feat.value, feat.unit)}</td>
                      <td className="p-1.5 text-mute">
                        {formatFeatureValue(feat.name, feat.training_median, feat.unit)} ± {formatFeatureValue(feat.name, feat.training_iqr, feat.unit)}
                      </td>
                      <td className={cn('p-1.5 text-right font-bold', feat.robust_deviation >= 3 ? 'text-cue' : feat.robust_deviation >= 1.5 ? 'text-review' : 'text-mute')}>
                        {feat.robust_deviation.toFixed(1)}× IQR
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        )}

        <div className="space-y-1 rounded-lg border border-ink-700 bg-ink-950/60 p-2.5 font-mono text-[10px] text-mute">
          <div className="flex flex-wrap justify-between gap-x-3">
            <span>
              Model ID: <b className="text-soft">{ml.model_id}</b>
            </span>
            <span>
              Area/Class: <b className="text-soft">{ml.area_id} / {ml.class_group}</b>
            </span>
          </div>
          <div className="flex flex-wrap justify-between gap-x-3">
            <span>
              Track window:{' '}
              <b className="text-soft">
                {(ml.track_window?.observed_span_minutes ?? ml.track_window?.span_minutes ?? 0).toFixed(0)}m ({ml.track_window?.distinct_fixes ?? ml.track_window?.distinct_timestamps ?? 0} fixes)
              </b>
            </span>
            <span>
              Ref end: <b className="text-soft">{ml.training_end}</b>
            </span>
          </div>
        </div>

        <p className="text-[10.5px] italic leading-snug text-mute">
          * Experimental second opinion: Historical anomaly assessment does not classify danger, anchor deployment, seabed contact, damage, or intent. Ordinary local patterns or AIS jitter may produce unusual scores. Alert queue order and ISR mission dispatch remain completely unaffected.
        </p>
      </div>
    );
  }

  return (
    <div className="space-y-2 rounded-lg border border-ink-700 bg-ink-850 p-3 text-[11.5px]">
      <div className="flex items-center gap-2 font-bold text-soft">
        <Icon name="info" size={14} className="text-violet" />
        ML Shadow Comparison: {ml.status.toUpperCase()}
      </div>
      <div className="leading-relaxed text-mute">{ml.reason || 'Pattern comparison could not be computed for this vessel at the replay time.'}</div>
      {ml.details && (
        <div className="space-y-0.5 font-mono text-[10px] text-mute">
          {Object.entries(ml.details).map(([k, val]) => (
            <div key={k}>
              {k}: <span className="text-soft">{String(val)}</span>
            </div>
          ))}
        </div>
      )}
      <div className="text-[10.5px] italic text-mute">Quality gate requires ≥3 distinct fixes, ≥15m span, no gaps &gt;15m, and newest fix age ≤15m.</div>
    </div>
  );
}
