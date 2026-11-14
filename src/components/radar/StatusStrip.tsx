import type { ReactNode } from 'react';
import type { Radar } from '@/lib/radar/useRadar';
import { reconnectLive } from '@/lib/radar/api';
import { Icon } from '@/components/ui';

export function StatusStrip({ r }: { r: Radar }) {
  const { meta, snap } = r;
  return (
    <div className="shrink-0">
      {r.error && (
        <div role="alert" className="flex items-center justify-between gap-3 border-b border-cue/40 bg-cue/15 px-4 py-2 text-xs text-red-100">
          <span className="flex items-center gap-2">
            <Icon name="alert" size={14} className="text-cue" />
            {r.error}
          </span>
          <div className="flex items-center gap-2">
            <button
              onClick={() => {
                r.setError('');
                reconnectLive();
                r.refreshMeta();
              }}
              className="rounded-md bg-cue px-2.5 py-1 font-mono text-[11px] font-bold text-white transition-colors hover:bg-red-500"
            >
              ↻ Reconnect
            </button>
            <button onClick={() => r.setError('')} aria-label="Dismiss error" className="text-red-200 hover:text-white">
              <Icon name="close" size={14} />
            </button>
          </div>
        </div>
      )}

      {meta && (
        <div className="flex flex-wrap items-center gap-x-5 gap-y-1 border-b border-ink-700 bg-ink-950 px-4 py-1.5 font-mono text-[10.5px]">
          <Item k="Observed span">
            {meta.min_timestamp_utc && meta.max_timestamp_utc ? `${meta.min_timestamp_utc} → ${meta.max_timestamp_utc}` : 'Unknown'}
          </Item>
          <Item k="Processing BBox">
            {meta.preprocessor_report?.bbox_west_south_east_north ? `[${meta.preprocessor_report.bbox_west_south_east_north.join(', ')}]` : 'Unknown'}
          </Item>
          <Item k="Total indexed fixes">{meta.records ? meta.records.toLocaleString() : 'Unknown'}</Item>
        </div>
      )}

      {meta?.preprocessor_report?.truncated_by_row_limit && (
        <Warn tag="Sample / Partial">
          <b>Dataset Ingestion Truncated:</b> Preprocessor stopped at row limit. Does not represent full-day coverage (observed until {meta.max_timestamp_utc}).
        </Warn>
      )}
      {snap?.truncated && (
        <Warn tag="Scan Capped">
          <b>Replay Query Truncated:</b> Snapshot hit safety limit ({snap.limits?.max_rows_scanned || 20000} scanned rows or {snap.limits?.max_vessels || 500} vessels). Some observations in this lookback window may be omitted.
        </Warn>
      )}
    </div>
  );
}

function Item({ k, children }: { k: string; children: ReactNode }) {
  return (
    <span className="flex items-center gap-1.5">
      <span className="text-mute">{k}</span>
      <span className="font-semibold text-brand">{children}</span>
    </span>
  );
}

function Warn({ tag, children }: { tag: string; children: ReactNode }) {
  return (
    <div className="flex items-center justify-between gap-3 border-b border-review/30 bg-review/10 px-4 py-1.5 text-[11.5px] text-amber-100">
      <span className="flex items-center gap-2">
        <span>⚠️</span>
        <span>{children}</span>
      </span>
      <span className="shrink-0 rounded border border-review/50 bg-review/20 px-2 py-0.5 text-[9.5px] font-bold uppercase tracking-wider text-review">{tag}</span>
    </div>
  );
}
