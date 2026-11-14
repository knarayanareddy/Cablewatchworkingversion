"""CableWatch ML Shadow Mode Training CLI.

Fits robust baseline (median + IQR) and reference empirical score distribution.
Enforces multi-day temporal coverage, minimum sample counts, and chronological held-out evaluation.
Optionally fits IsolationForest when scikit-learn is installed.
"""

from __future__ import annotations

import argparse
import datetime as dt
import json
import sys
from pathlib import Path
from typing import Any, Dict, List

from python.ml.features import iqr, median, parse_utc
from python.ml.model import FEATURE_ORDER, IQR_FLOORS, calculate_empirical_percentile


def main():
    p = argparse.ArgumentParser(description="Train CableWatch shadow-mode model.")
    p.add_argument("--config", required=True, help="Path to config.json")
    p.add_argument("--features", required=True, help="Path to features.json from prepare")
    p.add_argument("--output", required=True, help="Path to output model manifest directory")
    p.add_argument("--synthetic-demo", action="store_true", help="Explicitly mark output as a synthetic/demo manifest without enforcing real multi-day validation")
    p.add_argument("--min-samples", type=int, default=200, help="Minimum qualifying trajectory windows required for non-synthetic model (default 200)")
    p.add_argument("--min-days", type=float, default=3.0, help="Minimum days of historical coverage required for non-synthetic model (default 3.0)")
    args = p.parse_args()

    cfg_path = Path(args.config).expanduser().resolve()
    with cfg_path.open("r", encoding="utf-8") as f:
        cfg = json.load(f)

    feat_path = Path(args.features).expanduser().resolve()
    with feat_path.open("r", encoding="utf-8") as f:
        feat_data = json.load(f)

    records: List[Dict[str, Any]] = feat_data.get("features", [])
    if not records:
        print("ERROR: Input features file contains zero records.", file=sys.stderr)
        sys.exit(1)

    # Sort records chronologically by timestamp
    def get_ts(r: Dict[str, Any]) -> str:
        return r.get("as_of") or r.get("track_window", {}).get("observed_end", "")

    records.sort(key=get_ts)

    # Calculate temporal coverage
    parsed_dates = []
    for r in records:
        ts_str = get_ts(r)
        if ts_str:
            try:
                parsed_dates.append(parse_utc(ts_str))
            except Exception:
                pass

    distinct_calendar_days = len(set(d.date() for d in parsed_dates)) if parsed_dates else 0
    time_span_days = (parsed_dates[-1] - parsed_dates[0]).total_seconds() / 86400.0 if len(parsed_dates) >= 2 else 0.0

    # Validation gates for non-synthetic operational model
    validation_failures = []
    if len(records) < args.min_samples:
        validation_failures.append(
            f"Insufficient sample volume: {len(records)} records observed (minimum {args.min_samples} required for operational baseline)."
        )

    if distinct_calendar_days < int(args.min_days) or time_span_days < args.min_days:
        validation_failures.append(
            f"Insufficient temporal coverage: {distinct_calendar_days} calendar days spanning {time_span_days:.1f} days (minimum {args.min_days} days required)."
        )

    is_synthetic = False
    if validation_failures:
        if not args.synthetic_demo:
            print("ERROR: Training validation failed for operational model:", file=sys.stderr)
            for fail in validation_failures:
                print(f"  - {fail}", file=sys.stderr)
            print("\nTo train an unvalidated demonstration manifest, re-run with --synthetic-demo.", file=sys.stderr)
            sys.exit(1)
        else:
            is_synthetic = True
            print("WARNING: Dataset does not satisfy multi-day validation gates; manifest marked as --synthetic-demo.")
    elif args.synthetic_demo:
        is_synthetic = True

    # Chronological train/evaluation split (80% train, 20% held-out test)
    split_idx = max(1, int(len(records) * 0.8)) if len(records) >= 5 else len(records)
    train_records = records[:split_idx]
    eval_records = records[split_idx:] if split_idx < len(records) else []

    # Compute baseline medians and IQRs on the training partition
    medians: Dict[str, float] = {}
    iqrs: Dict[str, float] = {}
    for name in FEATURE_ORDER:
        vals = [r["features"][name] for r in train_records if name in r.get("features", {})]
        if vals:
            medians[name] = round(median(vals), 2)
            iqrs[name] = round(iqr(vals), 2)

    # Compute reference scores on training records
    ref_scores: List[float] = []
    for r in train_records:
        f = r.get("features", {})
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

    # Held-out evaluation
    eval_metrics: Dict[str, Any] = {
        "eval_sample_count": len(eval_records),
        "train_sample_count": len(train_records),
    }
    if eval_records:
        eval_scores = []
        for r in eval_records:
            f = r.get("features", {})
            devs = []
            for name in FEATURE_ORDER:
                val = f.get(name)
                med = medians.get(name)
                iqr_val = iqrs.get(name)
                if val is not None and med is not None and iqr_val is not None:
                    floor = IQR_FLOORS.get(name, 0.1)
                    devs.append(abs(val - med) / max(iqr_val, floor))
            if devs:
                eval_scores.append(max(devs))

        if eval_scores:
            eval_metrics["eval_median_score"] = round(median(eval_scores), 2)
            eval_metrics["eval_heldout_start"] = get_ts(eval_records[0])
            eval_metrics["eval_heldout_end"] = get_ts(eval_records[-1])

    model_id = cfg.get("model_id", "bornholm_cargo_v1")
    manifest = {
        "model_id": model_id,
        "feature_version": "v1",
        "area_id": cfg.get("area_id", "bornholm"),
        "class_group": cfg.get("class_group", "cargo"),
        "geometry_hash": cfg.get("geometry_hash", ""),
        "training_end": get_ts(train_records[-1]) if train_records else cfg.get("training_end", ""),
        "sample_count": len(train_records),
        "feature_medians": medians,
        "feature_iqrs": iqrs,
        "reference_scores": ref_scores,
        "heldout_evaluation": eval_metrics,
        "is_synthetic_demo": is_synthetic,
    }

    out_dir = Path(args.output).expanduser().resolve()
    out_dir.mkdir(parents=True, exist_ok=True)
    manifest_file = out_dir / "manifest.json"
    with manifest_file.open("w", encoding="utf-8") as f:
        json.dump(manifest, f, indent=2)

    print(f"Model manifest successfully trained and written to {manifest_file} (is_synthetic_demo={is_synthetic})")


if __name__ == "__main__":
    main()
