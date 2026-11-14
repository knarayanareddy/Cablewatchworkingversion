"""CableWatch ML Shadow Mode Feature Extraction (v1).

Defines deterministic feature derivation, observation preprocessing, and quality gates
for 60-minute trailing lookback windows over subsea infrastructure corridors.
"""

from __future__ import annotations

import datetime as dt
import hashlib
import json
import math
import sqlite3
from pathlib import Path
from typing import Any, Dict, List, Optional, Tuple

FEATURE_SCHEMA_VERSION = "v1"
EARTH_RADIUS_KM = 6371.0088


def parse_utc(ts_str: str) -> dt.datetime:
    """Parse strict ISO8601 UTC timestamp ending in Z."""
    if not isinstance(ts_str, str) or not ts_str.endswith("Z"):
        raise ValueError(f"Timestamp must be UTC ending in 'Z', got {ts_str!r}")
    return dt.datetime.strptime(ts_str, "%Y-%m-%dT%H:%M:%SZ").replace(tzinfo=dt.timezone.utc)


def format_utc(d: dt.datetime) -> str:
    """Format datetime as ISO8601 UTC string."""
    return d.astimezone(dt.timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


def compute_geometry_hash(lines: List[List[Tuple[float, float]]]) -> str:
    """Generate deterministic SHA-256 hash for corridor polyline geometry."""
    canonical = json.dumps(lines, separators=(",", ":"), sort_keys=True)
    return hashlib.sha256(canonical.encode("utf-8")).hexdigest()


def near_km(lat: float, lon: float, lines: List[List[Tuple[float, float]]]) -> float:
    """Compute minimum perpendicular distance in km to multi-segment polyline.
    
    Uses identical equirectangular projection and formula as TypeScript track_score.ts.
    """
    best = float("inf")
    rad = math.pi / 180.0
    for line in lines:
        for i in range(1, len(line)):
            a = line[i - 1]
            b = line[i]
            lat0 = ((a[1] + b[1] + lat) / 3.0) * rad
            ax = (a[0] - lon) * rad * EARTH_RADIUS_KM * math.cos(lat0)
            ay = (a[1] - lat) * rad * EARTH_RADIUS_KM
            bx = (b[0] - lon) * rad * EARTH_RADIUS_KM * math.cos(lat0)
            by = (b[1] - lat) * rad * EARTH_RADIUS_KM
            dx = bx - ax
            dy = by - ay
            den = dx * dx + dy * dy
            t = max(0.0, min(1.0, -(ax * dx + ay * dy) / den)) if den > 0 else 0.0
            dist = math.hypot(ax + t * dx, ay + t * dy)
            if dist < best:
                best = dist
    return best


def haversine_km(lat1: float, lon1: float, lat2: float, lon2: float) -> float:
    """Haversine distance between two coordinates in kilometers."""
    r = 6371.0
    p1 = math.radians(lat1)
    p2 = math.radians(lat2)
    dp = math.radians(lat2 - lat1)
    dl = math.radians(lon2 - lon1)
    a = math.sin(dp / 2.0) ** 2 + math.cos(p1) * math.cos(p2) * math.sin(dl / 2.0) ** 2
    return 2.0 * r * math.atan2(math.sqrt(a), math.sqrt(1.0 - a))


def percentile_linear(vals: List[float], q: float) -> float:
    """Compute percentile q in [0, 1] using standard linear interpolation."""
    if not vals:
        raise ValueError("Cannot compute percentile of empty list")
    s = sorted(vals)
    n = len(s)
    if n == 1:
        return s[0]
    idx = (n - 1) * q
    low = int(math.floor(idx))
    high = int(math.ceil(idx))
    weight = idx - low
    return s[low] * (1.0 - weight) + s[high] * weight


def median(vals: List[float]) -> float:
    """Compute median of list of numbers."""
    return percentile_linear(vals, 0.5)


def iqr(vals: List[float]) -> float:
    """Compute interquartile range (75th - 25th percentile)."""
    return percentile_linear(vals, 0.75) - percentile_linear(vals, 0.25)


class FeatureExtractionError(Exception):
    """Raised when track features cannot be derived due to data quality."""
    def __init__(self, code: str, message: str, details: Optional[Dict[str, Any]] = None):
        super().__init__(message)
        self.code = code
        self.message = message
        self.details = details or {}


def extract_track_features(
    db_path: str | Path,
    mmsi: str,
    as_of: str,
    lines: List[List[Tuple[float, float]]],
    corridor_id: str = "default_corridor",
    lookback_minutes: int = 60,
    area_bbox: Optional[Tuple[float, float, float, float]] = None,
) -> Dict[str, Any]:
    """Query read-only SQLite database and derive v1 features for target vessel.
    
    Returns structured feature record or raises FeatureExtractionError.
    """
    as_of_dt = parse_utc(as_of)
    start_dt = as_of_dt - dt.timedelta(minutes=lookback_minutes)
    start_str = format_utc(start_dt)
    as_of_str = format_utc(as_of_dt)

    db_file = Path(db_path).expanduser().resolve()
    if not db_file.is_file():
        raise FeatureExtractionError("invalid_request", f"Database file does not exist: {db_file}")

    conn = sqlite3.connect(f"{db_file.as_uri()}?mode=ro", uri=True)
    try:
        cur = conn.cursor()
        cur.execute(
            """
            SELECT ts, mmsi, lat, lon, sog, cog, hdg, ship_type, name, rowid
            FROM fixes
            WHERE mmsi = ? AND ts >= ? AND ts <= ?
            ORDER BY ts ASC, rowid ASC
            """,
            (mmsi, start_str, as_of_str),
        )
        raw_rows = cur.fetchall()
    finally:
        conn.close()

    if not raw_rows:
        raise FeatureExtractionError(
            "insufficient_track",
            f"No AIS fixes recorded for vessel {mmsi} in {lookback_minutes}m lookback window",
            {"fixes_count": 0},
        )

    # 1. Group by exact timestamp string
    groups: Dict[str, List[Dict[str, Any]]] = {}
    for r in raw_rows:
        ts = r[0]
        rec = {
            "ts": r[0],
            "mmsi": r[1],
            "lat": r[2],
            "lon": r[3],
            "sog": r[4],
            "cog": r[5],
            "hdg": r[6],
            "ship_type": r[7],
            "name": r[8],
            "rowid": r[9],
        }
        groups.setdefault(ts, []).append(rec)

    # 2. Check for conflicts and deduplicate exact identical records
    deduped_groups: List[Dict[str, Any]] = []
    has_exact_duplicates = False

    for ts, records in groups.items():
        # Deduplicate exact identical telemetry
        unique_keys = set((rec["lat"], rec["lon"], rec["sog"], rec["cog"], rec["hdg"]) for rec in records)
        if len(unique_keys) < len(records):
            has_exact_duplicates = True

        # Check for conflicting position (>0.0001 deg) or incompatible speed (>0.2 kn)
        lats = [rec["lat"] for rec in records]
        lons = [rec["lon"] for rec in records]
        sogs = [rec["sog"] for rec in records if rec["sog"] is not None]

        max_pos_delta = max(max(lats) - min(lats), max(lons) - min(lons))
        if max_pos_delta > 0.0001:
            raise FeatureExtractionError(
                "insufficient_track",
                f"Conflicting position observations at timestamp {ts} (Δ = {max_pos_delta:.5f}°)",
                {"conflicting_timestamp": ts},
            )

        if len(sogs) > 1 and (max(sogs) - min(sogs)) > 0.2:
            raise FeatureExtractionError(
                "insufficient_track",
                f"Conflicting speed observations at timestamp {ts} (range = {max(sogs) - min(sogs):.2f} kn)",
                {"conflicting_timestamp": ts},
            )

        rep = records[0]
        ts_sec = int(parse_utc(ts).timestamp())
        deduped_groups.append({
            "ts": ts,
            "ts_sec": ts_sec,
            "lat": rep["lat"],
            "lon": rep["lon"],
            "sog": rep["sog"],
            "cog": rep["cog"],
            "hdg": rep["hdg"],
            "ship_type": rep["ship_type"],
            "name": rep["name"],
        })

    deduped_groups.sort(key=lambda g: g["ts_sec"])

    # 3. Quality Gate Checks
    distinct_count = len(deduped_groups)
    if distinct_count < 3:
        raise FeatureExtractionError(
            "insufficient_track",
            f"Fewer than 3 distinct timestamps observed ({distinct_count} fixes)",
            {"distinct_fixes": distinct_count},
        )

    t_first_sec = deduped_groups[0]["ts_sec"]
    t_last_sec = deduped_groups[-1]["ts_sec"]
    observed_span_sec = t_last_sec - t_first_sec

    if observed_span_sec < 900:
        raise FeatureExtractionError(
            "insufficient_track",
            f"Observed track span ({observed_span_sec // 60}m) is less than required 15 minutes",
            {"observed_span_seconds": observed_span_sec},
        )

    # Check newest fix freshness (relative to as_of)
    as_of_sec = int(as_of_dt.timestamp())
    newest_fix_age_sec = as_of_sec - t_last_sec
    if newest_fix_age_sec > 900:
        raise FeatureExtractionError(
            "insufficient_track",
            f"Newest fix age ({newest_fix_age_sec // 60}m) exceeds 15-minute freshness limit",
            {"newest_fix_age_seconds": newest_fix_age_sec},
        )

    # Check consecutive reporting gaps and implausible kinematic jumps
    largest_gap_sec = 0
    for i in range(1, len(deduped_groups)):
        prev = deduped_groups[i - 1]
        curr = deduped_groups[i]
        gap = curr["ts_sec"] - prev["ts_sec"]
        if gap > largest_gap_sec:
            largest_gap_sec = gap
        if gap > 900:
            raise FeatureExtractionError(
                "insufficient_track",
                f"Consecutive observation gap of {gap // 60}m exceeds 15-minute maximum continuity limit",
                {"largest_gap_seconds": gap},
            )

        # Check for implausible position jump (>50 kn implied speed)
        if gap > 0:
            dist_km = haversine_km(prev["lat"], prev["lon"], curr["lat"], curr["lon"])
            implied_kn = (dist_km / (gap / 3600.0)) * 0.539957
            if implied_kn > 50.0:
                raise FeatureExtractionError(
                    "insufficient_track",
                    f"Physically implausible jump between {prev['ts']} and {curr['ts']}: {implied_kn:.1f} kn",
                    {"implied_speed_kn": implied_kn},
                )

    # Check valid SOG percentage (>= 80%)
    valid_sogs = [g["sog"] for g in deduped_groups if g["sog"] is not None and not math.isnan(g["sog"])]
    valid_sog_ratio = len(valid_sogs) / float(distinct_count)
    if valid_sog_ratio < 0.8:
        raise FeatureExtractionError(
            "insufficient_track",
            f"Valid SOG coverage ({valid_sog_ratio * 100:.1f}%) is below 80% threshold",
            {"valid_sog_ratio": valid_sog_ratio},
        )

    # Check bounding box containment if area_bbox is provided
    if area_bbox:
        w, s, e, n = area_bbox
        for g in deduped_groups:
            if not (w <= g["lon"] <= e and s <= g["lat"] <= n):
                raise FeatureExtractionError(
                    "insufficient_track",
                    f"Track fix at ({g['lon']:.3f}, {g['lat']:.3f}) lies outside configured bounding box",
                    {"bbox": area_bbox},
                )

    # 4. Derive v1 Numeric Features
    median_sog_kn = round(median(valid_sogs), 2)
    sog_iqr_kn = round(iqr(valid_sogs), 2)

    # slow_time_fraction: fraction of bounded intervals with endpoints having 0.5 < SOG < 6.0 kn
    total_interval_sec = 0
    slow_interval_sec = 0

    for i in range(1, len(deduped_groups)):
        prev = deduped_groups[i - 1]
        curr = deduped_groups[i]
        dt_sec = curr["ts_sec"] - prev["ts_sec"]
        if 0 < dt_sec <= 900 and prev["sog"] is not None and curr["sog"] is not None:
            total_interval_sec += dt_sec
            if (0.5 < prev["sog"] < 6.0) and (0.5 < curr["sog"] < 6.0):
                slow_interval_sec += dt_sec

    if total_interval_sec == 0:
        raise FeatureExtractionError(
            "insufficient_track",
            "Zero valid bounded intervals available to compute slow_time_fraction",
        )

    slow_time_fraction = round(slow_interval_sec / float(total_interval_sec), 3)

    # median_corridor_distance_km
    distances = [near_km(g["lat"], g["lon"], lines) for g in deduped_groups]
    median_corridor_dist_km = round(median(distances), 2)

    geom_hash = compute_geometry_hash(lines)

    broad_class = (deduped_groups[-1]["ship_type"] or "undefined").lower()
    if "cargo" in broad_class:
        norm_class = "cargo"
    elif "tanker" in broad_class:
        norm_class = "tanker"
    elif "fish" in broad_class or "trawl" in broad_class:
        norm_class = "fishing"
    elif "pass" in broad_class or "ferry" in broad_class:
        norm_class = "passenger"
    elif "tug" in broad_class:
        norm_class = "tug"
    else:
        norm_class = "other"

    return {
        "mmsi": mmsi,
        "as_of": as_of_str,
        "class_group": norm_class,
        "reported_ship_type": deduped_groups[-1]["ship_type"],
        "feature_version": FEATURE_SCHEMA_VERSION,
        "corridor_id": corridor_id,
        "geometry_hash": geom_hash,
        "track_window": {
            "requested_minutes": lookback_minutes,
            "observed_start": deduped_groups[0]["ts"],
            "observed_end": deduped_groups[-1]["ts"],
            "observed_span_minutes": round(observed_span_sec / 60.0, 1),
            "distinct_fixes": distinct_count,
            "largest_gap_seconds": largest_gap_sec,
            "newest_fix_age_seconds": newest_fix_age_sec,
            "truncated": False,
        },
        "features": {
            "median_sog_kn": median_sog_kn,
            "sog_iqr_kn": sog_iqr_kn,
            "slow_time_fraction": slow_time_fraction,
            "median_corridor_distance_km": median_corridor_dist_km,
        },
        "provenance": {
            "has_exact_duplicates": has_exact_duplicates,
            "database_file": db_file.name,
        },
    }
