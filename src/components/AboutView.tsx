'use client';

import { TopBar } from '@/components/TopBar';
import { Icon } from '@/components/ui';

const CAPABILITIES = [
  { icon: 'db', title: 'Streaming AIS ingestion', text: 'Direct extraction from Danish Maritime Authority archives into indexed SQLite databases with hot-swap support.' },
  { icon: 'alert', title: 'Contextual anomaly scoring', text: 'Class speed baselines, trawler / ferry suppression and a COG-vs-heading anchor-drag drift signature.' },
  { icon: 'info', title: 'Ranked, explained alerts', text: 'CUE, REVIEW and NORMAL tiers with human-readable justification strings built only from observed factors.' },
  { icon: 'drone', title: 'Single-asset ISR planner', text: 'Multi-leg routing with dwell time, return-to-base reserves and explicit reasons for dropped targets.' },
  { icon: 'globe', title: 'Multi-scale radar map', text: 'Drag-to-pan, wheel zoom, and one-click sector focus across Bornholm, the Belts, the Sound and the Kattegat.' },
  { icon: 'layers', title: 'Subsea infrastructure network', text: 'Fourteen built-in Baltic corridors plus custom WGS84 GeoJSON for instant proximity scoring.' },
];

export default function AboutView() {
  return (
    <div className="flex h-full flex-col">
      <TopBar route="about" />
      <main className="min-h-0 flex-1 overflow-y-auto">
        <section className="relative overflow-hidden border-b border-ink-700">
          <div
            className="pointer-events-none absolute inset-0 opacity-60"
            style={{ background: 'radial-gradient(60% 80% at 80% 0%, rgba(255,196,0,0.12), transparent 60%), radial-gradient(50% 60% at 0% 100%, rgba(61,184,255,0.10), transparent 60%)' }}
          />
          <div className="relative mx-auto max-w-5xl px-5 py-14 sm:py-20">
            <div className="text-[11px] font-bold uppercase tracking-[0.22em] text-brand">Cable Watch · Local Edition</div>
            <h1 className="mt-3 max-w-3xl text-4xl font-extrabold leading-tight tracking-tight text-white sm:text-5xl">Synthetic prototype &amp; AIS replay</h1>
            <p className="mt-5 max-w-2xl text-base leading-relaxed text-soft">
              This instance pairs the original Cable Watch synthetic prototype with a new local-data replay view. The original is unchanged; the local-data view uses different, limited review logic and does not inherit the synthetic detector or planner.
            </p>

            <div className="mt-6 flex max-w-2xl gap-3 rounded-2xl border border-review/50 bg-review/10 p-4 text-sm leading-relaxed text-amber-100">
              <Icon name="alert" size={18} className="mt-0.5 shrink-0 text-review" />
              <div>
                <b>Research only.</b> Real-data replay assumes source-time availability, is not a live feed, and cannot prove intent, anchor state, damage, risk or asset tasking. No real AIS validation has been done.
              </div>
            </div>

            <div className="mt-8 flex flex-wrap gap-3">
              <a href="/real" className="flex items-center gap-2 rounded-xl bg-brand px-5 py-3 text-sm font-bold text-ink-950 shadow-lg shadow-brand/20 transition-colors hover:bg-yellow-300">
                <Icon name="radar" size={16} /> Open local AIS replay →
              </a>
              <a href="/synthetic" className="flex items-center gap-2 rounded-xl border border-ink-500 bg-ink-800 px-5 py-3 text-sm font-bold text-white transition-colors hover:border-brand hover:text-brand">
                Open original synthetic Cable Watch →
              </a>
            </div>
          </div>
        </section>

        <section className="mx-auto max-w-5xl px-5 py-10">
          <h2 className="text-xs font-bold uppercase tracking-[0.2em] text-mute">Capabilities</h2>
          <div className="mt-4 grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
            {CAPABILITIES.map((c) => (
              <div key={c.title} className="rounded-2xl border border-ink-700 bg-ink-900 p-4 transition-colors hover:border-ink-500">
                <span className="flex h-9 w-9 items-center justify-center rounded-lg bg-ink-800 text-brand">
                  <Icon name={c.icon} size={18} />
                </span>
                <h3 className="mt-3 text-sm font-bold text-white">{c.title}</h3>
                <p className="mt-1 text-xs leading-relaxed text-mute">{c.text}</p>
              </div>
            ))}
          </div>

          <p className="mt-10 text-sm leading-relaxed text-mute">
            Read README.md before processing data. The local AIS service must be running for the replay of full datasets; without it the replay view falls back to the small real-AIS samples bundled with the repository. Run this edition only on your own machine; do not expose it to the internet.
          </p>
        </section>
      </main>
    </div>
  );
}
