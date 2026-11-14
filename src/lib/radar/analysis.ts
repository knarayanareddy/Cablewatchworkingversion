import {
  CLASS_BASELINES,
  distKm,
  nearKm,
  smallestCircularDiff,
  type AnomalyResult,
  type ISRLeg,
  type ISRPlan,
  type Lines,
  type Snapshot,
} from './model';

// Anomaly scoring engine & human-readable reasons (extracted verbatim from the original replay page).
export function analyzeVessels(snap: Snapshot | null, lines: Lines, corridorKm: number, at: string): AnomalyResult[] {
  const local = true; // Equirectangular distance calculation is valid across the whole Baltic domain
  if (!snap?.vessels) return [];

  return snap.vessels
    .map((v) => {
      const d = lines.length && local ? nearKm(v, lines) : null;
      const typeLower = (v.ship_type || 'undefined').toLowerCase();

      // Baseline speed for this vessel class
      let baseline = CLASS_BASELINES['other'];
      for (const [k, val] of Object.entries(CLASS_BASELINES)) {
        if (typeLower.includes(k)) {
          baseline = val;
          break;
        }
      }

      const isFishing = typeLower.includes('fish') || typeLower.includes('trawl');

      // Speed Deficit Calculation (preserve null as missing telemetry, do not treat as 0.0 kn)
      const sog = v.sog;
      let speedDeficit = 0;
      if (sog !== null) {
        if (isFishing) {
          speedDeficit = 0;
        } else if (sog < baseline) {
          speedDeficit = baseline - sog;
        }
      }

      // Heading vs Course Drift Angle (Smallest circular arc)
      let driftAngle: number | null = null;
      if (v.heading !== null && v.cog !== null) {
        driftAngle = smallestCircularDiff(v.heading, v.cog);
      }

      // Fix Age Relative to Selected Replay Time
      const curTimestampSec = at ? Date.parse(at) / 1000 : 0;
      const fixTsSec = Date.parse(v.timestamp) / 1000;
      const fixAgeSec = Math.max(0, Math.floor(curTimestampSec - fixTsSec));
      const isStale = fixAgeSec >= 900; // >= 15 min without new broadcast

      // Anomaly Score Formulation
      let score = 0;
      const reasons: string[] = [];

      // 1. Cable Proximity factor
      if (d !== null && d <= corridorKm) {
        const proxWeight = Math.max(0, (corridorKm - d) / corridorKm) * 3.5;
        score += proxWeight;
        reasons.push(`${d.toFixed(1)} km from cable corridor`);
      }

      // 2. Speed Evaluation
      if (sog === null) {
        reasons.push('speed field missing/unreported');
      } else if (sog > 0.5 && sog < 6.0 && !isFishing) {
        const deficitWeight = Math.min(speedDeficit * 0.45, 3.5);
        score += deficitWeight;
        reasons.push(`slow transit ${sog.toFixed(1)} kn vs ~${baseline.toFixed(1)} kn typical (${v.ship_type || 'Commercial'})`);
      } else if (isFishing && sog > 0.5 && sog < 4.5) {
        score = Math.max(0, score - 2.0);
        reasons.push(`speed ${sog.toFixed(1)} kn fits normal trawling profile`);
      }

      // 3. Heading vs Course Deviation (Course drift signature)
      if (driftAngle !== null && driftAngle > 14) {
        const driftWeight = Math.min((driftAngle - 10) * 0.15, 3.0);
        score += driftWeight;
        reasons.push(`course drifts ${driftAngle.toFixed(0)}° from heading`);
      }

      // 4. Stationarity / Drifting
      if (sog !== null && sog >= 0.1 && sog <= 1.5 && d !== null && d <= corridorKm) {
        score += 2.0;
        reasons.push(`near-stationary at ${sog.toFixed(1)} kn inside cable corridor`);
      }

      // Determine Tier
      let tier: 'cue' | 'review' | 'normal' = 'normal';
      if (score >= 4.2) {
        tier = 'cue'; // High priority cue
      } else if (score >= 2.2) {
        tier = 'review'; // Review candidate
      }

      // Build human-readable diagnostic sentence solely from actual observed factors
      let reason = '';
      if (tier === 'cue') {
        reason = `HIGH-PRIORITY CUE. Observed factors: ${reasons.join('; ')}. Physical verification recommended.`;
      } else if (tier === 'review') {
        reason = `CANDIDATE REVIEW. Observed factors: ${reasons.join('; ')}. Baseline exceedance; verification recommended.`;
      } else {
        reason = `Normal traffic: ${v.ship_type || 'vessel'} operating within standard navigational baselines (${reasons.length ? reasons.join('; ') : 'standard transit'}).`;
      }

      return {
        vessel: v,
        dist: d,
        score,
        tier,
        speedDeficit,
        driftAngle,
        reason,
        fixAgeSec,
        isStale,
      };
    })
    .sort((a, b) => b.score - a.score || (a.dist ?? Infinity) - (b.dist ?? Infinity));
}

// ISR asset planner (configurable base, speed & endurance), extracted verbatim.
export function planIsr(
  analyzedVessels: AnomalyResult[],
  isrBase: [number, number],
  isrSpeedMs: number,
  isrEnduranceMin: number,
  isrDwellMin: number
): ISRPlan {
  const SPEED_KM_MIN = (isrSpeedMs * 60) / 1000;
  const MAX_ENDURANCE_MIN = isrEnduranceMin;
  const DWELL_MIN = isrDwellMin;

  // Prioritize cued and review targets
  const alertCands = analyzedVessels.filter((a) => a.score >= 2.0);

  const legs: ISRLeg[] = [];
  const dropped: { name: string; mmsi: string; reason: string }[] = [];
  let curPos: [number, number] = isrBase;
  let timeElapsed = 0;

  for (const cand of alertCands) {
    const targetPos: [number, number] = [cand.vessel.lon, cand.vessel.lat];
    const legDist = distKm(curPos, targetPos);
    const flightTime = legDist / SPEED_KM_MIN;
    const returnDist = distKm(targetPos, isrBase);
    const returnFlightTime = returnDist / SPEED_KM_MIN;

    // Check if we can fly to target, dwell, AND make it safely back to base within endurance
    const neededTime = timeElapsed + flightTime + DWELL_MIN + returnFlightTime;

    if (neededTime <= MAX_ENDURANCE_MIN) {
      timeElapsed += flightTime + DWELL_MIN;
      legs.push({
        mmsi: cand.vessel.mmsi,
        name: cand.vessel.name || cand.vessel.mmsi,
        from: curPos,
        to: targetPos,
        distKm: legDist,
        flightMin: flightTime,
        dwellMin: DWELL_MIN,
        cumTimeMin: timeElapsed,
      });
      curPos = targetPos;
    } else {
      dropped.push({
        name: cand.vessel.name || cand.vessel.mmsi,
        mmsi: cand.vessel.mmsi,
        reason: `Exceeds ${MAX_ENDURANCE_MIN}m endurance (would require ${neededTime.toFixed(0)} min)`,
      });
    }
  }

  // Add return-to-base flight leg
  if (legs.length > 0) {
    const retDist = distKm(curPos, isrBase);
    const retFlight = retDist / SPEED_KM_MIN;
    timeElapsed += retFlight;
  }

  return {
    feasible: legs.length > 0,
    base: isrBase,
    legs,
    totalTimeMin: timeElapsed,
    fuelMarginMin: Math.max(0, MAX_ENDURANCE_MIN - timeElapsed),
    targetsInvestigated: legs.length,
    droppedTargets: dropped,
  };
}
