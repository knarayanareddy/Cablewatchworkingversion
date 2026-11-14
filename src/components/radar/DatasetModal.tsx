import { cn } from '@/utils/cn';
import type { Radar } from '@/lib/radar/useRadar';
import { FieldLabel, Icon, inputCls, selectCls } from '@/components/ui';
import { useSource } from '@/lib/radar/api';

export function DatasetModal({ r }: { r: Radar }) {
  const source = useSource();
  if (!r.showModal) return null;
  const close = () => r.setShowModal(false);

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 p-4 backdrop-blur-sm" onClick={close} role="dialog" aria-modal="true" aria-label="Dataset manager">
      <div className="fade-in flex max-h-[90vh] w-full max-w-2xl flex-col overflow-hidden rounded-2xl border border-ink-600 bg-ink-900 shadow-2xl shadow-black" onClick={(e) => e.stopPropagation()}>
        <div className="flex items-center justify-between border-b border-ink-700 bg-ink-850 px-5 py-4">
          <h2 className="flex items-center gap-2.5 text-base font-bold text-white">
            <span className="flex h-8 w-8 items-center justify-center rounded-lg bg-brand text-ink-950">
              <Icon name="db" size={16} />
            </span>
            Dataset Manager &amp; Pipeline Ingestion
          </h2>
          <button onClick={close} aria-label="Close" className="rounded-md p-1.5 text-mute hover:bg-ink-700 hover:text-white">
            <Icon name="close" size={18} />
          </button>
        </div>

        <div className="space-y-6 overflow-y-auto p-5">
          {source === 'sample' && (
            <div className="rounded-lg border border-sky/40 bg-sky/10 px-3 py-2 text-xs text-sky">
              The local AIS service is not reachable, so the bundled real-AIS sample datasets are listed. Run <code className="rounded bg-ink-950 px-1 font-mono">./run.sh</code> to switch between and ingest your own archives.
            </div>
          )}

          {/* switch */}
          <section>
            <div className="mb-2 flex items-center justify-between">
              <h3 className="text-xs font-bold uppercase tracking-wider text-soft">Available Ingested Datasets</h3>
              <span className="text-[11px] text-mute">Stored locally in work/</span>
            </div>
            <div className="max-h-56 space-y-2 overflow-y-auto pr-1">
              {r.datasets.length === 0 ? (
                <div className="rounded-lg border border-dashed border-ink-600 p-4 text-center text-xs text-mute">No datasets found in work/</div>
              ) : (
                r.datasets.map((db) => (
                  <div
                    key={db.id}
                    className={cn('flex items-center justify-between gap-3 rounded-xl border px-3.5 py-3', db.active ? 'border-ok/50 bg-ok/10' : 'border-ink-700 bg-ink-850')}
                  >
                    <div className="min-w-0">
                      <div className="flex items-center gap-2">
                        <span className={cn('truncate font-mono text-sm font-semibold', db.active ? 'text-ok' : 'text-white')}>{db.id}</span>
                        {db.active && <span className="rounded bg-ok px-1.5 py-0.5 text-[9px] font-bold text-ink-950">ACTIVE</span>}
                      </div>
                      <div className="mt-0.5 text-[11px] text-mute">
                        {db.records.toLocaleString()} fixes · {db.min_timestamp_utc ? db.min_timestamp_utc.slice(0, 16) : 'N/A'}
                      </div>
                    </div>
                    {!db.active && (
                      <button
                        onClick={() => r.handleSwitchDataset(db.id)}
                        className="shrink-0 rounded-lg border border-brand/60 bg-brand/10 px-3 py-1.5 text-xs font-bold text-brand transition-colors hover:bg-brand hover:text-ink-950"
                      >
                        Load Dataset →
                      </button>
                    )}
                  </div>
                ))
              )}
            </div>
          </section>

          {/* ingest */}
          <section className="rounded-xl border border-ink-700 bg-ink-850 p-4">
            <h3 className="mb-3 text-xs font-bold uppercase tracking-wider text-soft">Ingest New AIS Archive (Any Date / Region)</h3>
            <div className="space-y-3">
              <div>
                <FieldLabel>Source ZIP file</FieldLabel>
                {r.discoveredZips.length > 0 ? (
                  <select value={r.selectedZipPath} onChange={(e) => r.setSelectedZipPath(e.target.value)} className={selectCls}>
                    {r.discoveredZips.map((z) => (
                      <option key={z.path} value={z.path}>
                        {z.name} ({z.size_mb} MB) — {z.path}
                      </option>
                    ))}
                  </select>
                ) : (
                  <input type="text" placeholder="~/Downloads/aisdk-YYYY-MM-DD.zip" value={r.selectedZipPath} onChange={(e) => r.setSelectedZipPath(e.target.value)} className={cn(inputCls, 'font-mono')} />
                )}
              </div>
              <div className="grid gap-3 sm:grid-cols-2">
                <div>
                  <FieldLabel>Target corridor / preset</FieldLabel>
                  <select value={r.ingestPreset} onChange={(e) => r.setIngestPreset(e.target.value)} className={selectCls}>
                    <option value="baltic">Bornholm / Arkona Basin (Baltic)</option>
                    <option value="fehmarn">Fehmarn Belt</option>
                    <option value="storebaelt">Great Belt (Storebælt)</option>
                    <option value="oresund">The Sound (Øresund)</option>
                  </select>
                </div>
                <div>
                  <FieldLabel>Sample size</FieldLabel>
                  <select value={r.ingestMaxRows} onChange={(e) => r.setIngestMaxRows(Number(e.target.value))} className={selectCls}>
                    <option value={100000}>100k rows (~1s smoke test)</option>
                    <option value={1000000}>1M rows (~10s standard sample)</option>
                    <option value={5000000}>5M rows (~30s multi-hour sample)</option>
                    <option value={0}>Full 24-Hour Day (~2-3 mins)</option>
                  </select>
                </div>
              </div>
              <div>
                <FieldLabel>Dataset name (optional)</FieldLabel>
                <input type="text" placeholder="e.g. baltic_jan13_run" value={r.customDatasetName} onChange={(e) => r.setCustomDatasetName(e.target.value)} className={cn(inputCls, 'font-mono')} />
              </div>
            </div>

            {r.ingestStatus && <div className="blink mt-3 rounded-lg border border-sky/40 bg-sky/10 px-3 py-2 text-xs text-sky">{r.ingestStatus}</div>}

            <div className="mt-4 flex justify-end gap-2">
              <button onClick={close} disabled={r.isIngesting} className="rounded-lg border border-ink-600 px-4 py-2 text-xs font-bold text-soft transition-colors hover:bg-ink-700 hover:text-white disabled:opacity-50">
                Cancel
              </button>
              <button
                onClick={r.handleRunIngest}
                disabled={r.isIngesting}
                className="flex items-center gap-2 rounded-lg bg-brand px-4 py-2 text-xs font-bold text-ink-950 transition-colors hover:bg-yellow-300 disabled:opacity-60"
              >
                {r.isIngesting ? (
                  <>
                    <span className="h-3 w-3 animate-spin rounded-full border-2 border-ink-950 border-t-transparent" />
                    Ingesting…
                  </>
                ) : (
                  'Run Ingestion & Activate'
                )}
              </button>
            </div>
          </section>
        </div>
      </div>
    </div>
  );
}
