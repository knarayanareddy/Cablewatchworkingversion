'use client';

import { useState } from 'react';
import { cn } from '@/utils/cn';
import { useRadar } from '@/lib/radar/useRadar';
import { useSource } from '@/lib/radar/api';
import { TopBar } from '@/components/TopBar';
import { Icon } from '@/components/ui';
import { MapCanvas } from './MapCanvas';
import { LeftPanel } from './LeftPanel';
import { VesselPanel } from './VesselPanel';
import { PlaybackBar } from './PlaybackBar';
import { StatusStrip } from './StatusStrip';
import { DatasetModal } from './DatasetModal';

export default function RadarView() {
  const r = useRadar();
  const source = useSource();
  const [panelOpen, setPanelOpen] = useState(() => (typeof window === 'undefined' ? true : window.innerWidth >= 1024));

  return (
    <div className="flex h-full flex-col">
      <TopBar route="real">
        <SourceBadge source={source} />

        <button
          onClick={() => r.setShowModal(true)}
          className="flex items-center gap-1.5 rounded-lg border border-ink-600 bg-ink-800 px-3 py-2 text-xs font-bold text-white transition-colors hover:border-brand hover:text-brand"
        >
          <Icon name="db" size={14} />
          <span className="hidden sm:inline">Switch / Ingest Dataset</span>
          <span className="sm:hidden">Data</span>
        </button>

        <button
          onClick={() => r.setShowISRPlan(!r.showISRPlan)}
          aria-pressed={r.showISRPlan}
          className={cn(
            'flex items-center gap-1.5 rounded-lg border px-3 py-2 text-xs font-bold transition-colors',
            r.showISRPlan ? 'border-ok bg-ok text-ink-950' : 'border-ok/50 bg-ok/10 text-ok hover:bg-ok/20'
          )}
        >
          <Icon name="drone" size={14} />
          <span className="hidden sm:inline">ISR Sortie Planner</span>
          <span className="sm:hidden">ISR</span>
          {r.isrPlan.targetsInvestigated > 0 && <span className="tabular">({r.isrPlan.targetsInvestigated})</span>}
        </button>

        <span className="hidden rounded-lg border border-ink-600 bg-ink-850 px-2.5 py-2 text-xs text-soft md:inline">
          Corridor: <b className="text-brand">{r.corridorKm} km buffer</b>
        </span>

        {r.alertCounts.cues > 0 && (
          <span className="blink rounded-lg border border-cue/60 bg-cue/15 px-2.5 py-2 text-xs font-bold text-cue">{r.alertCounts.cues} CUE ALERTS</span>
        )}
        {r.alertCounts.reviews > 0 && (
          <span className="rounded-lg border border-review/60 bg-review/15 px-2.5 py-2 text-xs font-bold text-review">{r.alertCounts.reviews} REVIEWS</span>
        )}
      </TopBar>

      <StatusStrip r={r} />

      <div className="relative flex min-h-0 flex-1">
        {/* left sidebar (collapsible) */}
        <div className={cn('z-30 h-full shrink-0', panelOpen ? 'absolute inset-y-0 left-0 w-[min(360px,92vw)] lg:relative lg:w-[360px]' : 'relative w-0')}>
          {panelOpen && <LeftPanel r={r} />}
          <button
            onClick={() => setPanelOpen(!panelOpen)}
            aria-label={panelOpen ? 'Collapse sidebar' : 'Expand sidebar'}
            title={panelOpen ? 'Collapse sidebar' : 'Expand sidebar'}
            className="absolute left-full top-1/2 z-30 flex h-14 w-5 -translate-y-1/2 items-center justify-center rounded-r-lg border border-l-0 border-ink-600 bg-ink-900/95 text-soft shadow-lg transition-colors hover:text-brand"
          >
            <Icon name="chevron" size={14} className={panelOpen ? 'rotate-90' : '-rotate-90'} />
          </button>
        </div>

        {/* map region */}
        <div className="relative min-w-0 flex-1">
          <MapCanvas r={r} detailOpen={!!r.selectedVessel} />

          <VesselPanel r={r} />

          {!r.meta && (
            <div className="absolute inset-0 z-40 flex items-center justify-center bg-ink-950/85 backdrop-blur-sm">
              <div className="flex flex-col items-center gap-4 text-center">
                <div className="relative h-24 w-24 rounded-full border border-ok/40">
                  <div className="absolute inset-3 rounded-full border border-ok/30" />
                  <div className="absolute inset-7 rounded-full border border-ok/20" />
                  <div className="radar-sweep absolute inset-0 rounded-full" style={{ background: 'conic-gradient(from 0deg, rgba(46,230,166,0.55), rgba(46,230,166,0) 30%)' }} />
                  <div className="absolute left-1/2 top-1/2 h-1.5 w-1.5 -translate-x-1/2 -translate-y-1/2 rounded-full bg-ok" />
                </div>
                <p className="blink text-sm text-soft">Connecting to local AIS streaming database…</p>
              </div>
            </div>
          )}
        </div>
      </div>

      <PlaybackBar r={r} />
      <DatasetModal r={r} />
    </div>
  );
}

function SourceBadge({ source }: { source: ReturnType<typeof useSource> }) {
  if (source === 'probing') return null;
  const live = source === 'live';
  return (
    <span
      title={
        live
          ? 'Connected to the local AIS service on 127.0.0.1:8765'
          : 'The local AIS service is not reachable. Showing the real-AIS sample datasets bundled with the repository (work/*.sqlite). Run ./run.sh for full datasets.'
      }
      className={cn(
        'flex items-center gap-1.5 rounded-lg border px-2.5 py-2 text-[10px] font-bold uppercase tracking-wider',
        live ? 'border-ok/40 bg-ok/10 text-ok' : 'border-sky/40 bg-sky/10 text-sky'
      )}
    >
      <span className={cn('h-1.5 w-1.5 rounded-full', live ? 'blink bg-ok' : 'bg-sky')} />
      {live ? 'Live service' : 'Bundled sample'}
    </span>
  );
}
