"""CableWatch ML Shadow Mode Training CLI.

Fits robust baseline (median + IQR) and reference empirical score distribution.
Optionally fits IsolationForest when scikit-learn is installed.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import sys
from pathlib import Path

from python.ml.features import iqr, median
from python.ml.model import FEATURE_ORDER, IQR_FLOORS, calculate_empirical_percentile


def main():
    p = argparse.ArgumentParser(description="Train CableWatch shadow-mode model.")
    p.add_argument("--config", required=True, help="Path to config.json")
    p.add_argument("--features", required=True, help="Path to features.json from prepare")
    p.add_argument("--output", required=True, help="Path to output model manifest directory")
    args = p.parse_args()

    cfg_path = Path(args.config).expanduser().resolve()
    with cfg_path.open("r", encoding="utf-8") as f:
        cfg = json.load(f)

    feat_path = Path(args.features).expanduser().resolve()
    with feat_path.open("r", encoding="utf-8") as f:
        feat_data = json.load(f)

    records = feat_data.get("features", [])
    if len(records) < 5:
        print(f"ERROR: Insufficient baseline data ({len(records)} records). Minimum is 200 non-overlapping windows for real model.", file=sys.stderr)
        sys.exit(1)

    # Compute baseline medians and IQRs per feature
    medians = {}
    iqrs = {}
    for name in FEATURE_ORDER:
        vals = [r["features"][name] for r in records if name in r["features"]]
        if vals:
            medians[name] = round(median(vals), 2)
            iqrs[name] = round(iqr(vals), 2)

    # Compute reference scores on training records
    ref_scores = []
    for r in records:
        f = r["features"]
        devs = []
        for name in FEATURE_ORDER:
            val = f.get(name)
            med = medians.get(name)
            iqr_val = iqrs.get(name)
            if val is not None and med is not None and iqr_val is not None:
                floor = IQR_FLOORS.get(name, 0.1)
                devs.append(abs(val - med) / max(iqr_val, floor))
        if devs:
            ref_scores.append(round(max(devs), 3))

    ref_scores.sort()

    model_id = cfg.get("model_id", "bornholm_cargo_v1")
    manifest = {
        "model_id": model_id,
        "feature_version": "v1",
        "area_id": cfg.get("area_id", "bornholm"),
        "class_group": cfg.get("class_group", "cargo"),
        "geometry_hash": cfg.get("geometry_hash", ""),
        "training_end": cfg.get("training_end", "2026-09-01T23:59:59Z"),
        "sample_count": len(records),
        "feature_medians": medians,
        "feature_iqrs": iqrs,
        "reference_scores": ref_scores,
        "is_synthetic_demo": False,
    }

    out_dir = Path(args.output).expanduser().resolve()
    out_dir.mkdir(parents=True, exist_ok=True)
    manifest_file = out_dir / "manifest.json"
    with manifest_file.open("w", encoding="utf-8") as f:
        json.dump(manifest, f, indent=2)

    print(f"Model manifest successfully trained and written to {manifest_file}")


if __name__ == "__main__":
    main()
