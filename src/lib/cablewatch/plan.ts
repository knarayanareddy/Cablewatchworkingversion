// Cable Watch — single ISR asset sequencing (SYNTHETIC illustration, not an operational planner).
// Assumptions (all stated in the UI): ONE asset, 25 m/s (1.5 km/min), 60 min endurance, fixed base, constant-velocity
// extrapolation of the last received AIS fix, a fixed on-station time per check, mandatory return-to-base reserve.
// Replanning starts from the asset's CURRENT position and remaining endurance (the reviewed prototype restarted from base).
import { lastFix, type View } from "./detect";
import { BASE, KN_KM_MIN, type Day } from "./sim";

export const ASSET_KM_MIN = 25 * 60 / 1000; // 25 m/s = 1.5 km/min
export const DEFAULT_ENDURANCE_MIN = 60;
export const DEFAULT_DWELL_MIN = 4;

export interface Cand {
  id: string; // episode id
  vesselId: string;
  name: string;
  value: number;
  score: number;
  tier: string;
  ageMin: number; // staleness of the last received fix at planning time
  x: number; // extrapolated position at planning time
  y: number;
  vx: number; // km/min
  vy: number;
  uncKm: number; // position uncertainty radius at planning time (assumption-driven)
}
export interface Leg {
  cand: Cand;
  tDepart: number; // minutes since planning time
  tArrive: number;
  tLeave: number;
  from: [number, number];
  to: [number, number];
  exit: [number, number];
  km: number;
}
export interface Dropped {
  cand: Cand;
  why: string;
}
export interface Plan {
  legs: Leg[];
  value: number;
  tHome: number;
  marginMin: number;
  returnKm: number;
  dropped: Dropped[];
  endurance: number;
  start: [number, number];
}

export function candidates(day: Day, views: View[], now: number): Cand[] {
  const out: Cand[] = [];
  for (const vw of views) {
    if (!vw.open) continue;
    const v = day.vessels.find((q) => q.id === vw.ep.vesselId);
    if (!v) continue;
    const fix = lastFix(v, now);
    if (!fix) continue;
    const age = Math.max(0, now - fix.tObs);
    const speedKmMin = fix.sog * KN_KM_MIN;
    const rad = (fix.cog * Math.PI) / 180;
    const vx = Math.sin(rad) * speedKmMin;
    const vy = Math.cos(rad) * speedKmMin;
    const ext = Math.min(age, 30); // never extrapolate more than 30 min; uncertainty keeps growing beyond that
    const uncKm = 0.4 + age * 0.12;
    const tierW = vw.rev.tier === "cue" ? 1.5 : 1;
    out.push({
      id: vw.ep.id,
      vesselId: vw.ep.vesselId,
      name: vw.ep.name,
      score: vw.rev.score,
      tier: vw.rev.tier,
      value: vw.rev.score * tierW * (1 / (1 + age / 30)),
      ageMin: age,
      x: fix.x + vx * ext,
      y: fix.y + vy * ext,
      vx,
      vy,
      uncKm,
    });
  }
  return out;
}

function intercept(ax: number, ay: number, px: number, py: number, vx: number, vy: number): number | null {
  const rx = px - ax;
  const ry = py - ay;
  const c = ASSET_KM_MIN;
  const a = vx * vx + vy * vy - c * c;
  const b = 2 * (rx * vx + ry * vy);
  const k = rx * rx + ry * ry;
  if (Math.abs(a) < 1e-9) return b < 0 ? -k / b : null;
  const disc = b * b - 4 * a * k;
  if (disc < 0) return null;
  const s = Math.sqrt(disc);
  const ts = [(-b - s) / (2 * a), (-b + s) / (2 * a)].filter((t) => t >= 0).sort((p, q) => p - q);
  return ts.length ? ts[0] : null;
}

export function plan(cands: Cand[], start: [number, number], enduranceLeft: number, dwell = DEFAULT_DWELL_MIN, maxCands = 7): Plan {
  const list = [...cands].sort((a, b) => b.value - a.value).slice(0, maxCands);
  let best: Leg[] = [];
  let bestVal = -1;
  let bestHome = 0;
  const homeKm = (x: number, y: number) => Math.hypot(x - BASE[0], y - BASE[1]);

  const dfs = (legs: Leg[], used: Set<number>, t: number, ax: number, ay: number, val: number) => {
    const tHome = t + homeKm(ax, ay) / ASSET_KM_MIN;
    if (tHome <= enduranceLeft && (val > bestVal + 1e-9 || (Math.abs(val - bestVal) < 1e-9 && tHome < bestHome))) {
      best = legs;
      bestVal = val;
      bestHome = tHome;
    }
    list.forEach((c, i) => {
      if (used.has(i)) return;
      const px = c.x + c.vx * t;
      const py = c.y + c.vy * t;
      const d = intercept(ax, ay, px, py, c.vx, c.vy);
      if (d === null) return;
      const arrive = t + d;
      const leave = arrive + dwell;
      const toX = c.x + c.vx * arrive;
      const toY = c.y + c.vy * arrive;
      const exX = c.x + c.vx * leave;
      const exY = c.y + c.vy * leave;
      if (leave + homeKm(exX, exY) / ASSET_KM_MIN > enduranceLeft) return;
      const nu = new Set(used);
      nu.add(i);
      dfs([...legs, { cand: c, tDepart: t, tArrive: arrive, tLeave: leave, from: [ax, ay], to: [toX, toY], exit: [exX, exY], km: Math.hypot(toX - ax, toY - ay) }], nu, leave, exX, exY, val + c.value);
    });
  };
  dfs([], new Set(), 0, start[0], start[1], 0);

  const chosen = new Set(best.map((l) => l.cand.id));
  const endPos: [number, number] = best.length ? best[best.length - 1].exit : start;
  const tHome = best.length ? bestHome : homeKm(start[0], start[1]) / ASSET_KM_MIN;
  const dropped: Dropped[] = cands
    .filter((c) => !chosen.has(c.id))
    .map((c) => {
      const d0 = intercept(start[0], start[1], c.x, c.y, c.vx, c.vy);
      let why: string;
      if (d0 === null) why = "Cannot be intercepted: target moves away faster than the asset can close.";
      else {
        const ex = c.x + c.vx * (d0 + dwell);
        const ey = c.y + c.vy * (d0 + dwell);
        const need = d0 + dwell + homeKm(ex, ey) / ASSET_KM_MIN;
        why = need > enduranceLeft ? `Out of range: reach + ${dwell} min on station + return needs ~${need.toFixed(0)} min, only ${enduranceLeft.toFixed(0)} min left.` : "Reachable alone, but the chosen sequence has higher total priority within the endurance budget.";
      }
      if (c.uncKm > 3) why += ` Last fix is ${c.ageMin.toFixed(0)} min old (position uncertainty ≈ ${c.uncKm.toFixed(1)} km).`;
      return { cand: c, why };
    });
  return { legs: best, value: Math.max(0, bestVal), tHome, marginMin: enduranceLeft - tHome, returnKm: homeKm(endPos[0], endPos[1]), dropped, endurance: enduranceLeft, start };
}

/** Asset position `tau` minutes after planning time, following the plan then returning to base. */
export function positionAt(p: Plan, tau: number): [number, number] {
  if (tau <= 0 || !p.legs.length) {
    if (!p.legs.length) {
      const d = Math.hypot(BASE[0] - p.start[0], BASE[1] - p.start[1]);
      const f = d === 0 ? 1 : Math.min(1, (tau * ASSET_KM_MIN) / d);
      return [p.start[0] + (BASE[0] - p.start[0]) * f, p.start[1] + (BASE[1] - p.start[1]) * f];
    }
    return p.start;
  }
  for (const l of p.legs) {
    if (tau <= l.tArrive) {
      const f = (tau - l.tDepart) / Math.max(1e-6, l.tArrive - l.tDepart);
      return [l.from[0] + (l.to[0] - l.from[0]) * f, l.from[1] + (l.to[1] - l.from[1]) * f];
    }
    if (tau <= l.tLeave) {
      const f = (tau - l.tArrive) / Math.max(1e-6, l.tLeave - l.tArrive);
      return [l.to[0] + (l.exit[0] - l.to[0]) * f, l.to[1] + (l.exit[1] - l.to[1]) * f];
    }
  }
  const last = p.legs[p.legs.length - 1];
  const f = Math.min(1, (tau - last.tLeave) / Math.max(1e-6, p.tHome - last.tLeave));
  return [last.exit[0] + (BASE[0] - last.exit[0]) * f, last.exit[1] + (BASE[1] - last.exit[1]) * f];
}

export function pathPoints(p: Plan): [number, number][] {
  const pts: [number, number][] = [p.start];
  for (const l of p.legs) {
    pts.push(l.to, l.exit);
  }
  pts.push(BASE);
  return pts;
}
