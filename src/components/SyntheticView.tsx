'use client';

import { useEffect, useMemo, useState } from "react";
import { cn } from "@/utils/cn";
import { TopBar } from "@/components/TopBar";
import { Icon, selectCls } from "@/components/ui";
import { DEFAULT_CFG, burdenFor, configHash, fmtMin, incidentRows, replay, viewAt, type Config, type DayBurden, type ViewMode } from "@/lib/cablewatch/detect";
import { ASSET_KM_MIN, DEFAULT_DWELL_MIN, DEFAULT_ENDURANCE_MIN, candidates, pathPoints, plan, positionAt } from "@/lib/cablewatch/plan";
import { BASE, CABLE, FERRY_ROUTE, FISHING_ZONE, H, JUDGE_DAYS, REPLAY_KEY, W, dayCoverage, makeDay, withFutureSpike, type Day } from "@/lib/cablewatch/sim";

type Case = "replay" | "judge";
const Y = (y: number) => H - y;

function shiftDay(key: string, delta: number) {
  const d = new Date(key + "T00:00:00Z");
  d.setUTCDate(d.getUTCDate() + delta);
  return d.toISOString().slice(0, 10);
}
const sigOf = (eps: ReturnType<typeof replay>, upTo: number) => JSON.stringify(eps.map((e) => e.revs.filter((r) => r.t <= upTo).map((r) => [r.t, +r.score.toFixed(6), r.tier])).filter((r) => r.length));

function CableWatchSim() {
  const [mode, setMode] = useState<Case>("replay");
  const [date, setDate] = useState("2026-09-11");
  const [view, setView] = useState<ViewMode>("causal");
  const [cfg, setCfg] = useState<Config>(DEFAULT_CFG);
  const [now, setNow] = useState(480);
  const [play, setPlay] = useState(false);
  const [sel, setSel] = useState<string | null>(null);
  const [endurance, setEndurance] = useState(DEFAULT_ENDURANCE_MIN);
  const [dwell, setDwell] = useState(DEFAULT_DWELL_MIN);
  const [asset, setAsset] = useState<{ tPlan: number; start: [number, number]; left: number; launched: boolean } | null>(null);
  const [week, setWeek] = useState<DayBurden[] | null>(null);
  const [check, setCheck] = useState<{ ok: boolean; T: number } | null>(null);
  const [loading, setLoading] = useState(false);

  const dayKey = mode === "replay" ? REPLAY_KEY : date;
  const day: Day = useMemo(() => makeDay(dayKey), [dayKey]);
  const eps = useMemo(() => replay(day.vessels, cfg), [day, cfg]);
  const views = useMemo(() => viewAt(eps, now, view), [eps, now, view]);
  const hash = configHash(cfg);
  const modified = hash !== configHash(DEFAULT_CFG);
  const cov = useMemo(() => dayCoverage(day), [day]);
  const rows = useMemo(() => incidentRows(day, eps), [day, eps]);
  const selView = views.find((v) => v.ep.id === sel) ?? null;

  useEffect(() => {
    setWeek(null);
    setAsset(null);
    setSel(null);
    setCheck(null);
  }, [dayKey, cfg]);
  useEffect(() => {
    if (!play) return;
    const id = setInterval(() => setNow((n) => (n >= 1438 ? 0 : n + 2)), 140);
    return () => clearInterval(id);
  }, [play]);

  // planner: before launch it previews a sortie from base starting NOW; after launch it is fixed until "Replan".
  const planStart = asset ?? { tPlan: now, start: BASE as [number, number], left: endurance, launched: false };
  const planViews = useMemo(() => viewAt(eps, planStart.tPlan, view), [eps, planStart.tPlan, view]);
  const cands = useMemo(() => candidates(day, planViews, planStart.tPlan), [day, planViews, planStart.tPlan]);
  const p = useMemo(() => plan(cands, planStart.start, planStart.left, dwell), [cands, planStart.start, planStart.left, dwell]);
  const assetPos: [number, number] | null = asset ? positionAt(p, Math.min(Math.max(0, now - asset.tPlan), p.tHome + 1)) : null;
  const usedMin = asset ? Math.max(0, now - asset.tPlan) : 0;
  const rankOf = (id: string) => views.findIndex((v) => v.ep.id === id) + 1;

  const runWeek = () => {
    setLoading(true);
    setTimeout(() => {
      const keys = mode === "replay" ? [`${REPLAY_KEY}#1`, `${REPLAY_KEY}#2`, `${REPLAY_KEY}#3`, REPLAY_KEY, `${REPLAY_KEY}#4`, `${REPLAY_KEY}#5`, `${REPLAY_KEY}#6`] : [-3, -2, -1, 0, 1, 2, 3].map((d) => shiftDay(date, d));
      setWeek(keys.map((k) => { const d = makeDay(k); return burdenFor(d, replay(d.vessels, cfg)); }));
      setLoading(false);
    }, 20);
  };
  const runCheck = () => {
    const a = sigOf(eps, now);
    const b = sigOf(replay(withFutureSpike(day, now).vessels, cfg), now);
    setCheck({ ok: a === b, T: now });
  };

  const numIn = (label: string, k: "corridorKm" | "review" | "cue", min: number, max: number, step: number) => (
    <label className="flex items-center gap-2 text-xs font-semibold text-soft">
      {label}
      <input
        type="number"
        min={min}
        max={max}
        step={step}
        value={cfg[k]}
        onChange={(e) => setCfg({ ...cfg, [k]: Number(e.target.value) })}
        className="w-16 rounded-md border border-ink-600 bg-ink-900 px-2 py-1 font-mono text-xs text-white outline-none focus:border-brand"
      />
    </label>
  );

  const open = views.filter((v) => v.open);
  const card = "rounded-2xl border border-ink-700 bg-ink-900";
  const h3 = "text-sm font-bold text-white";
  const btn = "rounded-lg border border-ink-600 bg-ink-800 px-3 py-1.5 text-xs font-bold text-soft transition-colors hover:border-brand hover:text-brand disabled:opacity-50";
  const btnPrimary = "rounded-lg bg-brand px-3 py-1.5 text-xs font-bold text-ink-950 transition-colors hover:bg-yellow-300 disabled:opacity-50";
  const fieldCls = "w-16 rounded-md border border-ink-600 bg-ink-900 px-2 py-1 font-mono text-xs text-white outline-none focus:border-brand";
  const th = "px-2 py-1.5 text-left text-[10px] font-bold uppercase tracking-wider text-mute";
  const td = "px-2 py-1.5 align-top";

  return (
    <div className="space-y-4">
      <div role="note" className="flex gap-3 rounded-2xl border border-review/50 bg-review/10 p-4 text-sm text-amber-100">
        <Icon name="alert" size={18} className="mt-0.5 text-review" />
        <div>
          <b>MOCK / SYNTHETIC.</b> Fictional strait, fictional cable corridor, generated vessels. This is <b>not AIS data</b>, not the Mantavia area and not a real incident. Alerts are for human verification — never a verdict about intent, anchor state or damage.
        </div>
      </div>

      {/* controls */}
      <div className={cn(card, "flex flex-wrap items-center gap-x-5 gap-y-3 p-3")}>
        <div role="tablist" aria-label="Case" className="flex overflow-hidden rounded-lg border border-ink-600 text-xs">
          {(["replay", "judge"] as Case[]).map((c) => (
            <button
              key={c}
              role="tab"
              aria-selected={mode === c}
              onClick={() => setMode(c)}
              className={cn("px-3.5 py-2 font-bold transition-colors", mode === c ? "bg-brand text-ink-950" : "bg-ink-850 text-soft hover:bg-ink-700 hover:text-white")}
            >
              {c === "replay" ? "Incident replay (synthetic)" : "Judge-selected date"}
            </button>
          ))}
        </div>
        {mode === "judge" && (
          <label className="flex items-center gap-2 text-xs font-semibold text-soft">
            Date (7–16 Sep 2026)
            <select value={date} onChange={(e) => setDate(e.target.value)} className={cn(selectCls, "w-auto")}>
              {JUDGE_DAYS.map((d) => <option key={d}>{d}</option>)}
            </select>
          </label>
        )}
        <label className="flex items-center gap-2 text-xs font-semibold text-soft">
          Display
          <select value={view} onChange={(e) => setView(e.target.value as ViewMode)} className={cn(selectCls, "w-auto")}>
            <option value="causal">Causal (only data available by now)</option>
            <option value="leaky">LEAKY — reproduces the reviewed bug</option>
          </select>
        </label>
        <div className="flex flex-wrap items-center gap-3">
          {numIn("corridor km", "corridorKm", 2, 15, 1)}
          {numIn("review ≥", "review", 1, 5, 0.1)}
          {numIn("cue ≥", "cue", 1.5, 6, 0.1)}
          <span className={cn("rounded-md border px-2 py-1 font-mono text-[11px]", modified ? "border-review/50 bg-review/10 text-review" : "border-ink-600 bg-ink-850 text-mute")}>
            config {hash} · {modified ? "MODIFIED — numbers not comparable with frozen run" : "frozen default"}
          </span>
          {modified && <button onClick={() => setCfg(DEFAULT_CFG)} className={btn}>Reset config</button>}
        </div>
      </div>

      {view === "leaky" && (
        <div role="alert" className="rounded-2xl border border-cue/50 bg-cue/10 p-3 text-sm text-red-100">
          LEAKY display on: each alert shows the whole-episode peak score/tier, which can include data from up to {Math.max(0, ...views.map((v) => v.leakMin))} min in the future. Any “first alert” or planning built on this view is invalid. Switch back to Causal.
        </div>
      )}

      <div className="grid gap-4 lg:grid-cols-[minmax(0,1.5fr)_minmax(0,1fr)]">
        {/* map + replay */}
        <div className={cn(card, "overflow-hidden")}>
          <svg viewBox={`0 0 ${W} ${H}`} role="img" aria-label="Map of the fictional strait with vessels, cable corridor, alerts and the planned sortie" className="block w-full bg-[#0b131f]">
            <defs>
              <pattern id="g" width="10" height="10" patternUnits="userSpaceOnUse"><path d="M10 0H0V10" fill="none" stroke="#ffffff" strokeOpacity="0.07" strokeWidth="0.15" /></pattern>
            </defs>
            <rect width={W} height={H} fill="url(#g)" />
            <polyline points={CABLE.map(([x, y]) => `${x},${Y(y)}`).join(" ")} fill="none" stroke="#ffc400" strokeOpacity="0.14" strokeWidth={cfg.corridorKm * 2} strokeLinejoin="round" />
            <polyline points={CABLE.map(([x, y]) => `${x},${Y(y)}`).join(" ")} fill="none" stroke="#ffc400" strokeWidth="0.5" strokeDasharray="1.5 1" />
            <text x={CABLE[3][0] + 1.5} y={Y(CABLE[3][1]) + 4} fontSize="2.2" fill="#ffc400">cable corridor (fictional)</text>
            <line x1="0" y1={Y(45)} x2={W} y2={Y(45)} stroke="#94a3b8" strokeOpacity="0.5" strokeDasharray="0.8 1.6" strokeWidth="0.3" />
            <text x="1" y={Y(45) - 1} fontSize="2" fill="#94a3b8">shipping lane</text>
            <polyline points={FERRY_ROUTE.map(([x, y]) => `${x},${Y(y)}`).join(" ")} stroke="#a98bff" strokeOpacity="0.6" strokeWidth="0.3" fill="none" strokeDasharray="0.5 1" />
            <rect x={FISHING_ZONE.x1} y={Y(FISHING_ZONE.y2)} width={FISHING_ZONE.x2 - FISHING_ZONE.x1} height={FISHING_ZONE.y2 - FISHING_ZONE.y1} fill="#ff6fb1" fillOpacity="0.07" stroke="#ff6fb1" strokeOpacity="0.5" strokeDasharray="1 1" strokeWidth="0.3" />
            <text x={FISHING_ZONE.x1 + 1} y={Y(FISHING_ZONE.y2) + 3} fontSize="2" fill="#ff9fcd">fishing zone</text>
            {/* vessels: last received fix + 20 min trail */}
            {day.vessels.map((v) => {
              const vis = v.pts.filter((q) => q.tRecv <= now && q.tObs >= now - 20).sort((a, b) => a.tObs - b.tObs);
              if (!vis.length) return null;
              const l = vis[vis.length - 1];
              return (
                <g key={v.id}>
                  <polyline points={vis.map((q) => `${q.x},${Y(q.y)}`).join(" ")} fill="none" stroke="#cbd5e1" strokeOpacity="0.45" strokeWidth="0.3" />
                  <circle cx={l.x} cy={Y(l.y)} r="0.8" fill="#ffc400" stroke="#080d16" strokeWidth="0.25" />
                </g>
              );
            })}
            {/* planner candidate uncertainty + path */}
            {p.legs.length > 0 && <polyline points={pathPoints(p).map(([x, y]) => `${x},${Y(y)}`).join(" ")} fill="none" stroke="#2ee6a6" strokeWidth="0.5" strokeDasharray="1.2 0.8" />}
            {cands.map((c) => <circle key={c.id} cx={c.x} cy={Y(c.y)} r={Math.min(c.uncKm, 15)} fill="none" stroke="#2ee6a6" strokeOpacity="0.5" strokeWidth="0.25" strokeDasharray="0.6 0.6" />)}
            {p.legs.map((l, i) => (
              <g key={l.cand.id}>
                <circle cx={l.to[0]} cy={Y(l.to[1])} r="1.6" fill="#2ee6a6" />
                <text x={l.to[0]} y={Y(l.to[1]) + 0.9} fontSize="2.4" textAnchor="middle" fill="#080d16" fontWeight="700">{i + 1}</text>
              </g>
            ))}
            {/* alerts: diamond = cue, circle = review, with rank number */}
            {open.map((v) => {
              const r = rankOf(v.ep.id);
              const s = v.ep.id === sel;
              return (
                <g key={v.ep.id} onClick={() => setSel(v.ep.id)} style={{ cursor: "pointer" }}>
                  {v.rev.tier === "cue" ? (
                    <rect x={v.rev.x - 1.6} y={Y(v.rev.y) - 1.6} width="3.2" height="3.2" transform={`rotate(45 ${v.rev.x} ${Y(v.rev.y)})`} fill="#ff4259" stroke={s ? "#fff" : "#7f1d1d"} strokeWidth={s ? 0.6 : 0.3} />
                  ) : (
                    <circle cx={v.rev.x} cy={Y(v.rev.y)} r="1.7" fill="#ff9f1a" stroke={s ? "#fff" : "#78350f"} strokeWidth={s ? 0.6 : 0.3} />
                  )}
                  <text x={v.rev.x + 2.4} y={Y(v.rev.y) - 1.6} fontSize="2.6" fill="#fff" fontWeight="700">#{r}</text>
                </g>
              );
            })}
            <rect x={BASE[0] - 1.3} y={Y(BASE[1]) - 1.3} width="2.6" height="2.6" rx="0.5" fill="#a98bff" stroke="#fff" strokeWidth="0.3" />
            <text x={BASE[0] + 2} y={Y(BASE[1]) + 0.8} fontSize="2.3" fill="#d9ccff">BASE</text>
            {assetPos && <polygon points={`${assetPos[0]},${Y(assetPos[1]) - 2} ${assetPos[0] - 1.7},${Y(assetPos[1]) + 1.4} ${assetPos[0] + 1.7},${Y(assetPos[1]) + 1.4}`} fill="#fff" stroke="#ff4259" strokeWidth="0.4" />}
            <text x="1" y={H - 1.5} fontSize="2" fill="#7d8aa3">local km frame, 120 × 90 km · ◆ cue · ● review · ▲ asset · numbered green = planned stops</text>
          </svg>
          <div className="border-t border-ink-700 bg-ink-900 p-3">
            <div className="flex items-center gap-3">
              <button
                onClick={() => setPlay(!play)}
                aria-label={play ? "Pause" : "Play"}
                className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-brand text-ink-950 shadow-lg shadow-brand/20 transition-transform hover:scale-105"
              >
                <Icon name={play ? "pause" : "play"} size={18} />
              </button>
              <input aria-label="Replay time" type="range" min={0} max={1438} step={2} value={now} onChange={(e) => setNow(Number(e.target.value))} className="fr-range w-full" />
              <span aria-live="polite" className="tabular w-16 shrink-0 text-right font-mono text-sm font-bold text-white">{fmtMin(now)}</span>
            </div>
            <p className="mt-2 text-[11px] text-mute">Replay time is when the system could know something (availability time). Late-arriving points appear only after they are received.</p>
          </div>
        </div>

        <div className="space-y-4">
          <section aria-label="Alert queue" className={cn(card, "p-4")}>
            <h3 className={h3}>Alert queue <span aria-live="polite" className="font-normal text-mute">({open.length} active at {fmtMin(now)})</span></h3>
            {open.length === 0 && <p className="mt-2 text-xs text-mute">No active alerts. That means nothing crossed the thresholds in the data received so far — not that nothing is happening.</p>}
            <ol className="mt-2 space-y-1.5">
              {open.map((v, i) => (
                <li key={v.ep.id}>
                  <button
                    onClick={() => setSel(v.ep.id)}
                    className={cn(
                      "w-full rounded-xl border px-3 py-2 text-left text-xs transition-colors",
                      v.ep.id === sel ? "border-brand bg-brand/10" : "border-ink-700 bg-ink-850 hover:border-ink-500"
                    )}
                  >
                    <span className={cn("font-bold", v.rev.tier === "cue" ? "text-cue" : "text-review")}>#{i + 1} {v.rev.tier === "cue" ? "◆ CUE" : "● REVIEW"}</span> <span className="text-white">· {v.ep.name} ({v.ep.cls})</span>
                    <span className="mt-0.5 block font-mono text-[10.5px] text-mute">score {v.rev.score.toFixed(2)} (uncalibrated) · first alert {fmtMin(v.ep.tFirst)}{v.leakMin > 0 ? ` · ⚠ uses data ${v.leakMin} min ahead` : ""}</span>
                  </button>
                </li>
              ))}
            </ol>
            {selView && (
              <div className="mt-3 space-y-1.5 rounded-xl border border-ink-700 bg-ink-950/60 p-3 text-xs text-soft">
                <p><b className="text-white">Why:</b> {selView.rev.reason}</p>
                <p><b className="text-white">Evidence time:</b> observed {fmtMin(selView.rev.tObs)}, available {fmtMin(selView.rev.t)}.</p>
                <p><b className="text-white">Revisions visible now:</b> {selView.ep.revs.filter((r) => r.t <= now).map((r) => `${fmtMin(r.t)} ${r.score.toFixed(2)} ${r.tier}`).join(" → ") || "—"}</p>
              </div>
            )}
          </section>

          <section aria-label="Single asset plan" className={cn(card, "p-4")}>
            <h3 className={cn(h3, "flex items-center gap-2")}><Icon name="drone" size={15} className="text-ok" /> One ISR asset — ordered checks</h3>
            <p className="mt-1 text-[11px] text-mute">1 asset · {ASSET_KM_MIN} km/min (25 m/s) · constant-velocity extrapolation of last fix · heuristic priority, not a tasking order.</p>
            <div className="mt-3 flex flex-wrap gap-4">
              <label className="flex items-center gap-2 text-xs font-semibold text-soft">endurance min <input type="number" min={20} max={90} value={endurance} onChange={(e) => { setEndurance(Number(e.target.value)); setAsset(null); }} className={fieldCls} /></label>
              <label className="flex items-center gap-2 text-xs font-semibold text-soft">on-station min <input type="number" min={1} max={15} value={dwell} onChange={(e) => setDwell(Number(e.target.value))} className={fieldCls} /></label>
            </div>
            <div className="mt-3 flex flex-wrap gap-2">
              {!asset ? (
                <button onClick={() => setAsset({ tPlan: now, start: BASE, left: endurance, launched: true })} className={btnPrimary}>Launch at {fmtMin(now)}</button>
              ) : (
                <>
                  <button onClick={() => assetPos && setAsset({ tPlan: now, start: assetPos, left: Math.max(0, asset.left - usedMin), launched: true })} className={btnPrimary}>Replan from asset position</button>
                  <button onClick={() => setAsset(null)} className={btn}>Recall / reset</button>
                </>
              )}
            </div>
            <p className="mt-2 text-[11px] text-mute">{asset ? `Plan fixed at ${fmtMin(asset.tPlan)} from ${asset.start[0].toFixed(0)},${asset.start[1].toFixed(0)} with ${asset.left.toFixed(0)} min left. New alerts since then are NOT in this plan until you replan.` : `Preview from base using alerts known at ${fmtMin(now)}.`}</p>
            {p.legs.length === 0 ? <p className="mt-3 text-xs text-mute">No reachable check fits within the endurance budget with a return reserve.</p> : (
              <ol className="mt-3 space-y-1.5">
                {p.legs.map((l, i) => (
                  <li key={l.cand.id} className="flex gap-2.5 rounded-lg border border-ink-700 bg-ink-850 px-3 py-2 text-xs text-soft">
                    <span className="flex h-5 w-5 shrink-0 items-center justify-center rounded-full bg-ok text-[10px] font-bold text-ink-950">{i + 1}</span>
                    <span><b className="text-white">{l.cand.name}</b> — arrive T+{l.tArrive.toFixed(0)} min ({fmtMin(planStart.tPlan + l.tArrive)}), {l.km.toFixed(0)} km leg{l.cand.ageMin > 10 ? `, ⚠ last fix ${l.cand.ageMin.toFixed(0)} min old` : ""}</span>
                  </li>
                ))}
              </ol>
            )}
            <p className="mt-3 font-mono text-[11px] text-ok">Home by T+{p.tHome.toFixed(0)} min · margin {p.marginMin.toFixed(0)} min · priority sum {p.value.toFixed(1)}</p>
            {p.dropped.length > 0 && (
              <details className="mt-2 text-xs text-soft">
                <summary className="cursor-pointer font-semibold text-brand">Not covered ({p.dropped.length}) — and why</summary>
                <ul className="mt-1.5 list-disc space-y-1 pl-5">{p.dropped.map((d) => <li key={d.cand.id}><b className="text-white">{d.cand.name}</b>: {d.why}</li>)}</ul>
              </details>
            )}
          </section>
        </div>
      </div>

      <div className="grid gap-4 lg:grid-cols-3">
        <section className={cn(card, "p-4")}>
          <h3 className={h3}>1 · Incident check <span className="font-normal text-mute">(uses hidden synthetic labels — evaluation only)</span></h3>
          {rows.length === 0 ? <p className="mt-2 text-xs text-mute">No planted event on this date. Alerts here, if any, come from look-alikes or ordinary traffic.</p> : (
            <table className="mt-2 w-full text-xs">
              <thead className="border-b border-ink-700"><tr><th className={th}>Pattern</th><th className={th}>Event</th><th className={th}>First alert</th><th className={th}>Outcome</th></tr></thead>
              <tbody className="divide-y divide-ink-700/60 text-soft">
                {rows.map((r) => (
                  <tr key={r.vesselId}>
                    <td className={td}>{r.kind}<br /><span className="text-mute">{r.name}</span></td>
                    <td className={cn(td, "font-mono")}>{fmtMin(r.tEvent)}</td>
                    <td className={cn(td, "font-mono")}>{r.tFirst === null ? "none" : fmtMin(r.tFirst)}</td>
                    <td className={td}><b className="text-white">{r.outcome}</b>{r.leadMin !== null ? <><br /><span className="text-mute">{r.leadMin >= 0 ? `${r.leadMin} min before` : `${-r.leadMin} min after`}</span></> : null}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
          <p className="mt-3 text-[11px] text-mute">Planted patterns were written by the same author as the detector. This shows the software behaves as designed; it is not evidence of real-world recall.</p>
        </section>

        <section className={cn(card, "p-4")}>
          <h3 className={h3}>2 · Alert burden, surrounding week</h3>
          <p className="mt-1 text-[11px] text-mute">Rule: one alert episode = one vessel’s run of ≥ review-score minutes (merged if re-triggered within {cfg.mergeMin} min). Outcomes are unreviewed — these are not “false positives”.</p>
          <button onClick={runWeek} disabled={loading} className={cn(btnPrimary, "mt-3")}>{loading ? "Running…" : "Run 7-day window"}</button>
          {week && (
            <table className="mt-3 w-full text-xs">
              <thead className="border-b border-ink-700"><tr><th className={th}>Day</th><th className={th}>Episodes</th><th className={th}>Cue</th><th className={th}>Review</th></tr></thead>
              <tbody className="divide-y divide-ink-700/60 font-mono text-soft">
                {week.map((w) => <tr key={w.key}><td className={td}>{w.key}</td><td className={td}>{w.episodes}</td><td className={td}>{w.cue}</td><td className={td}>{w.review}</td></tr>)}
                <tr className="font-bold text-white"><td className={td}>Total</td><td className={td}>{week.reduce((a, b) => a + b.episodes, 0)}</td><td className={td}>{week.reduce((a, b) => a + b.cue, 0)}</td><td className={td}>{week.reduce((a, b) => a + b.review, 0)}</td></tr>
              </tbody>
            </table>
          )}
          {!week && !loading && <p className="mt-3 text-xs text-mute">Not run yet.</p>}
        </section>

        <section className={cn(card, "p-4")}>
          <h3 className={h3}>3 · Coverage &amp; causality</h3>
          <ul className="mt-2 list-disc space-y-1 pl-5 text-xs text-soft">
            <li>Vessels on this day: {cov.vessels}; reports received: {cov.points}</li>
            <li>Report rate vs 2-min cadence: {(cov.reportRate * 100).toFixed(0)}%</li>
            <li>Receive latency p95 {cov.p95LatencyMin.toFixed(1)} min, max {cov.maxLatencyMin.toFixed(0)} min</li>
            <li>Same code and frozen config for every date: {modified ? "NO — config modified" : "yes"}</li>
          </ul>
          <button onClick={runCheck} className={cn(btn, "mt-3")}>Run causality self-check at {fmtMin(now)}</button>
          {check && (
            <p role="status" className={cn("mt-3 rounded-lg border p-2.5 text-xs", check.ok ? "border-ok/40 bg-ok/10 text-emerald-100" : "border-cue/40 bg-cue/10 text-red-100")}>
              {check.ok ? "PASS" : "FAIL"} — every vessel’s data after {fmtMin(check.T)} was replaced with an extreme spike and the detector re-run; alerts and scores up to {fmtMin(check.T)} {check.ok ? "did not change" : "CHANGED (future information leaked)"}.
            </p>
          )}
        </section>
      </div>

      <details className={cn(card, "p-4 text-sm")}>
        <summary className="cursor-pointer font-bold text-white">What is simulated, what would need real integration</summary>
        <ul className="mt-3 list-disc space-y-1.5 pl-5 text-xs leading-relaxed text-soft">
          <li><b className="text-white">Simulated:</b> all vessels, positions, latencies, the “damage” events, the cable corridor, the base, baseline speeds, thresholds and weights.</li>
          <li><b className="text-white">Real integration needed:</b> Danish Maritime Authority daily AIS CSVs (≈0.7 GB zipped / ≈3 GB expanded per day, filtered to the bounding box while streaming), real cable routes with provenance and vintage, an agreed incident + timestamp from Mantavia, class baselines learned from prior periods excluding the evaluated day, and reviewer outcomes.</li>
          <li><b className="text-white">Not claimed:</b> detection performance, intent, anchor state, damage, interception, or operational readiness.</li>
        </ul>
      </details>
    </div>
  );
}

export default function SyntheticView() {
  return (
    <div className="flex h-full flex-col">
      <TopBar route="synthetic" />
      <main className="min-h-0 flex-1 overflow-y-auto">
        <div className="mx-auto max-w-7xl space-y-4 p-4 sm:p-6">
          <div>
            <div className="text-[10px] font-bold uppercase tracking-[0.2em] text-brand">Prototype</div>
            <h1 className="mt-1 text-2xl font-extrabold tracking-tight text-white">Original synthetic Cable Watch</h1>
          </div>
          <div className="flex gap-3 rounded-2xl border border-review/50 bg-review/10 p-4 text-sm text-amber-100">
            <Icon name="info" size={18} className="mt-0.5 shrink-0 text-review" />
            <span>Fictional data and geography. Its post-hoc evaluation section can reveal future outcomes during replay. Do not treat this screen as a causal real-data evaluation.</span>
          </div>
          <CableWatchSim />
        </div>
      </main>
    </div>
  );
}
