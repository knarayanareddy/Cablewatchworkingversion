#!/usr/bin/env python3
"""Unit and integration tests for ML Shadow Mode historical pattern comparison."""
import datetime as dt
import json
import sqlite3
import sys
import tempfile
import threading
import unittest
import urllib.request
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

from python.ml.features import (
    extract_track_features,
    percentile_linear,
    compute_geometry_hash,
    FeatureExtractionError,
)
from python.ml.model import (
    MLModelManifest,
    calculate_empirical_percentile,
    generate_synthetic_reference_model,
)
from python import local_ais


class MLShadowFeaturesTest(unittest.TestCase):
    def test_linear_percentile(self):
        vals = [1.0, 2.0, 3.0, 4.0, 5.0]
        # median (50th percentile) should be 3.0
        self.assertAlmostEqual(percentile_linear(vals, 0.50), 3.0)
        # 25th percentile of 5 items: index 4 * 0.25 = 1.0 -> 2.0
        self.assertAlmostEqual(percentile_linear(vals, 0.25), 2.0)
        # 75th percentile of 5 items: index 4 * 0.75 = 3.0 -> 4.0
        self.assertAlmostEqual(percentile_linear(vals, 0.75), 4.0)

    def test_empirical_percentile_ties(self):
        ref = [1.0, 2.0, 2.0, 4.0]
        # value 2.0: count(ref <= 2.0) = 3 out of 4 -> 75%
        p = calculate_empirical_percentile(ref, 2.0)
        self.assertAlmostEqual(p, 75.0)

        # value 0.5: count(ref <= 0.5) = 0 out of 4 -> 0%
        p0 = calculate_empirical_percentile(ref, 0.5)
        self.assertAlmostEqual(p0, 0.0)

        # value 5.0: count(ref <= 5.0) = 4 out of 4 -> 100%
        p100 = calculate_empirical_percentile(ref, 5.0)
        self.assertAlmostEqual(p100, 100.0)

    def test_geometry_hash_deterministic(self):
        coords = [[[13.82, 54.82], [13.95, 54.94], [14.05, 55.04]]]
        h1 = compute_geometry_hash(coords)
        h2 = compute_geometry_hash(coords)
        self.assertEqual(h1, h2)
        self.assertEqual(len(h1), 64)  # SHA-256


class MLShadowDatabaseAndGatesTest(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.db_path = Path(self.tmp.name) / 'test_shadow.sqlite'
        conn = sqlite3.connect(str(self.db_path))
        conn.execute(
            'CREATE TABLE fixes(ts TEXT NOT NULL, mmsi TEXT NOT NULL, lat REAL NOT NULL, lon REAL NOT NULL, '
            'sog REAL, cog REAL, hdg REAL, mobile TEXT, ship_type TEXT, name TEXT, nav TEXT, '
            'sog_q TEXT, cog_q TEXT, hdg_q TEXT)'
        )
        conn.execute('CREATE INDEX fixes_vessel ON fixes(mmsi, ts)')
        conn.execute('CREATE TABLE metadata(json TEXT NOT NULL)')
        meta = {
            'records': 100,
            'min_timestamp_utc': '2026-09-07T00:00:00Z',
            'max_timestamp_utc': '2026-09-07T02:00:00Z',
            'preprocessor_report': {'truncated_by_row_limit': False}
        }
        conn.execute('INSERT INTO metadata(json) VALUES(?)', (json.dumps(meta),))
        conn.commit()
        conn.close()

        self.lines = [[[13.82, 54.82], [13.95, 54.94], [14.05, 55.04], [14.18, 55.15], [14.32, 55.28]]]

    def tearDown(self):
        self.tmp.cleanup()

    def _insert_fixes(self, mmsi: str, rows):
        conn = sqlite3.connect(str(self.db_path))
        for r in rows:
            conn.execute(
                'INSERT INTO fixes(ts, mmsi, lat, lon, sog, cog, hdg, mobile, ship_type, name, nav, sog_q, cog_q, hdg_q) '
                'VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
                (r[0], mmsi, r[1], r[2], r[3], r[4], r[5], 'Class A', 'Cargo', 'TEST VESSEL', 'Under way using engine', 'valid', 'valid', 'valid')
            )
        conn.commit()
        conn.close()

    def test_quality_gate_few_fixes(self):
        # Only 2 distinct fixes
        self._insert_fixes('219000001', [
            ('2026-09-07T01:00:00Z', 55.0, 14.0, 10.0, 90.0, 90.0),
            ('2026-09-07T01:20:00Z', 55.05, 14.05, 10.0, 90.0, 90.0),
        ])
        with self.assertRaises(FeatureExtractionError) as ctx:
            extract_track_features(str(self.db_path), '219000001', '2026-09-07T01:20:00Z', self.lines)
        self.assertEqual(ctx.exception.code, 'insufficient_track')
        self.assertIn('Fewer than 3 distinct timestamps', ctx.exception.message)

    def test_quality_gate_short_span(self):
        # 3 fixes within 10 minutes (< 15m span required)
        self._insert_fixes('219000002', [
            ('2026-09-07T01:00:00Z', 55.0, 14.0, 10.0, 90.0, 90.0),
            ('2026-09-07T01:05:00Z', 55.01, 14.01, 10.0, 90.0, 90.0),
            ('2026-09-07T01:10:00Z', 55.02, 14.02, 10.0, 90.0, 90.0),
        ])
        with self.assertRaises(FeatureExtractionError) as ctx:
            extract_track_features(str(self.db_path), '219000002', '2026-09-07T01:10:00Z', self.lines)
        self.assertEqual(ctx.exception.code, 'insufficient_track')
        self.assertIn('less than required 15 minutes', ctx.exception.message)

    def test_quality_gate_large_gap(self):
        # 3 fixes over 30 mins, but with a 20-minute gap (> 15m max gap)
        self._insert_fixes('219000003', [
            ('2026-09-07T01:00:00Z', 55.0, 14.0, 10.0, 90.0, 90.0),
            ('2026-09-07T01:05:00Z', 55.01, 14.01, 10.0, 90.0, 90.0),
            ('2026-09-07T01:25:00Z', 55.02, 14.02, 10.0, 90.0, 90.0),
        ])
        with self.assertRaises(FeatureExtractionError) as ctx:
            extract_track_features(str(self.db_path), '219000003', '2026-09-07T01:25:00Z', self.lines)
        self.assertEqual(ctx.exception.code, 'insufficient_track')
        self.assertIn('exceeds 15-minute maximum continuity limit', ctx.exception.message)

    def test_quality_gate_stale_newest_fix(self):
        # Newest fix is 25 minutes before as_of (> 15m staleness limit)
        self._insert_fixes('219000004', [
            ('2026-09-07T01:00:00Z', 55.0, 14.0, 10.0, 90.0, 90.0),
            ('2026-09-07T01:10:00Z', 55.01, 14.01, 10.0, 90.0, 90.0),
            ('2026-09-07T01:20:00Z', 55.02, 14.02, 10.0, 90.0, 90.0),
        ])
        with self.assertRaises(FeatureExtractionError) as ctx:
            extract_track_features(str(self.db_path), '219000004', '2026-09-07T01:45:00Z', self.lines)
        self.assertEqual(ctx.exception.code, 'insufficient_track')
        self.assertIn('Newest fix age', ctx.exception.message)

    def test_successful_feature_extraction(self):
        # Valid sequence over 40 minutes with 5 fixes
        self._insert_fixes('219000005', [
            ('2026-09-07T01:00:00Z', 55.0, 14.0, 11.0, 90.0, 90.0),
            ('2026-09-07T01:10:00Z', 55.02, 14.04, 11.5, 90.0, 90.0),
            ('2026-09-07T01:20:00Z', 55.04, 14.08, 12.0, 90.0, 90.0),
            ('2026-09-07T01:30:00Z', 55.06, 14.12, 12.2, 90.0, 90.0),
            ('2026-09-07T01:40:00Z', 55.08, 14.16, 12.5, 90.0, 90.0),
        ])
        feats = extract_track_features(str(self.db_path), '219000005', '2026-09-07T01:40:00Z', self.lines)
        f = feats['features']
        self.assertEqual(feats['class_group'], 'cargo')
        self.assertAlmostEqual(f['median_sog_kn'], 12.0)
        self.assertEqual(f['slow_time_fraction'], 0.0)
        self.assertGreater(f['median_corridor_distance_km'], 0.0)


class MLShadowHTTPIntegrationTest(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.db_path = Path(self.tmp.name) / 'bornholm_shadow.sqlite'
        conn = sqlite3.connect(str(self.db_path))
        conn.execute(
            'CREATE TABLE fixes(ts TEXT NOT NULL, mmsi TEXT NOT NULL, lat REAL NOT NULL, lon REAL NOT NULL, '
            'sog REAL, cog REAL, hdg REAL, mobile TEXT, ship_type TEXT, name TEXT, nav TEXT, '
            'sog_q TEXT, cog_q TEXT, hdg_q TEXT)'
        )
        conn.execute('CREATE INDEX fixes_vessel ON fixes(mmsi, ts)')
        conn.execute('CREATE TABLE metadata(json TEXT NOT NULL)')
        meta = {
            'records': 20,
            'min_timestamp_utc': '2026-09-07T00:00:00Z',
            'max_timestamp_utc': '2026-09-07T02:00:00Z',
            'preprocessor_report': {'truncated_by_row_limit': False}
        }
        conn.execute('INSERT INTO metadata(json) VALUES(?)', (json.dumps(meta),))
        # Insert 4 valid fixes for Cargo vessel 219111222
        for ts, lat, lon, sog in [
            ('2026-09-07T01:00:00Z', 55.00, 14.00, 11.0),
            ('2026-09-07T01:10:00Z', 55.02, 14.03, 11.2),
            ('2026-09-07T01:20:00Z', 55.04, 14.06, 11.5),
            ('2026-09-07T01:30:00Z', 55.06, 14.09, 11.8),
        ]:
            conn.execute(
                'INSERT INTO fixes(ts, mmsi, lat, lon, sog, cog, hdg, mobile, ship_type, name, nav, sog_q, cog_q, hdg_q) '
                'VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
                (ts, '219111222', lat, lon, sog, 90.0, 90.0, 'Class A', 'Cargo', 'VESSEL CARGO', 'Under way', 'valid', 'valid', 'valid')
            )
        # Insert 4 valid fixes for Tanker vessel 219333444
        for ts, lat, lon, sog in [
            ('2026-09-07T01:00:00Z', 55.00, 14.00, 11.0),
            ('2026-09-07T01:10:00Z', 55.02, 14.03, 11.2),
            ('2026-09-07T01:20:00Z', 55.04, 14.06, 11.5),
            ('2026-09-07T01:30:00Z', 55.06, 14.09, 11.8),
        ]:
            conn.execute(
                'INSERT INTO fixes(ts, mmsi, lat, lon, sog, cog, hdg, mobile, ship_type, name, nav, sog_q, cog_q, hdg_q) '
                'VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
                (ts, '219333444', lat, lon, sog, 90.0, 90.0, 'Class A', 'Tanker', 'VESSEL TANKER', 'Under way', 'valid', 'valid', 'valid')
            )
        conn.commit()
        conn.close()

        # Start a local_ais server on dynamic port
        self.server = local_ais.Server(('127.0.0.1', 0), str(self.db_path))
        self.port = self.server.server_port
        self.thread = threading.Thread(target=self.server.serve_forever, daemon=True)
        self.thread.start()

    def tearDown(self):
        self.server.shutdown()
        self.server.server_close()
        self.tmp.cleanup()

    def test_ml_score_endpoint_ok(self):
        url = f'http://127.0.0.1:{self.port}/ml-score?mmsi=219111222&at=2026-09-07T01:30:00Z'
        with urllib.request.urlopen(url) as resp:
            self.assertEqual(resp.status, 200)
            data = json.loads(resp.read().decode('utf-8'))
            self.assertEqual(data.get('status'), 'ok')
            self.assertEqual(data.get('mode'), 'shadow_experimental')
            self.assertEqual(data.get('mmsi'), '219111222')
            self.assertIn('anomaly_percentile', data)
            self.assertIn('comparison_features', data)
            self.assertTrue(len(data['comparison_features']) >= 4)
            self.assertTrue(data.get('is_synthetic_demo'))
            self.assertTrue(any('DEMONSTRATION ONLY' in c for c in data.get('caveats', [])))

    def test_ml_score_endpoint_insufficient_track(self):
        url = f'http://127.0.0.1:{self.port}/ml-score?mmsi=219999999&at=2026-09-07T01:30:00Z'
        with urllib.request.urlopen(url) as resp:
            self.assertEqual(resp.status, 200)
            data = json.loads(resp.read().decode('utf-8'))
            self.assertEqual(data.get('status'), 'insufficient_track')
            self.assertIn('No AIS fixes recorded', data.get('reason', ''))

    def test_ml_score_validation(self):
        # Invalid MMSI
        with self.assertRaises(urllib.error.HTTPError) as ctx:
            urllib.request.urlopen(f'http://127.0.0.1:{self.port}/ml-score?mmsi=ABC&at=2026-09-07T01:30:00Z')
        self.assertEqual(ctx.exception.code, 400)

    def test_context_matching_refuses_unregistered_class(self):
        # Vessel 219333444 is Tanker, but model registry only has bornholm:cargo
        url = f'http://127.0.0.1:{self.port}/ml-score?mmsi=219333444&at=2026-09-07T01:30:00Z'
        with urllib.request.urlopen(url) as resp:
            self.assertEqual(resp.status, 200)
            data = json.loads(resp.read().decode('utf-8'))
            self.assertEqual(data.get('status'), 'insufficient_baseline')
            self.assertIn("No baseline model trained for area 'bornholm' and vessel class 'tanker'", data.get('reason', ''))

    def test_context_matching_refuses_truncated_dataset(self):
        # Create database with truncated_by_row_limit = True
        trunc_db = Path(self.tmp.name) / 'bornholm_truncated.sqlite'
        conn = sqlite3.connect(str(trunc_db))
        conn.execute(
            'CREATE TABLE fixes(ts TEXT NOT NULL, mmsi TEXT NOT NULL, lat REAL NOT NULL, lon REAL NOT NULL, '
            'sog REAL, cog REAL, hdg REAL, mobile TEXT, ship_type TEXT, name TEXT, nav TEXT, '
            'sog_q TEXT, cog_q TEXT, hdg_q TEXT)'
        )
        conn.execute('CREATE INDEX fixes_vessel ON fixes(mmsi, ts)')
        conn.execute('CREATE TABLE metadata(json TEXT NOT NULL)')
        meta = {
            'records': 100,
            'min_timestamp_utc': '2026-09-07T00:00:00Z',
            'max_timestamp_utc': '2026-09-07T02:00:00Z',
            'preprocessor_report': {'truncated_by_row_limit': True, 'input_file': 'sample.zip'}
        }
        conn.execute('INSERT INTO metadata(json) VALUES(?)', (json.dumps(meta),))
        conn.commit()
        conn.close()

        server = local_ais.Server(('127.0.0.1', 0), str(trunc_db))
        thread = threading.Thread(target=server.serve_forever, daemon=True)
        thread.start()
        try:
            url = f'http://127.0.0.1:{server.server_port}/ml-score?mmsi=219111222&at=2026-09-07T01:30:00Z'
            with urllib.request.urlopen(url) as resp:
                self.assertEqual(resp.status, 200)
                data = json.loads(resp.read().decode('utf-8'))
                self.assertEqual(data.get('status'), 'truncated_coverage')
                self.assertIn('truncated at ingestion', data.get('reason', ''))
        finally:
            server.shutdown()
            server.server_close()

    def test_training_validation_gates(self):
        import subprocess
        # Create minimal test features file with only 5 records on same day
        sample_feats = {
            'features': [
                {'as_of': '2026-09-07T01:00:00Z', 'features': {'median_sog_kn': 10.0, 'sog_iqr_kn': 1.0, 'slow_time_fraction': 0.0, 'median_corridor_distance_km': 5.0}},
                {'as_of': '2026-09-07T01:10:00Z', 'features': {'median_sog_kn': 10.5, 'sog_iqr_kn': 1.1, 'slow_time_fraction': 0.0, 'median_corridor_distance_km': 5.2}},
                {'as_of': '2026-09-07T01:20:00Z', 'features': {'median_sog_kn': 11.0, 'sog_iqr_kn': 1.2, 'slow_time_fraction': 0.0, 'median_corridor_distance_km': 5.4}},
                {'as_of': '2026-09-07T01:30:00Z', 'features': {'median_sog_kn': 11.5, 'sog_iqr_kn': 1.3, 'slow_time_fraction': 0.0, 'median_corridor_distance_km': 5.6}},
                {'as_of': '2026-09-07T01:40:00Z', 'features': {'median_sog_kn': 12.0, 'sog_iqr_kn': 1.4, 'slow_time_fraction': 0.0, 'median_corridor_distance_km': 5.8}},
            ]
        }
        feat_file = Path(self.tmp.name) / 'sample_feats.json'
        with open(feat_file, 'w') as f:
            json.dump(sample_feats, f)

        cfg_file = Path(self.tmp.name) / 'config.json'
        with open(cfg_file, 'w') as f:
            json.dump({'model_id': 'test_model', 'area_id': 'bornholm', 'class_group': 'cargo'}, f)

        out_dir = Path(self.tmp.name) / 'model_out'

        # Attempt training without --synthetic-demo -> must fail due to <200 samples and <3 days
        cmd_fail = [
            sys.executable,
            str(ROOT / 'python/ml/train.py'),
            '--config', str(cfg_file),
            '--features', str(feat_file),
            '--output', str(out_dir)
        ]
        res_fail = subprocess.run(cmd_fail, capture_output=True, text=True)
        self.assertNotEqual(res_fail.returncode, 0)
        self.assertIn('Training validation failed', res_fail.stderr)

        # Attempt training with --synthetic-demo -> succeeds and marks is_synthetic_demo: True
        cmd_demo = cmd_fail + ['--synthetic-demo']
        res_demo = subprocess.run(cmd_demo, capture_output=True, text=True)
        self.assertEqual(res_demo.returncode, 0)
        with open(out_dir / 'manifest.json') as mf:
            mdata = json.load(mf)
            self.assertTrue(mdata.get('is_synthetic_demo'))
            self.assertIn('heldout_evaluation', mdata)


if __name__ == '__main__':
    unittest.main()
