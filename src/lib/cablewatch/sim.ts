// Cable Watch — SYNTHETIC fixture generator.
// Everything here is fictional: a made-up strait in a local km frame (x east, y north), a made-up cable corridor,
// made-up vessels. It is NOT AIS data, NOT the Mantavia area and NOT any real infrastructure.
// Ground-truth labels live in `Day.truth` and are never passed to the detector (hidden-label separation).

export type Cls = "tanker" | "cargo" | "ferry" | "fishing" | "sailing";
export interface Pt {
  tObs: number; // minute of day when the position was observed
  tRecv: number; // minute of day when the system could first see it (availability time, >= tObs)
  x: number;
  y: number;
  sog: number; // knots
  cog: number; // deg, 0 = north
  hdg: number; // deg
}
export interface Vessel {
  id: string;
  name: string;
  cls: Cls;
  pts: Pt[];
}
export type TruthKind = "normal" | "anchor-drag-like" | "ais-gap" | "benign-lookalike" | "late-arrival";
export interface Truth {
  kind: TruthKind;
  note: string;
  tEvent?: number; // minute of day of the synthetic "damage / crossing" event, where defined
}
export interface Scenario {
  drag: number;
  gap: number;
  look: number;
  late: number;
}
export interface Day {
  key: string;
  vessels: Vessel[];
  truth: Record<string, Truth>;
  scenario: Scenario;
}

export const KN_KM_MIN = 1.852 / 60;
export const W = 120;
export const H = 90;
export const BASE: [number, number] = [25, 35];
export const CABLE: [number, number][] = [
  [46, 0],
  [50, 30],
  [55, 52],
  [60, 90],
];
export const FISHING_ZONE = { x1: 72, y1: 56, x2: 102, y2: 80 };
export const FERRY_ROUTE: [number, number][] = [
  [30, 80],
  [75, 8],
];
export const CLASS_BASELINE_KN: Record<Cls, number> = { tanker: 11.5, cargo: 12, ferry: 14, fishing: 3, sailing: 4 };

export function hashStr(s: string): number {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}
export function rngFrom(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function distToSeg(px: number, py: number, a: [number, number], b: [number, number]) {
  const dx = b[0] - a[0];
  const dy = b[1] - a[1];
  const l2 = dx * dx + dy * dy;
  const t = l2 === 0 ? 0 : Math.max(0, Math.min(1, ((px - a[0]) * dx + (py - a[1]) * dy) / l2));
  return Math.hypot(px - (a[0] + t * dx), py - (a[1] + t * dy));
}
export function distToPoly(px: number, py: number, poly: [number, number][]) {
  let best = Infinity;
  for (let i = 0; i < poly.length - 1; i++) best = Math.min(best, distToSeg(px, py, poly[i], poly[i + 1]));
  return best;
}
export const distToCable = (x: number, y: number) => distToPoly(x, y, CABLE);

interface Sample {
  t: number;
  x: number;
  y: number;
  sog: number;
  cog: number;
  hdg: number;
}

function traverse(
  path: [number, number][],
  t0: number,
  speedKn: (x: number, y: number) => number,
  hdgOff: (x: number, y: number) => number = () => 0,
  step = 2,
): Sample[] {
  const seg: number[] = [];
  let total = 0;
  for (let i = 0; i < path.length - 1; i++) {
    const l = Math.hypot(path[i + 1][0] - path[i][0], path[i + 1][1] - path[i][1]);
    seg.push(l);
    total += l;
  }
  const out: Sample[] = [];
  let s = 0;
  let t = t0;
  while (s <= total && t < 1440) {
    let acc = 0;
    let i = 0;
    while (i < seg.length - 1 && acc + seg[i] < s) {
      acc += seg[i];
      i++;
    }
    const f = Math.min(1, (s - acc) / seg[i]);
    const x = path[i][0] + f * (path[i + 1][0] - path[i][0]);
    const y = path[i][1] + f * (path[i + 1][1] - path[i][1]);
    const dx = path[i + 1][0] - path[i][0];
    const dy = path[i + 1][1] - path[i][1];
    const cog = (Math.atan2(dx, dy) * 180) / Math.PI;
    const sp = Math.max(0.3, speedKn(x, y));
    out.push({ t, x, y, sog: sp, cog: (cog + 360) % 360, hdg: (cog + hdgOff(x, y) + 360) % 360 });
    s += sp * KN_KM_MIN * step;
    t += step;
  }
  return out;
}

function toPts(samples: Sample[], rng: () => number, dropout: number, lateFrom?: number, lateTo?: number, lateBy = 0): Pt[] {
  const pts: Pt[] = [];
  for (const s of samples) {
    if (rng() < dropout) continue;
    let lat = rng() * 3;
    if (lateFrom !== undefined && lateTo !== undefined && s.t >= lateFrom && s.t <= lateTo) lat = lateBy - (s.t - lateFrom) * 0 + rng();
    pts.push({
      tObs: s.t,
      tRecv: s.t + lat,
      x: s.x + (rng() - 0.5) * 0.12,
      y: s.y + (rng() - 0.5) * 0.12,
      sog: Math.max(0, s.sog + (rng() - 0.5) * 0.6),
      cog: s.cog,
      hdg: s.hdg,
    });
  }
  return pts;
}

function laneJitter(rng: () => number): [number, number][] {
  const y0 = 43 + rng() * 4;
  const y1 = 43 + rng() * 4;
  return [
    [0, y0],
    [W, y1],
  ];
}

function minCableIdx(samples: Sample[]) {
  let bi = 0;
  let bd = Infinity;
  samples.forEach((s, i) => {
    const d = distToCable(s.x, s.y);
    if (d < bd) {
      bd = d;
      bi = i;
    }
  });
  return bi;
}

export const FIRST_DAY = "2026-09-07";
export const LAST_DAY = "2026-09-16";
export const JUDGE_DAYS = Array.from({ length: 10 }, (_, i) => `2026-09-${String(7 + i).padStart(2, "0")}`);
export const REPLAY_KEY = "replay-a";

export function scenarioFor(key: string): Scenario {
  if (key.startsWith(REPLAY_KEY)) {
    const isMain = key === REPLAY_KEY;
    return { drag: isMain ? 1 : 0, gap: isMain ? 1 : 0, look: isMain ? 1 : 1, late: 0 };
  }
  const h = hashStr("scn:" + key);
  return { drag: h % 5 < 2 ? 1 : 0, gap: (h >> 3) % 3 === 0 ? 1 : 0, look: 1 + ((h >> 5) % 2), late: (h >> 7) % 3 === 0 ? 1 : 0 };
}

export function makeDay(key: string): Day {
  const rng = rngFrom(hashStr("day:" + key));
  const scenario = scenarioFor(key);
  const vessels: Vessel[] = [];
  const truth: Record<string, Truth> = {};
  let n = 0;
  const add = (name: string, cls: Cls, pts: Pt[], t: Truth) => {
    const id = `SIM-${String(++n).padStart(3, "0")}`;
    vessels.push({ id, name, cls, pts });
    truth[id] = t;
    return id;
  };

  // ordinary traffic: lane transits (east- and west-bound)
  const transits = 12 + Math.floor(rng() * 5);
  for (let i = 0; i < transits; i++) {
    const cls: Cls = rng() < 0.5 ? "tanker" : "cargo";
    const east = rng() < 0.5;
    let path = laneJitter(rng);
    if (!east) path = [...path].reverse() as [number, number][];
    const base = CLASS_BASELINE_KN[cls] + (rng() - 0.5) * 2.5;
    const t0 = Math.floor(rng() * 1000);
    const samples = traverse(path, t0, () => base);
    add(`${cls === "tanker" ? "TKR" : "CGO"} ${100 + i}`, cls, toPts(samples, rng, 0.08), { kind: "normal", note: "Ordinary lane transit." });
  }
  // ferries on a registered route (context should discount them)
  for (let i = 0; i < 5; i++) {
    const rev = i % 2 === 1;
    const path = rev ? ([...FERRY_ROUTE].reverse() as [number, number][]) : FERRY_ROUTE;
    const samples = traverse(path, 60 + i * 230, () => 14 + (rng() - 0.5));
    add(`FERRY ${i + 1}`, "ferry", toPts(samples, rng, 0.05), { kind: "normal", note: "Registered ferry route; crosses the corridor on schedule." });
  }
  // fishing in its zone (far from the corridor)
  for (let i = 0; i < 3; i++) {
    const cx = FISHING_ZONE.x1 + 6 + rng() * 18;
    const cy = FISHING_ZONE.y1 + 4 + rng() * 16;
    const path: [number, number][] = [[cx, cy]];
    for (let k = 0; k < 14; k++) path.push([cx + (rng() - 0.5) * 12, cy + (rng() - 0.5) * 10]);
    const samples = traverse(path, 120 + i * 200, () => 2 + rng() * 2, () => (rng() - 0.5) * 90);
    add(`FV ${i + 1}`, "fishing", toPts(samples, rng, 0.08), { kind: "normal", note: "Fishing activity inside the fishing zone." });
  }

  // planted: anchor-drag-like pattern (slow-down + heading/course mismatch while over the corridor)
  const dragSpeed = (x: number, y: number) => {
    const d = distToCable(x, y);
    return d > 10 ? 11.5 : d > 5 ? 11.5 - (10 - d) * 1.1 : 6;
  };
  const dragHdg = (x: number, y: number) => (distToCable(x, y) < 8 ? 16 : 0);
  for (let i = 0; i < scenario.drag; i++) {
    const path = laneJitter(rng);
    const samples = traverse(path, 150 + Math.floor(rng() * 300), dragSpeed, dragHdg);
    const k = minCableIdx(samples);
    add("TKR 7xx", "tanker", toPts(samples, rng, 0.05), {
      kind: "anchor-drag-like",
      note: "SYNTHETIC pattern: slows from lane speed to ~6 kn and crabs ~16° over the corridor. Not a model of any real incident.",
      tEvent: samples[k].t,
    });
  }
  // planted: AIS silent while approaching and crossing the corridor
  for (let i = 0; i < scenario.gap; i++) {
    const path = laneJitter(rng);
    const samples = traverse(path, 420 + Math.floor(rng() * 300), () => 12);
    const k = minCableIdx(samples);
    const a = samples[Math.max(0, k - 14)].t;
    const b = samples[Math.min(samples.length - 1, k + 5)].t;
    const kept = samples.filter((s) => s.t < a || s.t > b);
    add("CGO 8xx", "cargo", toPts(kept, rng, 0.04), {
      kind: "ais-gap",
      note: `SYNTHETIC: no reports between minute ${a} and ${b}. A gap alone does not show intent, damage or a fault.`,
      tEvent: a,
    });
  }
  // benign look-alike: a yacht drifting slowly in the corridor (should be reviewable, probably not actionable)
  for (let i = 0; i < scenario.look; i++) {
    const path: [number, number][] = [
      [28 + rng() * 6, 30 + rng() * 6],
      [58, 47 + rng() * 4],
      [64, 50],
    ];
    const samples = traverse(path, 240 + Math.floor(rng() * 500), (x, y) => (distToCable(x, y) < 5 ? 1.6 : 4), (x, y) => (distToCable(x, y) < 6 ? 28 : 0));
    add("SV drift", "sailing", toPts(samples, rng, 0.06), { kind: "benign-lookalike", note: "SYNTHETIC: light-wind drift across the corridor; benign by construction." });
  }
  // late-arriving data: the same slow-down pattern, but the corridor segment is delivered 25 min late in one burst
  for (let i = 0; i < scenario.late; i++) {
    const path = laneJitter(rng);
    const samples = traverse(path, 200 + Math.floor(rng() * 300), dragSpeed, dragHdg);
    const k = minCableIdx(samples);
    const a = samples[Math.max(0, k - 8)].t;
    const b = samples[Math.min(samples.length - 1, k + 6)].t;
    add("TKR 9xx", "tanker", toPts(samples, rng, 0.04, a, b, b + 25 - a), {
      kind: "late-arrival",
      note: "SYNTHETIC: data covering minutes " + a + "–" + b + " reaches the system as one batch ~25 min after the last of them was observed.",
      tEvent: samples[k].t,
    });
  }
  return { key, vessels, truth, scenario };
}

/** Same day with every point after `tCut` replaced by an extreme late spike — used by the causality test. */
export function withFutureSpike(day: Day, tCut: number): Day {
  return {
    ...day,
    vessels: day.vessels.map((v, i) => ({
      ...v,
      pts: v.pts.map((p) => (p.tObs > tCut ? { ...p, sog: 0.3, hdg: (p.cog + 90) % 360, x: p.x, y: p.y + (i % 2 ? 0.2 : -0.2) } : p)),
    })),
  };
}

export function dayCoverage(day: Day) {
  let expected = 0;
  let got = 0;
  const lats: number[] = [];
  for (const v of day.vessels) {
    if (v.pts.length < 2) continue;
    const span = v.pts[v.pts.length - 1].tObs - v.pts[0].tObs;
    expected += span / 2 + 1;
    got += v.pts.length;
    for (const p of v.pts) lats.push(p.tRecv - p.tObs);
  }
  lats.sort((a, b) => a - b);
  return {
    reportRate: expected ? Math.min(1, got / expected) : 0,
    p95LatencyMin: lats.length ? lats[Math.floor(lats.length * 0.95)] : 0,
    maxLatencyMin: lats.length ? lats[lats.length - 1] : 0,
    vessels: day.vessels.length,
    points: got,
  };
}
