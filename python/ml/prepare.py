"""CableWatch ML Shadow Mode Feature Preparation CLI.

Extracts v1 features from SQLite database according to configuration file.
"""

from __future__ import annotations

import argparse
import json
import sqlite3
import sys
from pathlib import Path

from python.ml.features import extract_track_features, parse_utc


def main():
    p = argparse.ArgumentParser(description="Prepare v1 ML track features from SQLite AIS database.")
    p.add_argument("--config", required=True, help="Path to config.json")
    p.add_argument("--output", required=True, help="Path to output features.json")
    args = p.parse_args()

    cfg_path = Path(args.config).expanduser().resolve()
    if not cfg_path.is_file():
        print(f"ERROR: Config file not found: {cfg_path}", file=sys.stderr)
        sys.exit(1)

    with cfg_path.open("r", encoding="utf-8") as f:
        cfg = json.load(f)

    db_path = cfg.get("database_path")
    corridor = cfg.get("corridor_geometry", [])
    corridor_id = cfg.get("corridor_id", "default")
    area_bbox = cfg.get("area_bbox")

    conn = sqlite3.connect(f"{Path(db_path).resolve().as_uri()}?mode=ro", uri=True)
    try:
        # Sample active vessels
        cur = conn.cursor()
        cur.execute("SELECT DISTINCT mmsi, MAX(ts) FROM fixes GROUP BY mmsi LIMIT 50")
        vessels = cur.fetchall()
    finally:
        conn.close()

    features_list = []
    skipped = []

    for mmsi, max_ts in vessels:
        try:
            feats = extract_track_features(
                db_path=db_path,
                mmsi=mmsi,
                as_of=max_ts,
                lines=corridor,
                corridor_id=corridor_id,
                area_bbox=tuple(area_bbox) if area_bbox else None,
            )
            features_list.append(feats)
        except Exception as e:
            skipped.append({"mmsi": mmsi, "as_of": max_ts, "reason": str(e)})

    out_file = Path(args.output).expanduser().resolve()
    out_file.parent.mkdir(parents=True, exist_ok=True)
    with out_file.open("w", encoding="utf-8") as f:
        json.dump(
            {
                "feature_version": "v1",
                "extracted_count": len(features_list),
                "skipped_count": len(skipped),
                "features": features_list,
                "skipped": skipped,
            },
            f,
            indent=2,
        )

    print(f"Extracted {len(features_list)} feature records ({len(skipped)} skipped) to {out_file}")


if __name__ == "__main__":
    main()
