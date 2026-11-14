#!/usr/bin/env python3
"""Unit tests for vessel track endpoint, conflicting same-time fixes, circular angles, and freshness."""
import datetime as dt
import importlib.util
import json
import sqlite3
import tempfile
import threading
import unittest
import urllib.request
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
DB_SCRIPT = ROOT / 'python/local_ais.py'

spec = importlib.util.spec_from_file_location('local_ais', DB_SCRIPT)
local_ais = importlib.util.module_from_spec(spec)
spec.loader.exec_module(local_ais)

def smallest_circular_diff(a: float, b: float) -> float:
    """Compute smallest angular difference between two compass bearings in degrees [0, 180]."""
    diff = abs(a - b) % 360
    return 360 - diff if diff > 180 else diff

class TrackAndFreshnessTest(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.db_path = Path(self.tmp.name) / 'track_test.sqlite'
        
        # Create test database with fixes
        conn = sqlite3.connect(str(self.db_path))
        conn.execute('CREATE TABLE fixes(ts TEXT NOT NULL, mmsi TEXT NOT NULL, lat REAL NOT NULL, lon REAL NOT NULL, sog REAL, cog REAL, hdg REAL, mobile TEXT, ship_type TEXT, name TEXT, nav TEXT, sog_q TEXT, cog_q TEXT, hdg_q TEXT)')
        conn.execute('CREATE INDEX fixes_time ON fixes(ts)')
        conn.execute('CREATE INDEX fixes_vessel ON fixes(mmsi, ts)')
        conn.execute('CREATE TABLE metadata(json TEXT NOT NULL)')
        meta = {
            'records': 7,
            'min_timestamp_utc': '2026-01-13T01:00:00Z',
            'max_timestamp_utc': '2026-01-13T01:30:00Z',
            'preprocessor_report': {
                'bbox_west_south_east_north': [10.8, 55.2, 11.3, 55.6],
                'truncated_by_row_limit': False
            }
        }
        conn.execute('INSERT INTO metadata VALUES (?)', (json.dumps(meta),))
        
        # Insert test records:
        # Vessel 111222333 has:
        # - Fix 1 at 01:00:00: sog 0.0 (stopped), cog 90.0, hdg 90.0
        # - Fix 2 at 01:10:00: sog None (missing!), cog None, hdg None (test null distinction)
        # - Fix 3 at 01:15:00: lat 55.30, lon 11.00, sog 3.2, cog 1.0, hdg 359.0 (small circular angle test!)
        # - Fix 4 at 01:15:00: lat 55.31, lon 11.02, sog 3.2, cog 1.0, hdg 359.0 (CONFLICTING same-time observation!)
        # - Fix 5 at 01:25:00: sog 3.5, cog 10.0, hdg 350.0 (another circular test: 20 deg)
        # - Fix 6 at 01:45:00: FUTURE fix after replay time 01:30:00
        records = [
            ('2026-01-13T01:00:00Z', '111222333', 55.25, 10.90, 0.0, 90.0, 90.0, 'Class A', 'Cargo', 'VESSEL_A', 'Under way', 'valid', 'valid', 'valid'),
            ('2026-01-13T01:10:00Z', '111222333', 55.28, 10.95, None, None, None, 'Class A', 'Cargo', 'VESSEL_A', 'Under way', 'missing', 'missing', 'missing'),
            ('2026-01-13T01:15:00Z', '111222333', 55.30, 11.00, 3.2, 1.0, 359.0, 'Class A', 'Cargo', 'VESSEL_A', 'Under way', 'valid', 'valid', 'valid'),
            ('2026-01-13T01:15:00Z', '111222333', 55.31, 11.02, 3.2, 1.0, 359.0, 'Class A', 'Cargo', 'VESSEL_A', 'Under way', 'valid', 'valid', 'valid'),
            ('2026-01-13T01:25:00Z', '111222333', 55.35, 11.10, 3.5, 10.0, 350.0, 'Class A', 'Cargo', 'VESSEL_A', 'Under way', 'valid', 'valid', 'valid'),
            ('2026-01-13T01:45:00Z', '111222333', 55.45, 11.20, 12.0, 45.0, 45.0, 'Class A', 'Cargo', 'VESSEL_A', 'Under way', 'valid', 'valid', 'valid'),
            # Vessel 999888777 (different vessel)
            ('2026-01-13T01:12:00Z', '999888777', 55.50, 11.15, 8.0, 180.0, 180.0, 'Class B', 'Tug', 'VESSEL_B', 'Under way', 'valid', 'valid', 'valid'),
        ]
        conn.executemany('INSERT INTO fixes VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)', records)
        conn.commit()
        conn.close()

        # Start test HTTP server
        self.server = local_ais.Server(('127.0.0.1', 0), str(self.db_path))
        self.thread = threading.Thread(target=self.server.serve_forever, daemon=True)
        self.thread.start()
        self.base_url = f'http://127.0.0.1:{self.server.server_port}'

    def tearDown(self):
        self.server.shutdown()
        self.server.server_close()
        self.thread.join()
        self.tmp.cleanup()

    def get(self, endpoint):
        req = urllib.request.Request(self.base_url + endpoint, headers={'Host': f'127.0.0.1:{self.server.server_port}'})
        with urllib.request.urlopen(req) as resp:
            return json.load(resp)

    def test_circular_angle_formula(self):
        # 359 deg vs 1 deg should be 2 deg, NOT 358 deg
        self.assertEqual(smallest_circular_diff(359.0, 1.0), 2.0)
        self.assertEqual(smallest_circular_diff(1.0, 359.0), 2.0)
        # 10 deg vs 350 deg should be 20 deg
        self.assertEqual(smallest_circular_diff(10.0, 350.0), 20.0)
        # 180 deg vs 0 deg should be 180 deg
        self.assertEqual(smallest_circular_diff(180.0, 0.0), 180.0)
        # 45 deg vs 45 deg should be 0 deg
        self.assertEqual(smallest_circular_diff(45.0, 45.0), 0.0)

    def test_track_endpoint_boundary_and_sorting(self):
        # Request track up to replay time 01:30:00Z with 60 min window
        data = self.get('/track?mmsi=111222333&at=2026-01-13T01%3A30%3A00Z&window=60')
        fixes = data['fixes']
        
        # 1. Replay boundary: future fix at 01:45:00Z MUST NOT be included!
        timestamps = [f['timestamp'] for f in fixes]
        self.assertNotIn('2026-01-13T01:45:00Z', timestamps)
        
        # 2. Strict chronological order (ts ASC, rowid ASC)
        self.assertEqual(timestamps, sorted(timestamps))
        
        # 3. Only target MMSI returned
        for f in fixes:
            self.assertEqual(f['mmsi'], '111222333')

    def test_missing_vs_zero_distinction(self):
        data = self.get('/track?mmsi=111222333&at=2026-01-13T01%3A30%3A00Z&window=60')
        fixes = data['fixes']
        
        # First fix has sog == 0.0 (stopped vessel)
        fix_0 = fixes[0]
        self.assertEqual(fix_0['timestamp'], '2026-01-13T01:00:00Z')
        self.assertIsNotNone(fix_0['sog'])
        self.assertEqual(fix_0['sog'], 0.0)
        
        # Second fix has missing sog (None / null in JSON)
        fix_1 = fixes[1]
        self.assertEqual(fix_1['timestamp'], '2026-01-13T01:10:00Z')
        self.assertIsNone(fix_1['sog'])
        self.assertIsNone(fix_1['heading'])
        self.assertIsNone(fix_1['cog'])

    def test_conflicting_same_time_fixes_preserved(self):
        data = self.get('/track?mmsi=111222333&at=2026-01-13T01%3A30%3A00Z&window=60')
        fixes = data['fixes']
        
        # Fixes at 01:15:00Z: exactly two fixes must be preserved with different coordinates
        same_time = [f for f in fixes if f['timestamp'] == '2026-01-13T01:15:00Z']
        self.assertEqual(len(same_time), 2)
        self.assertNotEqual(same_time[0]['lat'], same_time[1]['lat'])
        self.assertNotEqual(same_time[0]['rowid'], same_time[1]['rowid'])

    def test_reporting_gaps(self):
        data = self.get('/track?mmsi=111222333&at=2026-01-13T01%3A30%3A00Z&window=60')
        fixes = data['fixes']
        
        # Compute gap between fix 0 (01:00:00) and fix 1 (01:10:00): 600s
        t0 = dt.datetime.fromisoformat(fixes[0]['timestamp'].replace('Z', '+00:00'))
        t1 = dt.datetime.fromisoformat(fixes[1]['timestamp'].replace('Z', '+00:00'))
        gap_sec = (t1 - t0).total_seconds()
        self.assertEqual(gap_sec, 600.0)

if __name__ == '__main__':
    unittest.main()
