// Cable Watch — causal behaviour detector and evaluation helpers (SYNTHETIC data only).
// Design rules (fixes for findings in the reviewed prototypes):
//  1. Strictly causal: at replay minute t the scorer only sees points with tRecv <= t (availability time, not observation time).
//  2. Episodes are stored as a log of time-stamped revisions. A viewer at time `now` sees only revisions with t <= now.
//  3. The detector receives vessels WITHOUT ground truth. Truth is used only by the evaluation functions below.
//  4. Scores are heuristic and uncalibrated; wording never claims intent, anchor state or damage.
import { CABLE, CLASS_BASELINE_KN, FERRY_ROUTE, FISHING_ZONE, distToCable, distToPoly, type Cls, type Day, type Pt, type Vessel } from "./sim";

export interface Config {
  corridorKm: number;
  review: number; // score needed to open a review-tier alert
  cue: number; // score needed for the higher "cue" tier
  gapMin: number; // minutes of silence that start to count
  maxAgeMin: number; // ignore a vessel whose last fix is older than this
  mergeMin: number; // alert episodes merge if re-triggered within this many minutes
  w: { near: number; deficit: number; hdg: number; dwell: number; gap: number };
}
export const DEFAULT_CFG: Config = {
  corridorKm: 6,
  review: 2.2,
  cue: 3.4,
  gapMin: 15,
  maxAgeMin: 60,
  mergeMin: 20,
  w: { near: 0.5, deficit: 1.6, hdg: 1.4, dwell: 0.6, gap: 2.4 },
};
export function configHash(c: Config): string {
  const s = JSON.stringify(c, (_k, v) => (v && typeof v === "object" && !Array.isArray(v) ? Object.fromEntries(Object.entries(v).sort()) : v));
  let h = 5381;
  for (let i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) >>> 0;
  return h.toString(16).padStart(8, "0");
}

export type Tier = "review" | "cue";
export interface Feats {
  dCable: number;
  speed: number;
  base: number;
  deficit: number;
  hdgDiv: number;
  dwell: number;
  gap: number;
  gapOngoing: boolean;
  adj: number;
}
export interface Rev {
  t: number; // replay minute at which this revision became knowable
  tObs: number; // observation minute of the evidence
  score: number;
  tier: Tier;
  feats: Feats;
  reason: string;
  x: number;
  y: number;
  sog: number;
  cog: number;
}
export interface Episode {
  id: string;
  vesselId: string;
  name: string;
  cls: Cls;
  tFirst: number;
  tEnd: number;
  ticks: number[]; // replay minutes at which the episode was above threshold (for causal 'still active' display)
  revs: Rev[];
}

export const TICK = 2;
const clamp = (v: number, a: number, b: number) => Math.min(b, Math.max(a, v));
const angDiff = (a: number, b: number) => {
  const d = Math.abs(a - b) % 360;
  return d > 180 ? 360 - d : d;
};
const inZone = (x: number, y: number) => x >= FISHING_ZONE.x1 && x <= FISHING_ZONE.x2 && y >= FISHING_ZONE.y1 && y <= FISHING_ZONE.y2;

function contextAdj(cls: Cls, p: Pt) {
  if (cls === "ferry" && distToPoly(p.x, p.y, FERRY_ROUTE) <= 3) return -2.2;
  if (cls === "fishing" && inZone(p.x, p.y)) return -2.2;
  return 0;
}

function reasonText(cls: Cls, f: Feats, tier: Tier, cfg: Config): string {
  const parts: string[] = [];
  if (f.gapOngoing) parts.push(`no AIS report for ${f.gap.toFixed(0)} min; last fix ${f.dCable.toFixed(1)} km from the corridor`);
  else {
    parts.push(`${cls} ${f.dCable.toFixed(1)} km from the corridor centre-line`);
    if (f.deficit > 0.8) parts.push(`mean speed ${f.speed.toFixed(1)} kn vs ~${f.base.toFixed(1)} kn assumed typical`);
    if (f.hdgDiv > 5) parts.push(`heading differs from course by ${f.hdgDiv.toFixed(0)}°`);
    if (f.dwell > 6) parts.push(`${f.dwell.toFixed(0)} min inside the ${cfg.corridorKm} km corridor`);
    if (f.gap > 0) parts.push(`a ${f.gap.toFixed(0)} min reporting gap near the corridor`);
  }
  const lead = tier === "cue" ? "Several heuristic features exceed their thresholds" : "Some heuristic features exceed their thresholds";
  return `${parts.join("; ")}. ${lead} (features are correlated, not independent evidence). Behaviour to verify — not a finding about intent, anchor state or damage.`;
}

function scoreWindow(cls: Cls, p: Pt, vis: Pt[], cfg: Config): { s: number; f: Feats } {
  const w = cfg.w;
  const dCable = distToCable(p.x, p.y);
  const near = dCable <= cfg.corridorKm;
  const w12 = vis.filter((q) => q.tObs >= p.tObs - 12);
  const last5 = w12.slice(-5);
  const speed = last5.reduce((a, q) => a + q.sog, 0) / Math.max(1, last5.length);
  const base = CLASS_BASELINE_KN[cls];
  const deficit = (cls === "tanker" || cls === "cargo") && dCable <= cfg.corridorKm + 4 ? Math.max(0, base - speed) : 0;
  const hdgDiv = near && speed > 1 ? w12.reduce((a, q) => a + angDiff(q.hdg, q.cog), 0) / Math.max(1, w12.length) : 0;
  const dwell = vis.filter((q) => distToCable(q.x, q.y) <= cfg.corridorKm).length * 2;
  let gap = 0;
  for (let i = 1; i < vis.length; i++) {
    const d = vis[i].tObs - vis[i - 1].tObs;
    if (d >= cfg.gapMin && Math.min(distToCable(vis[i].x, vis[i].y), distToCable(vis[i - 1].x, vis[i - 1].y)) <= cfg.corridorKm + 15) gap = Math.max(gap, d);
  }
  const adj = contextAdj(cls, p);
  const s = Math.max(
    0,
    w.near * (near ? 1 : 0) + w.deficit * clamp(deficit / 4, 0, 1) + w.hdg * clamp(hdgDiv / 15, 0, 1) + w.dwell * clamp(dwell / 20, 0, 1) + w.gap * clamp(gap / 25, 0, 1) + adj,
  );
  return { s, f: { dCable, speed, base, deficit, hdgDiv, dwell, gap, gapOngoing: false, adj } };
}

function scoreOngoingGap(cls: Cls, last: Pt, age: number, cfg: Config): { s: number; f: Feats } | null {
  const dCable = distToCable(last.x, last.y);
  if (last.sog < 3 || dCable > cfg.corridorKm + 15 || age < cfg.gapMin) return null;
  const s = cfg.w.gap * clamp(age / 25, 0, 1) + (dCable <= cfg.corridorKm + 8 ? 0.5 : 0);
  return { s, f: { dCable, speed: last.sog, base: CLASS_BASELINE_KN[cls], deficit: 0, hdgDiv: 0, dwell: 0, gap: age, gapOngoing: true, adj: 0 } };
}

/** Incremental replay over the whole day. Output is a revision log; nothing in a revision depends on data later than rev.t. */
export function replay(vessels: Vessel[], cfg: Config): Episode[] {
  const done: Episode[] = [];
  for (const v of vessels) {
    let cur: { ep: Episode; lastAbove: number } | null = null;
    const closeCur = () => {
      if (cur) done.push(cur.ep);
      cur = null;
    };
    for (let t = 0; t <= 1440; t += TICK) {
      const visible = v.pts.filter((p) => p.tRecv <= t);
      if (!visible.length) continue;
      const sorted = [...visible].sort((a, b) => a.tObs - b.tObs);
      const latest = sorted[sorted.length - 1];
      const age = t - latest.tObs;
      let best: { s: number; f: Feats; p: Pt } | null = null;
      if (age <= cfg.maxAgeMin) {
        const arrivals = sorted.filter((p) => p.tRecv > t - TICK);
        for (const p of arrivals) {
          const vis = sorted.filter((q) => q.tObs <= p.tObs && q.tObs >= p.tObs - 45);
          const r = scoreWindow(v.cls, p, vis, cfg);
          if (!best || r.s > best.s) best = { ...r, p };
        }
        if (!arrivals.length) {
          const g = scoreOngoingGap(v.cls, latest, age, cfg);
          if (g) best = { ...g, p: latest };
        }
      }
      if (best && best.s >= cfg.review) {
        const tier: Tier = best.s >= cfg.cue ? "cue" : "review";
        const rev: Rev = { t, tObs: best.p.tObs, score: best.s, tier, feats: best.f, reason: reasonText(v.cls, best.f, tier, cfg), x: best.p.x, y: best.p.y, sog: best.p.sog, cog: best.p.cog };
        if (!cur || t - cur.lastAbove > cfg.mergeMin) {
          closeCur();
          cur = { ep: { id: `${v.id}-${t}`, vesselId: v.id, name: v.name, cls: v.cls, tFirst: t, tEnd: t, ticks: [t], revs: [rev] }, lastAbove: t };
        } else {
          const lastRev = cur.ep.revs[cur.ep.revs.length - 1];
          if (rev.tier !== lastRev.tier || rev.score >= lastRev.score + 0.5) cur.ep.revs.push(rev);
          cur.lastAbove = t;
          cur.ep.tEnd = t;
          cur.ep.ticks.push(t);
        }
      } else if (cur && t - cur.lastAbove > cfg.mergeMin) closeCur();
    }
    closeCur();
  }
  return done.sort((a, b) => a.tFirst - b.tFirst);
}

export type ViewMode = "causal" | "leaky";
export interface View {
  ep: Episode;
  rev: Rev;
  leakMin: number; // minutes into the future the displayed numbers come from (0 when causal)
  open: boolean;
}
/** What an operator can see at replay minute `now`. "leaky" reproduces the bug found in the reviewed prototype: it shows the whole-episode peak. */
export function viewAt(eps: Episode[], now: number, mode: ViewMode): View[] {
  const out: View[] = [];
  for (const ep of eps) {
    if (ep.tFirst > now) continue;
    let rev: Rev | undefined;
    if (mode === "causal") {
      for (const r of ep.revs) if (r.t <= now) rev = r;
    } else rev = ep.revs.reduce((a, b) => (b.score > a.score ? b : a));
    if (!rev) continue;
    out.push({ ep, rev, leakMin: Math.max(0, rev.t - now), open: activeAt(ep, now) });
  }
  return out.sort((a, b) => b.rev.score - a.rev.score);
}
function activeAt(ep: Episode, now: number) {
  let last = -Infinity;
  for (const t of ep.ticks) if (t <= now) last = t;
  return now - last <= DEFAULT_CFG.mergeMin;
}

export function lastFix(v: Vessel, now: number): Pt | null {
  let best: Pt | null = null;
  for (const p of v.pts) if (p.tRecv <= now && (!best || p.tObs > best.tObs)) best = p;
  return best;
}

// ---------------------------------------------------------------- evaluation (uses ground truth; never fed back to the detector)
export type Outcome = "pre-event alert" | "late alert" | "no alert";
export interface IncidentRow {
  vesselId: string;
  name: string;
  kind: string;
  note: string;
  tEvent: number;
  tFirst: number | null;
  leadMin: number | null;
  outcome: Outcome;
}
export function incidentRows(day: Day, eps: Episode[]): IncidentRow[] {
  const rows: IncidentRow[] = [];
  for (const v of day.vessels) {
    const t = day.truth[v.id];
    if (!t || t.tEvent === undefined) continue;
    const ep = eps.filter((e) => e.vesselId === v.id).sort((a, b) => a.tFirst - b.tFirst)[0];
    const tFirst = ep ? ep.tFirst : null;
    rows.push({
      vesselId: v.id,
      name: v.name,
      kind: t.kind,
      note: t.note,
      tEvent: t.tEvent,
      tFirst,
      leadMin: tFirst === null ? null : t.tEvent - tFirst,
      outcome: tFirst === null ? "no alert" : tFirst <= t.tEvent ? "pre-event alert" : "late alert",
    });
  }
  return rows;
}

export interface DayBurden {
  key: string;
  episodes: number;
  review: number;
  cue: number;
  byClass: Partial<Record<Cls, number>>;
  vessels: number;
}
export function burdenFor(day: Day, eps: Episode[]): DayBurden {
  const byClass: Partial<Record<Cls, number>> = {};
  let cue = 0;
  for (const e of eps) {
    byClass[e.cls] = (byClass[e.cls] ?? 0) + 1;
    if (e.revs.some((r) => r.tier === "cue")) cue++;
  }
  return { key: day.key, episodes: eps.length, review: eps.length - cue, cue, byClass, vessels: day.vessels.length };
}

export function fmtMin(m: number) {
  const h = Math.floor(m / 60) % 24;
  const mm = Math.floor(m % 60);
  return `${String(h).padStart(2, "0")}:${String(mm).padStart(2, "0")}`;
}
export { CABLE };
