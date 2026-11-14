"""CableWatch ML Shadow Mode Evaluation CLI.

Evaluates a model manifest against held-out features and outputs JSON + Markdown reports.
"""

from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

from python.ml.model import MLModelManifest


def main():
    p = argparse.ArgumentParser(description="Evaluate CableWatch shadow-mode model.")
    p.add_argument("--config", required=True, help="Path to config.json")
    p.add_argument("--features", required=True, help="Path to held-out features.json")
    p.add_argument("--model", required=True, help="Path to model manifest.json or directory")
    p.add_argument("--output", required=True, help="Output directory for evaluation report")
    args = p.parse_args()

    model_path = Path(args.model).expanduser().resolve()
    if model_path.is_dir():
        model_path = model_path / "manifest.json"

    model = MLModelManifest.load(model_path)

    feat_path = Path(args.features).expanduser().resolve()
    with feat_path.open("r", encoding="utf-8") as f:
        feat_data = json.load(f)

    records = feat_data.get("features", [])
    results = []
    p95_count = 0

    for r in records:
        ev = model.evaluate(r["features"])
        if ev["anomaly_percentile"] >= 95.0:
            p95_count += 1
        results.append({
            "mmsi": r["mmsi"],
            "as_of": r["as_of"],
            "features": r["features"],
            "evaluation": ev,
        })

    out_dir = Path(args.output).expanduser().resolve()
    out_dir.mkdir(parents=True, exist_ok=True)

    json_report = out_dir / "evaluation.json"
    with json_report.open("w", encoding="utf-8") as f:
        json.dump({
            "model_id": model.model_id,
            "feature_version": model.feature_version,
            "test_sample_count": len(records),
            "p95_count": p95_count,
            "p95_fraction": round(p95_count / float(len(records)), 3) if records else 0,
            "results": results,
        }, f, indent=2)

    md_report = out_dir / "evaluation.md"
    with md_report.open("w", encoding="utf-8") as f:
        f.write(f"# CableWatch ML Shadow-Mode Evaluation Report\n\n")
        f.write(f"- **Model ID:** `{model.model_id}`\n")
        f.write(f"- **Feature Schema:** `{model.feature_version}`\n")
        f.write(f"- **Evaluated Windows:** {len(records)}\n")
        f.write(f"- **Windows $\\ge 95$th Percentile:** {p95_count} ({round(p95_count / max(1, len(records)) * 100, 1)}%)\n")
        f.write(f"- **Synthetic Demo:** {model.is_synthetic_demo}\n\n")
        f.write("### Limitations & Caveats\n")
        f.write("- Percentile is an empirical rank against the reference distribution, not a damage probability.\n")
        f.write("- Does not classify intent, anchor deployment, or physical seabed contact.\n")

    print(f"Evaluation completed. JSON written to {json_report}, Markdown to {md_report}")


if __name__ == "__main__":
    main()
