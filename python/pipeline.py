#!/usr/bin/env python3
"""Unified Cable Watch AIS Ingestion & Replay Pipeline.

Ingest any daily AIS ZIP archive, filter with bounding box and sample limits,
build an indexed SQLite database, and optionally hot-swap the active replay server.
"""

import argparse
import json
import os
import re
import subprocess
import sys
import urllib.request
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
WORK = ROOT / "work"
PREPROCESS = ROOT / "python/ais_preprocess.py"
LOCAL_AIS = ROOT / "python/local_ais.py"

PRESETS = {
    "baltic": [13.8, 54.8, 14.4, 55.3],       # Bornholm / Arkona Basin
    "bornholm": [13.8, 54.8, 14.4, 55.3],
    "fehmarn": [11.0, 54.4, 11.6, 54.7],      # Fehmarn Belt
    "storebaelt": [10.8, 55.2, 11.3, 55.6],   # Great Belt
    "oresund": [12.4, 55.5, 13.0, 56.1],      # The Sound
}


def hot_switch(db_path: Path, port: int = 8765) -> bool:
    """Notify running local AIS service to hot-swap active database."""
    url = f"http://127.0.0.1:{port}/switch?db={urllib.parse.quote(str(db_path))}"
    try:
        req = urllib.request.Request(url, headers={"Host": f"127.0.0.1:{port}"})
        with urllib.request.urlopen(req, timeout=3) as resp:
            data = json.load(resp)
            if data.get("ok"):
                return True
    except Exception:
        pass
    return False


def run_pipeline(
    zip_path: str,
    bbox: list = None,
    preset: str = None,
    max_rows: int = None,
    name: str = None,
    max_output_mb: float = 50.0,
    max_db_mb: float = 150.0,
    switch: bool = True,
    port: int = 8765,
    force: bool = False,
):
    src = Path(zip_path).expanduser().resolve()
    if not src.is_file():
        raise FileNotFoundError(f"Source ZIP not found: {src}")

    # Determine bounding box
    if preset and preset.lower() in PRESETS:
        selected_bbox = PRESETS[preset.lower()]
    elif bbox and len(bbox) == 4:
        selected_bbox = [float(x) for x in bbox]
    else:
        selected_bbox = PRESETS["baltic"]

    # Determine and strictly validate output naming
    if name:
        if not re.fullmatch(r"[a-zA-Z0-9_-]{1,64}", name):
            raise ValueError(
                f"Invalid output name '{name}': must be 1-64 alphanumeric, dash, or underscore characters without paths."
            )
    else:
        stem = src.stem
        # e.g. aisdk-2026-01-13 -> ais_2026_01_13
        clean_stem = re.sub(r"[^a-zA-Z0-9_-]", "_", stem)
        suffix = f"_{preset}" if preset else ""
        if max_rows:
            suffix += f"_{max_rows//1000}k" if max_rows >= 1000 else f"_{max_rows}r"
        name = f"{clean_stem}{suffix}"

    WORK.mkdir(parents=True, exist_ok=True)
    out_csv_gz = WORK / f"{name}.csv.gz"
    out_sqlite = WORK / f"{name}.sqlite"
    report_json = WORK / f"{name}.csv.gz.report.json"

    # Enforce safe overwrite prevention
    existing = [f.name for f in (out_csv_gz, report_json, out_sqlite) if f.exists()]
    if existing:
        if not force:
            raise FileExistsError(
                f"Output target '{name}' already exists in work/ ({', '.join(existing)}). "
                f"Choose a new name or pass --force to overwrite."
            )
        for f in (out_csv_gz, report_json, out_sqlite):
            f.unlink(missing_ok=True)

    print(f"\n[1/3] Preprocessing {src.name}...")
    print(f"      BBox: {selected_bbox}")
    print(f"      Max rows: {max_rows if max_rows else 'ALL (Full file)'}")

    cmd_prep = [
        sys.executable,
        str(PREPROCESS),
        "run",
        str(src),
        "--output",
        str(out_csv_gz),
        "--bbox",
        *(str(x) for x in selected_bbox),
        "--assume-utc",
        "--max-output-mb",
        str(max_output_mb),
    ]
    if max_rows:
        cmd_prep.extend(["--max-rows", str(max_rows)])

    res_prep = subprocess.run(cmd_prep, capture_output=True, text=True)
    if res_prep.returncode != 0:
        raise RuntimeError(f"Preprocessing failed:\n{res_prep.stderr or res_prep.stdout}")

    try:
        prep_report = json.loads(res_prep.stdout)
        rows_read = prep_report.get("counts", {}).get("rows_read", 0)
        rows_written = prep_report.get("counts", {}).get("rows_written", 0)
        t_min = prep_report.get("min_source_timestamp_utc", "N/A")
        t_max = prep_report.get("max_source_timestamp_utc", "N/A")
        print(f"      Rows read: {rows_read:,} -> Filtered matches: {rows_written:,}")
        print(f"      Time span: {t_min} to {t_max}")
    except Exception:
        print("      Preprocessing finished.")

    print(f"\n[2/3] Building SQLite index at {out_sqlite.name}...")
    cmd_db = [
        sys.executable,
        str(LOCAL_AIS),
        "build-db",
        str(out_csv_gz),
        "--output",
        str(out_sqlite),
        "--max-database-mb",
        str(max_db_mb),
    ]
    res_db = subprocess.run(cmd_db, capture_output=True, text=True)
    if res_db.returncode != 0:
        raise RuntimeError(f"Database build failed:\n{res_db.stderr or res_db.stdout}")

    try:
        db_meta = json.loads(res_db.stdout)
        size_kb = db_meta.get("database_bytes", 0) / 1024
        print(f"      SQLite ready ({size_kb:.1f} KB).")
    except Exception:
        print("      SQLite database built.")

    print("\n[3/3] Checking active server...")
    if switch:
        switched = hot_switch(out_sqlite, port)
        if switched:
            print(f"      SUCCESS: Active server immediately hot-swapped to '{out_sqlite.name}'!")
            print("      Refresh your browser at http://127.0.0.1:3100/real to see the new data.")
        else:
            print(f"      Note: Server on port {port} was not reached or does not support hot-switch.")
            print(f"      You can start it manually with: python3 python/local_ais.py serve {out_sqlite}")

    return {
        "sqlite_path": str(out_sqlite),
        "csv_path": str(out_csv_gz),
        "name": name,
    }


def main():
    p = argparse.ArgumentParser(description="Ingest any daily AIS ZIP archive into Cable Watch")
    p.add_argument("zip", help="Path to daily AIS ZIP archive (e.g. ~/Downloads/aisdk-2026-01-13.zip)")
    p.add_argument("--bbox", nargs=4, type=float, metavar=("WEST", "SOUTH", "EAST", "NORTH"), help="Custom bounding box")
    p.add_argument("--preset", choices=list(PRESETS.keys()), default="baltic", help="Predefined bounding box preset")
    p.add_argument("--max-rows", type=int, default=1000000, help="Row limit (default: 1,000,000; set 0 for full file)")
    p.add_argument("--name", help="Custom identifier for generated sqlite file")
    p.add_argument("--max-output-mb", type=float, default=100.0, help="Max compressed CSV size in MB (default: 100)")
    p.add_argument("--max-db-mb", type=float, default=200.0, help="Max SQLite database size in MB (default: 200)")
    p.add_argument("--no-switch", action="store_true", help="Do not attempt to hot-switch the running server")
    p.add_argument("--port", type=int, default=8765, help="Port of running local_ais server (default: 8765)")
    p.add_argument("--force", action="store_true", help="Explicitly allow overwriting existing output database and files")

    args = p.parse_args()
    limit = None if args.max_rows == 0 else args.max_rows

    try:
        run_pipeline(
            zip_path=args.zip,
            bbox=args.bbox,
            preset=args.preset,
            max_rows=limit,
            name=args.name,
            max_output_mb=args.max_output_mb,
            max_db_mb=args.max_db_mb,
            switch=not args.no_switch,
            port=args.port,
            force=args.force,
        )
    except Exception as e:
        print(f"\nERROR: {e}", file=sys.stderr)
        sys.exit(1)


if __name__ == "__main__":
    main()
