/**
 * TypeScript Unit Tests for CableWatch Track Scoring & Continuity Engine
 * Run with: node --experimental-strip-types tests/test_track_score.ts
 */

import assert from 'node:assert';
import {
  evaluateTrackScore,
  smallestCircularDiff,
  nearKm,
  type TrackFix,
  type Lines,
} from '../src/lib/cablewatch/track_score.ts';

// Corridor line from [14.0, 55.0] to [14.0, 55.5]
const TEST_CORRIDOR: Lines = [
  [
    [14.0, 55.0],
    [14.0, 55.5],
  ],
];

console.log('Running CableWatch Track Score & Continuity Test Suite...');

// --- TEST 1: Circular Bearing Difference ---
{
  assert.strictEqual(smallestCircularDiff(359, 1), 2, '359° vs 1° should be 2°');
  assert.strictEqual(smallestCircularDiff(1, 359), 2, '1° vs 359° should be 2°');
  assert.strictEqual(smallestCircularDiff(10, 350), 20, '10° vs 350° should be 20°');
  assert.strictEqual(smallestCircularDiff(180, 0), 180, '180° vs 0° should be 180°');
  assert.strictEqual(smallestCircularDiff(90, 90), 0, '90° vs 90° should be 0°');
  console.log('✓ Test 1: Circular bearing math passed.');
}

// --- TEST 2: User's Case - Fast/Non-qualifying Fix Breaks Contiguous Dwell ---
// Fixes at 00:00, 00:05 (fast: 15 kn), 00:10, 00:20 over corridor
{
  const fixes: TrackFix[] = [
    { timestamp: '2026-09-07T00:00:00Z', mmsi: '123456789', lat: 55.1, lon: 14.0, sog: 2.0, cog: 90, heading: 90, ship_type: 'Cargo' },
    { timestamp: '2026-09-07T00:05:00Z', mmsi: '123456789', lat: 55.1, lon: 14.0, sog: 15.0, cog: 90, heading: 90, ship_type: 'Cargo' }, // Fast!
    { timestamp: '2026-09-07T00:10:00Z', mmsi: '123456789', lat: 55.1, lon: 14.0, sog: 2.0, cog: 90, heading: 90, ship_type: 'Cargo' },
    { timestamp: '2026-09-07T00:20:00Z', mmsi: '123456789', lat: 55.1, lon: 14.0, sog: 2.0, cog: 90, heading: 90, ship_type: 'Cargo' },
  ];

  const result = evaluateTrackScore(fixes, TEST_CORRIDOR, 4.0, 'Cargo', '123456789');
  assert(result !== null, 'Result should not be null');

  // The 00:05 fix must break the contiguous episode!
  assert.strictEqual(result.interruptedByNonQualifying, true, 'Must flag interruption by non-qualifying fix');
  
  // Episode 1: 00:00 (0s) -> broken at 00:05
  // Episode 2: 00:10 to 00:20 (600s = 10 min)
  // Max contiguous slow dwell must be 600s (10 min), NOT 1200s (20 min)!
  assert.strictEqual(result.maxContiguousSlowSec, 600, 'Max contiguous slow dwell must be 600s, not 1200s');
  assert.strictEqual(result.contiguousSlowMin, 10, 'Contiguous slow dwell min should be 10');
  
  // Dwell threshold of 15m (900s) must NOT be met!
  assert(!result.reason.includes('sustained contiguous corridor dwell'), 'Must not claim sustained contiguous dwell');
  assert(result.reason.includes('intermittent slow corridor presence'), 'Must classify as intermittent slow corridor presence');
  assert(result.reason.includes('interrupted by non-qualifying fixes'), 'Reason must include interruption caveat');
  console.log("✓ Test 2: Fast fix breaking contiguous dwell passed (user's exact example).");
}

// --- TEST 3: Outside-Corridor Fix Breaks Contiguous Dwell ---
{
  const fixes: TrackFix[] = [
    { timestamp: '2026-09-07T00:00:00Z', mmsi: '123456789', lat: 55.1, lon: 14.0, sog: 2.0, cog: 90, heading: 90, ship_type: 'Cargo' },
    { timestamp: '2026-09-07T00:08:00Z', mmsi: '123456789', lat: 55.1, lon: 14.5, sog: 2.0, cog: 90, heading: 90, ship_type: 'Cargo' }, // ~31 km away, outside corridor!
    { timestamp: '2026-09-07T00:15:00Z', mmsi: '123456789', lat: 55.1, lon: 14.0, sog: 2.0, cog: 90, heading: 90, ship_type: 'Cargo' },
    { timestamp: '2026-09-07T00:25:00Z', mmsi: '123456789', lat: 55.1, lon: 14.0, sog: 2.0, cog: 90, heading: 90, ship_type: 'Cargo' },
  ];

  const result = evaluateTrackScore(fixes, TEST_CORRIDOR, 4.0, 'Cargo', '123456789');
  assert(result !== null);
  assert.strictEqual(result.interruptedByNonQualifying, true);
  // Episode 1: 00:00 (0s), Episode 2: 00:15 to 00:25 (600s)
  assert.strictEqual(result.maxContiguousSlowSec, 600);
  console.log('✓ Test 3: Outside-corridor fix breaking contiguous dwell passed.');
}

// --- TEST 4: Exact Seconds Dwell Threshold (899s vs 900s) ---
{
  // 899 seconds (14m 59s): 3 fixes over 899s
  const fixes899: TrackFix[] = [
    { timestamp: '2026-09-07T00:00:00Z', mmsi: '111', lat: 55.1, lon: 14.0, sog: 2.0, cog: 90, heading: 90, ship_type: 'Cargo' },
    { timestamp: '2026-09-07T00:07:00Z', mmsi: '111', lat: 55.1, lon: 14.0, sog: 2.0, cog: 90, heading: 90, ship_type: 'Cargo' },
    { timestamp: '2026-09-07T00:14:59Z', mmsi: '111', lat: 55.1, lon: 14.0, sog: 2.0, cog: 90, heading: 90, ship_type: 'Cargo' },
  ];
  const res899 = evaluateTrackScore(fixes899, TEST_CORRIDOR, 4.0, 'Cargo', '111');
  assert(res899 !== null);
  assert.strictEqual(res899.maxContiguousSlowSec, 899);
  assert(!res899.reason.includes('sustained contiguous corridor dwell'), '899s must NOT trigger 15-minute dwell threshold');

  // 900 seconds (15m 00s): exactly 900s
  const fixes900: TrackFix[] = [
    { timestamp: '2026-09-07T00:00:00Z', mmsi: '111', lat: 55.1, lon: 14.0, sog: 2.0, cog: 90, heading: 90, ship_type: 'Cargo' },
    { timestamp: '2026-09-07T00:07:00Z', mmsi: '111', lat: 55.1, lon: 14.0, sog: 2.0, cog: 90, heading: 90, ship_type: 'Cargo' },
    { timestamp: '2026-09-07T00:15:00Z', mmsi: '111', lat: 55.1, lon: 14.0, sog: 2.0, cog: 90, heading: 90, ship_type: 'Cargo' },
  ];
  const res900 = evaluateTrackScore(fixes900, TEST_CORRIDOR, 4.0, 'Cargo', '111');
  assert(res900 !== null);
  assert.strictEqual(res900.maxContiguousSlowSec, 900);
  assert(res900.reason.includes('sustained contiguous corridor dwell'), '900s MUST trigger sustained contiguous dwell');
  console.log('✓ Test 4: Strict seconds-based threshold (899s vs 900s) passed.');
}

// --- TEST 5: Duplicate Timestamps Deduplicated in Aggregations ---
{
  // 1 fix at 00:00:00 with SOG 10.0, and 9 duplicate identical fixes at 00:01:00 with SOG 2.0
  // If not deduplicated: average would be (10 + 9*2)/10 = 2.8 kn
  // When deduplicated: 1 value at 00:00 (10.0) and 1 value at 00:01 (2.0) -> average is (10 + 2)/2 = 6.0 kn!
  const fixes: TrackFix[] = [
    { timestamp: '2026-09-07T00:00:00Z', mmsi: '222', lat: 55.1, lon: 14.0, sog: 10.0, cog: 90, heading: 90, ship_type: 'Cargo' },
  ];
  for (let i = 0; i < 9; i++) {
    fixes.push({ timestamp: '2026-09-07T00:01:00Z', mmsi: '222', lat: 55.1, lon: 14.0, sog: 2.0, cog: 90, heading: 90, ship_type: 'Cargo' });
  }

  const result = evaluateTrackScore(fixes, TEST_CORRIDOR, 4.0, 'Cargo', '222');
  assert(result !== null);
  assert.strictEqual(result.hasDuplicates, true, 'Should detect duplicate timestamps');
  assert.strictEqual(result.meanSog, 6.0, 'Deduplicated mean SOG must be 6.0, not 2.8');
  console.log('✓ Test 5: Duplicate timestamp deduplication in aggregations passed.');
}

// --- TEST 6: Conflicting Positions at Same Second Break Continuity ---
{
  const fixes: TrackFix[] = [
    { timestamp: '2026-09-07T00:00:00Z', mmsi: '333', lat: 55.1, lon: 14.0, sog: 2.0, cog: 90, heading: 90, ship_type: 'Cargo' },
    // Conflicting positions at 00:05:00
    { timestamp: '2026-09-07T00:05:00Z', mmsi: '333', lat: 55.1, lon: 14.0, sog: 2.0, cog: 90, heading: 90, ship_type: 'Cargo' },
    { timestamp: '2026-09-07T00:05:00Z', mmsi: '333', lat: 55.4, lon: 14.3, sog: 2.0, cog: 90, heading: 90, ship_type: 'Cargo' },
    { timestamp: '2026-09-07T00:10:00Z', mmsi: '333', lat: 55.1, lon: 14.0, sog: 2.0, cog: 90, heading: 90, ship_type: 'Cargo' },
  ];

  const result = evaluateTrackScore(fixes, TEST_CORRIDOR, 4.0, 'Cargo', '333');
  assert(result !== null);
  assert.strictEqual(result.hasConflicts, true, 'Must detect conflicting positions');
  assert.strictEqual(result.interruptedByNonQualifying, true, 'Conflict must interrupt qualifying dwell');
  assert(result.maxContiguousSlowSec <= 300, 'Conflict breaks contiguous episode');
  console.log('✓ Test 6: Conflicting observations break continuity passed.');
}

console.log('\nAll CableWatch TypeScript track scoring tests passed successfully!');
