import { cn } from '@/utils/cn';
import type { Radar } from '@/lib/radar/useRadar';
import { Icon, selectCls } from '@/components/ui';

const SPEEDS: { v: number; label: string; hint: string }[] = [
  { v: 1, label: '1×', hint: '1x (Slow / 45s)' },
  { v: 5, label: '5×', hint: '5x (Cruising ~4m)' },
  { v: 15, label: '15×', hint: '15x (Fast Patrol ~11m)' },
  { v: 60, label: '60×', hint: '60x (High Speed ~45m)' },
  { v: 180, label: '180×', hint: '180x (Rush ~2h)' },
];

export function PlaybackBar({ r }: { r: Radar }) {
  const { meta } = r;
  if (!meta) return null;
  const pct = r.maxSec > r.minSec ? ((r.curSec - r.minSec) / (r.maxSec - r.minSec)) * 100 : 0;

  return (
    <div className="shrink-0 border-t border-ink-700 bg-ink-900 px-4 pb-2.5 pt-3">
      <div className="flex flex-wrap items-center gap-x-5 gap-y-3">
        {/* transport + clock */}
        <div className="flex items-center gap-3">
          <button
            onClick={() => r.setIsPlaying(!r.isPlaying)}
            aria-label={r.isPlaying ? 'Pause replay' : 'Play replay'}
            title={r.isPlaying ? 'Pause Replay' : 'Play Replay'}
            className={cn(
              'flex h-11 w-11 items-center justify-center rounded-full shadow-lg transition-all hover:scale-105 active:scale-95',
              r.isPlaying ? 'bg-brand text-ink-950 shadow-brand/30' : 'bg-brand text-ink-950 shadow-brand/20'
            )}
          >
            <Icon name={r.isPlaying ? 'pause' : 'play'} size={20} />
          </button>
          <div className="min-w-0">
            <div className="flex items-center gap-2 text-[10px] font-semibold uppercase tracking-wider text-mute">
              <span>Replay timestamp (UTC)</span>
              <span className="hidden truncate normal-case text-ink-500 sm:inline">· {meta.preprocessor_report.input_file}</span>
            </div>
            <div className="flex items-center gap-2">
              <span className="tabular font-mono text-lg font-bold leading-tight text-white">{r.at || meta.min_timestamp_utc}</span>
              {r.isPlaying && (
                <span className="rounded border border-ok/40 bg-ok/10 px-1.5 py-0.5 font-mono text-[10px] font-bold text-ok">
                  +{Math.round(45 * r.playbackSpeed)}s / step
                </span>
              )}
            </div>
          </div>
        </div>

        {/* scrubber */}
        <div className="order-last w-full min-w-0 lg:order-none lg:w-auto lg:flex-1">
          <div className="relative">
            <input
              aria-label="Replay time scrubber"
              type="range"
              min={r.minSec}
              max={r.maxSec}
              step={1}
              value={r.curSec}
              onChange={(e) => {
                r.setIsPlaying(false);
                r.setAt(new Date(Number(e.target.value) * 1000).toISOString().replace('.000Z', 'Z'));
              }}
              className="fr-range w-full"
              style={{ background: `linear-gradient(to right, var(--color-brand) ${pct}%, var(--color-ink-600) ${pct}%)` }}
            />
          </div>
          <div className="mt-1.5 flex items-center justify-between font-mono text-[10.5px] text-mute">
            <span>{meta.min_timestamp_utc}</span>
            <span className={cn('text-soft', r.busy && 'blink')}>
              {r.busy ? 'Streaming fixes…' : `${r.analyzedVessels.length} active vessels (${meta.records.toLocaleString()} total indexed)`}
            </span>
            <span>{meta.max_timestamp_utc}</span>
          </div>
        </div>

        {/* speed + lookback */}
        <div className="flex items-center gap-4">
          <div>
            <div className="mb-1 text-[10px] font-semibold uppercase tracking-wider text-mute">Speed</div>
            <div className="flex overflow-hidden rounded-lg border border-ink-600" role="group" aria-label="Playback speed">
              {SPEEDS.map((s) => (
                <button
                  key={s.v}
                  title={s.hint}
                  onClick={() => r.setPlaybackSpeed(s.v)}
                  className={cn(
                    'tabular border-r border-ink-600 px-2.5 py-1.5 text-[11px] font-bold transition-colors last:border-r-0',
                    r.playbackSpeed === s.v ? 'bg-brand text-ink-950' : 'bg-ink-850 text-soft hover:bg-ink-700 hover:text-white'
                  )}
                >
                  {s.label}
                </button>
              ))}
            </div>
          </div>
          <label className="block">
            <div className="mb-1 text-[10px] font-semibold uppercase tracking-wider text-mute">Lookback</div>
            <select
              value={r.win}
              onChange={(e) => {
                r.setSnap(null);
                r.setWin(Number(e.target.value));
              }}
              className={cn(selectCls, 'w-auto py-1.5')}
            >
              <option value={15}>15 min</option>
              <option value={30}>30 min</option>
              <option value={60}>60 min (1h)</option>
              <option value={180}>3 hours</option>
              <option value={360}>6 hours</option>
              <option value={720}>12 hours</option>
              <option value={1440}>24 hours (Full Day)</option>
            </select>
          </label>
        </div>
      </div>
    </div>
  );
}
