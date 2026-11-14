/**
 * CableWatch Track-Based Anomaly Scoring & Continuity Engine
 * 
 * Implements deterministic multi-fix track evaluation, timestamp-grouped
 * deduplication, and strictly bounded contiguous corridor dwell analysis.
 */

export interface TrackFix {
  timestamp: string;
  mmsi: string;
  lat: number;
  lon: number;
  sog: number | null;
  cog: number | null;
  heading: number | null;
  mobile_type?: string | null;
  ship_type?: string | null;
  name?: string | null;
  navigational_status?: string | null;
  rowid?: number;
}

export type XY = [number, number];
export type Lines = XY[][];

const R = 6371.0088; // Earth radius in km

/**
 * Smallest circular difference between two compass bearings in degrees [0, 180].
 * e.g. 359° vs 1° returns 2°, not 358°.
 */
export function smallestCircularDiff(a: number, b: number): number {
  const diff = Math.abs(a - b) % 360;
  return diff > 180 ? 360 - diff : diff;
}

/**
 * Compute minimum perpendicular distance in kilometers from a fix to polyline segments.
 */
export function nearKm(f: { lat: number; lon: number }, lines: Lines): number {
  let best = Infinity;
  const rad = Math.PI / 180;
  for (const line of lines) {
    for (let i = 1; i < line.length; i++) {
      const a = line[i - 1];
      const b = line[i];
      const lat0 = ((a[1] + b[1] + f.lat) / 3) * rad;
      const xy = (p: XY): XY => [(p[0] - f.lon) * rad * R * Math.cos(lat0), (p[1] - f.lat) * rad * R];
      const [ax, ay] = xy(a);
      const [bx, by] = xy(b);
      const dx = bx - ax;
      const dy = by - ay;
      const den = dx * dx + dy * dy;
      const t = den ? Math.max(0, Math.min(1, -(ax * dx + ay * dy) / den)) : 0;
      best = Math.min(best, Math.hypot(ax + t * dx, ay + t * dy));
    }
  }
  return best;
}

export type ObservationStatus =
  | 'qualifying'
  | 'outside_corridor'
  | 'non_qualifying_speed'
  | 'missing_telemetry'
  | 'conflicting';

export interface ProcessedTrackObservation {
  timestamp: string;
  tsSec: number;
  lat: number;
  lon: number;
  sog: number | null;
  cog: number | null;
  heading: number | null;
  drift: number | null;
  distKm: number | null;
  isConflicting: boolean;
  gapSec: number | null;
  status: ObservationStatus;
}

export interface TimestampGroup {
  tsSec: number;
  timestamp: string;
  observations: TrackFix[];
  isConflicting: boolean;
  hasExactDuplicates: boolean;
  representative: TrackFix;
  distKm: number | null;
  drift: number | null;
  status: ObservationStatus;
}

export interface ExperimentalTrackResult {
  mmsi: string;
  contributingFixesCount: number;
  timeSpanSec: number;
  timeSpanMin: number;
  maxContiguousSlowSec: number;
  contiguousSlowMin: number;
  distinctSlowFixesCount: number;
  meanSog: number | null;
  meanDriftAngle: number | null;
  sustainedCorridorFixes: number;
  score: number;
  tier: 'cue' | 'review' | 'normal';
  reason: string;
  contributingFixes: ProcessedTrackObservation[];
  hasGaps: boolean;
  hasConflicts: boolean;
  hasDuplicates: boolean;
  interruptedByNonQualifying: boolean;
}

/**
 * Evaluates historical track observations up to replay time.
 * 
 * TIMESTAMP-GROUP & CONTINUITY POLICY:
 * 1. Deduplicates exact identical observations at the same second.
 * 2. Identifies conflicting fixes at the same second, marking them uncertain/conflicting.
 * 3. Evaluates continuity sequentially across all chronologically ordered distinct timestamps:
 *    - Qualifying criteria: inside corridor buffer (dist <= corridorKm) AND slow transit (0.5 < sog < 6.0) AND !isFishing.
 *    - An episode is broken by: non-qualifying speed, outside-corridor position, missing telemetry, conflicting fix, or gap > 900s.
 * 4. Dwell duration is maintained in integer seconds for all threshold decisions (>= 900s).
 * 5. Aggregations (mean SOG, mean drift) use deduplicated timestamp groups so repeat transmissions do not overweight averages.
 */
export function evaluateTrackScore(
  fixes: TrackFix[],
  lines: Lines,
  corridorKm: number,
  shipType: string = 'undefined',
  mmsi: string = ''
): ExperimentalTrackResult | null {
  if (!fixes || fixes.length === 0) return null;

  const typeLower = (shipType || 'undefined').toLowerCase();
  const isFishing = typeLower.includes('fish') || typeLower.includes('trawl');

  // Step 1: Group observations by exact second
  const groupsMap = new Map<number, TrackFix[]>();
  for (const f of fixes) {
    const tsSec = Math.floor(Date.parse(f.timestamp) / 1000);
    if (!groupsMap.has(tsSec)) {
      groupsMap.set(tsSec, []);
    }
    groupsMap.get(tsSec)!.push(f);
  }

  const sortedSecs = Array.from(groupsMap.keys()).sort((a, b) => a - b);
  if (sortedSecs.length === 0) return null;

  let hasConflictsTotal = false;
  let hasDuplicatesTotal = false;
  const groups: TimestampGroup[] = [];

  for (const tsSec of sortedSecs) {
    const rawObs = groupsMap.get(tsSec)!;
    // Check for exact duplicates
    const exactKeys = new Set(rawObs.map((o) => `${o.lat},${o.lon},${o.sog},${o.cog},${o.heading}`));
    const hasDuplicates = exactKeys.size < rawObs.length;
    if (hasDuplicates) hasDuplicatesTotal = true;

    // Check for conflicting positions or telemetry
    const isConflicting =
      rawObs.length > 1 &&
      rawObs.some(
        (o) =>
          o.lat !== rawObs[0].lat ||
          o.lon !== rawObs[0].lon ||
          (o.sog !== null && rawObs[0].sog !== null && o.sog !== rawObs[0].sog)
      );
    if (isConflicting) hasConflictsTotal = true;

    const rep = rawObs[0];
    const dist = lines.length ? nearKm(rep, lines) : null;
    let drift: number | null = null;
    if (rep.heading !== null && rep.cog !== null) {
      drift = smallestCircularDiff(rep.heading, rep.cog);
    }

    let status: ObservationStatus;
    if (isConflicting) {
      status = 'conflicting';
    } else if (rep.sog === null || Number.isNaN(rep.sog) || dist === null) {
      status = 'missing_telemetry';
    } else if (dist > corridorKm) {
      status = 'outside_corridor';
    } else if (rep.sog <= 0.5 || rep.sog >= 6.0 || isFishing) {
      status = 'non_qualifying_speed';
    } else {
      status = 'qualifying';
    }

    groups.push({
      tsSec,
      timestamp: rep.timestamp,
      observations: rawObs,
      isConflicting,
      hasExactDuplicates: hasDuplicates,
      representative: rep,
      distKm: dist,
      drift,
      status,
    });
  }

  // Step 2: Evaluate Sequential Continuity
  let maxContiguousSlowSec = 0;
  let currentEpisodeSec = 0;
  let currentEpisodeFixCount = 0;
  let maxEpisodeQualifyingFixes = 0;
  let interruptedByNonQualifying = false;
  let hasGapsTotal = false;

  for (let i = 0; i < groups.length; i++) {
    const g = groups[i];
    const prev = i > 0 ? groups[i - 1] : null;
    const deltaSec = prev ? g.tsSec - prev.tsSec : 0;

    if (deltaSec > 900) {
      hasGapsTotal = true;
    }

    if (g.status === 'qualifying') {
      if (currentEpisodeFixCount === 0) {
        // Episode starts
        currentEpisodeSec = 0;
        currentEpisodeFixCount = 1;
      } else {
        // Previous observation was qualifying
        if (deltaSec <= 900) {
          currentEpisodeSec += deltaSec;
          currentEpisodeFixCount++;
        } else {
          // Large gap breaks episode
          if (currentEpisodeSec > maxContiguousSlowSec) {
            maxContiguousSlowSec = currentEpisodeSec;
            maxEpisodeQualifyingFixes = currentEpisodeFixCount;
          }
          currentEpisodeSec = 0;
          currentEpisodeFixCount = 1;
        }
      }
    } else {
      // Non-qualifying observation (fast, outside corridor, missing, or conflicting)
      if (currentEpisodeFixCount > 0) {
        interruptedByNonQualifying = true;
        if (currentEpisodeSec > maxContiguousSlowSec) {
          maxContiguousSlowSec = currentEpisodeSec;
          maxEpisodeQualifyingFixes = currentEpisodeFixCount;
        }
        currentEpisodeSec = 0;
        currentEpisodeFixCount = 0;
      }
    }
  }

  if (currentEpisodeSec > maxContiguousSlowSec) {
    maxContiguousSlowSec = currentEpisodeSec;
    maxEpisodeQualifyingFixes = currentEpisodeFixCount;
  }

  // Step 3: Deduplicated aggregations (1 value per distinct timestamp group)
  const validSogs = groups
    .filter((g) => !g.isConflicting && g.representative.sog !== null)
    .map((g) => g.representative.sog!);
  const meanSog = validSogs.length ? validSogs.reduce((a, b) => a + b, 0) / validSogs.length : null;

  const validDrifts = groups
    .filter((g) => !g.isConflicting && g.drift !== null)
    .map((g) => g.drift!);
  const meanDrift = validDrifts.length ? validDrifts.reduce((a, b) => a + b, 0) / validDrifts.length : null;

  const insideCorridorGroups = groups.filter((g) => g.distKm !== null && g.distKm <= corridorKm);
  const slowInsideGroups = insideCorridorGroups.filter((g) => g.status === 'qualifying');

  const tFirst = sortedSecs[0];
  const tLast = sortedSecs[sortedSecs.length - 1];
  const timeSpanSec = Math.max(0, tLast - tFirst);
  const timeSpanMin = Math.round(timeSpanSec / 60);
  const contiguousSlowMin = Math.round(maxContiguousSlowSec / 60);

  // Step 4: Multi-Fix Scoring Logic (Uses exact seconds for threshold decisions)
  let expScore = 0;
  const expReasons: string[] = [];

  // Contiguous Corridor Dwell threshold: strictly >= 900 seconds (15 min) and >= 3 qualifying fixes
  if (maxContiguousSlowSec >= 900 && maxEpisodeQualifyingFixes >= 3) {
    const dwellWeight = Math.min(3.5, 1.5 + (maxContiguousSlowSec / 1800) * 1.5);
    expScore += dwellWeight;
    expReasons.push(
      `sustained contiguous corridor dwell: ${contiguousSlowMin} min (${maxContiguousSlowSec}s) across ${maxEpisodeQualifyingFixes} consecutive qualifying observations`
    );
  } else if (slowInsideGroups.length > 0) {
    expScore += 0.8;
    expReasons.push(
      `intermittent slow corridor presence: ${slowInsideGroups.length} qualifying observations (max contiguous dwell: ${contiguousSlowMin} min / ${maxContiguousSlowSec}s; total window: ${timeSpanMin} min)`
    );
  } else if (insideCorridorGroups.length > 0) {
    expScore += 0.5;
    expReasons.push(`${insideCorridorGroups.length} observations within ${corridorKm}km corridor buffer (normal transit speed)`);
  }

  // Mean Velocity Deficit across Track
  if (meanSog !== null && meanSog > 0.5 && meanSog < 6.0 && !isFishing) {
    expScore += 2.0;
    expReasons.push(`mean track speed ${meanSog.toFixed(1)} kn indicates sustained low velocity`);
  } else if (isFishing && meanSog !== null && meanSog < 4.5) {
    expScore = Math.max(0, expScore - 2.0);
    expReasons.push('mean speed consistent with standard trawling profile');
  }

  // Persistent Course / Heading Divergence
  if (meanDrift !== null && meanDrift > 14 && validDrifts.length >= 3) {
    const driftWeight = Math.min(3.0, (meanDrift - 10) * 0.15);
    expScore += driftWeight;
    expReasons.push(
      `persistent course/heading divergence: avg Δ = ${meanDrift.toFixed(0)}° across ${validDrifts.length} observations`
    );
  }

  // Explicit Evidence Caveats
  if (interruptedByNonQualifying) {
    expReasons.push('caveat: slow dwell interrupted by non-qualifying fixes (speed, corridor boundary, or missing telemetry)');
  }
  if (hasGapsTotal) {
    expReasons.push('caveat: track contains coverage intervals >15m; continuity bounded to verified contiguous spans');
  }
  if (hasDuplicatesTotal) {
    expReasons.push('duplicate timestamps deduplicated in continuity and aggregation calculations');
  }
  if (hasConflictsTotal) {
    expReasons.push('conflicting fixes detected at identical timestamps and excluded from contiguous qualifying spans');
  }

  let expTier: 'cue' | 'review' | 'normal' = 'normal';
  if (expScore >= 4.2) expTier = 'cue';
  else if (expScore >= 2.2) expTier = 'review';

  // Build flattened output observations for display
  const contributingFixes: ProcessedTrackObservation[] = [];
  for (let i = 0; i < fixes.length; i++) {
    const f = fixes[i];
    const tsSec = Math.floor(Date.parse(f.timestamp) / 1000);
    const g = groups.find((grp) => grp.tsSec === tsSec);
    const gapSec = i > 0 ? tsSec - Math.floor(Date.parse(fixes[i - 1].timestamp) / 1000) : null;
    let drift: number | null = null;
    if (f.heading !== null && f.cog !== null) {
      drift = smallestCircularDiff(f.heading, f.cog);
    }
    const dist = lines.length ? nearKm(f, lines) : null;
    contributingFixes.push({
      timestamp: f.timestamp,
      tsSec,
      lat: f.lat,
      lon: f.lon,
      sog: f.sog,
      cog: f.cog,
      heading: f.heading,
      drift,
      distKm: dist,
      isConflicting: g ? g.isConflicting : false,
      gapSec,
      status: g ? g.status : 'qualifying',
    });
  }

  return {
    mmsi,
    contributingFixesCount: fixes.length,
    timeSpanSec,
    timeSpanMin,
    maxContiguousSlowSec,
    contiguousSlowMin,
    distinctSlowFixesCount: slowInsideGroups.length,
    meanSog,
    meanDriftAngle: meanDrift,
    sustainedCorridorFixes: insideCorridorGroups.length,
    score: expScore,
    tier: expTier,
    reason:
      expReasons.length > 0
        ? `EXPERIMENTAL TRACK EVALUATION: ${expReasons.join('; ')}.`
        : 'Normal multi-fix transit behavior; no sustained corridor dwell or persistent drift anomaly.',
    contributingFixes,
    hasGaps: hasGapsTotal,
    hasConflicts: hasConflictsTotal,
    hasDuplicates: hasDuplicatesTotal,
    interruptedByNonQualifying,
  };
}
