// Thin client for the local AIS service (`/api/local-ais/<endpoint>`).
//
// The production deployment talks to the Python service on 127.0.0.1:8765 through the Next.js proxy route.
// When that service is not reachable (e.g. this UI is opened as a static build) the same endpoints are answered
// from the small real-AIS sample datasets that ship with the repository (work/*.sqlite), using the same query
// semantics as python/local_ais.py. The UI is told which source is active so it can label it honestly.

import { useSyncExternalStore } from 'react';

type DemoRow = [
  string, // ts
  string, // mmsi
  number, // lat
  number, // lon
  number | null, // sog
  number | null, // cog
  number | null, // hdg
  number, // mobile (string idx)
  number, // ship_type
  number, // name
  number, // nav
  number, // sog_q
  number, // cog_q
  number, // hdg_q
  number // rowid
];

interface DemoFile {
  id: string;
  meta: Record<string, any>;
  strings: string[];
  rows: DemoRow[];
}

interface DemoDb {
  id: string; // e.g. baltic_sample.sqlite
  file: DemoFile;
}

const DEMO_LOADERS: Record<string, () => Promise<{ default: unknown }>> = {
  'baltic_sample.sqlite': () => import('@/data/baltic_sample.json'),
  'aisdk-2026-01-13_storebaelt_100k.sqlite': () => import('@/data/aisdk-2026-01-13_storebaelt_100k.json'),
  'sample.sqlite': () => import('@/data/sample.json'),
};
const DEMO_ORDER = Object.keys(DEMO_LOADERS);
const DEMO_DEFAULT = 'baltic_sample.sqlite';

const cache = new Map<string, DemoDb>();
let activeDemo = DEMO_DEFAULT;

async function loadDemo(id: string): Promise<DemoDb> {
  const hit = cache.get(id);
  if (hit) return hit;
  const loader = DEMO_LOADERS[id];
  if (!loader) throw new Error('Database file does not exist: ' + id);
  const mod = await loader();
  const file = mod.default as DemoFile;
  const db = { id, file };
  cache.set(id, db);
  return db;
}

// ---- source state (live service vs bundled sample) ------------------------------------------------------------
export type Source = 'probing' | 'live' | 'sample';
let source: Source = 'probing';
const listeners = new Set<() => void>();
function setSource(s: Source) {
  if (source === s) return;
  source = s;
  listeners.forEach((l) => l());
}
export function useSource(): Source {
  return useSyncExternalStore(
    (cb) => {
      listeners.add(cb);
      return () => listeners.delete(cb);
    },
    () => source,
    () => 'probing'
  );
}
/** Forget the "service unavailable" decision so the next request probes the live service again. */
export function reconnectLive() {
  setSource('probing');
}

// ---- response shim ----------------------------------------------------------------------------------------------
export interface ApiResponse {
  ok: boolean;
  status: number;
  json: () => Promise<any>;
}

function reply(status: number, body: unknown): ApiResponse {
  return { ok: status >= 200 && status < 300, status, json: async () => body };
}

const TS_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/;
const isoMinus = (t: string, minutes: number) => new Date(Date.parse(t) - minutes * 60000).toISOString().replace('.000Z', 'Z');

const SNAP_NAMES = ['timestamp', 'mmsi', 'lat', 'lon', 'sog', 'cog', 'heading', 'mobile_type', 'ship_type', 'name', 'navigational_status', 'sog_quality', 'cog_quality', 'heading_quality'];

function rowToObj(db: DemoDb, r: DemoRow, withRowId: boolean) {
  const s = db.file.strings;
  const o: Record<string, unknown> = {
    timestamp: r[0],
    mmsi: r[1],
    lat: r[2],
    lon: r[3],
    sog: r[4],
    cog: r[5],
    heading: r[6],
    mobile_type: s[r[7]],
    ship_type: s[r[8]],
    name: s[r[9]],
    navigational_status: s[r[10]],
    sog_quality: s[r[11]],
    cog_quality: s[r[12]],
    heading_quality: s[r[13]],
  };
  if (withRowId) o.rowid = r[14];
  return o;
}

/** Binary search: first index whose ts > t (rows are ordered by ts, then rowid). */
function upperBound(rows: DemoRow[], t: string) {
  let lo = 0;
  let hi = rows.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (rows[mid][0] <= t) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

const sortedCache = new Map<string, DemoRow[]>();
function sortedRows(db: DemoDb): DemoRow[] {
  let r = sortedCache.get(db.id);
  if (!r) {
    r = [...db.file.rows].sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : a[14] - b[14]));
    sortedCache.set(db.id, r);
  }
  return r;
}

async function demoGet(endpoint: string, query: URLSearchParams): Promise<ApiResponse> {
  try {
    if (endpoint === 'find-zips') return reply(200, { zips: [] });

    if (endpoint === 'datasets') {
      const list = await Promise.all(
        DEMO_ORDER.map(async (id) => {
          const db = await loadDemo(id);
          const m = db.file.meta;
          return {
            id,
            path: `work/${id}`,
            records: m.records ?? 0,
            min_timestamp_utc: m.min_timestamp_utc ?? '',
            max_timestamp_utc: m.max_timestamp_utc ?? '',
            input_file: m.preprocessor_report?.input_file ?? '',
            bbox: m.preprocessor_report?.bbox_west_south_east_north ?? [],
            active: id === activeDemo,
          };
        })
      );
      return reply(200, { datasets: list, active_db: `work/${activeDemo}` });
    }

    if (endpoint === 'switch') {
      const target = query.get('db') || '';
      if (!target) throw new Error('db parameter is required');
      const db = await loadDemo(target);
      activeDemo = target;
      return reply(200, { ok: true, active_db: `work/${target}`, meta: db.file.meta });
    }

    const db = await loadDemo(activeDemo);

    if (endpoint === 'meta') return reply(200, db.file.meta);

    if (endpoint === 'ml-score') {
      return reply(200, {
        status: 'model_unavailable',
        mode: 'shadow_experimental',
        mmsi: query.get('mmsi') || '',
        as_of: query.get('at') || '',
        reason:
          'Historical pattern comparison is computed by the local Python service (models/v1). It is not available while the interface is showing the bundled sample data.',
      });
    }

    const t = query.get('at') || '';
    const mins = Number(query.get('window') ?? (endpoint === 'track' ? '120' : '60'));
    if (!TS_RE.test(t) || !(mins >= 1 && mins <= 1440)) {
      throw new Error('at must be YYYY-MM-DDTHH:MM:SSZ; window must be 1..1440 minutes');
    }
    const start = isoMinus(t, mins);
    const rows = sortedRows(db);
    const hi = upperBound(rows, t); // rows[0..hi) have ts <= t

    if (endpoint === 'track') {
      const mmsi = query.get('mmsi') || '';
      if (!/^[0-9]{9}$/.test(mmsi)) throw new Error('mmsi must be a 9-digit string');
      const lim = Math.max(1, Math.min(Number(query.get('limit') ?? '5000'), 20000));
      const picked: DemoRow[] = [];
      let truncated = false;
      for (let i = hi - 1; i >= 0; i--) {
        const r = rows[i];
        if (r[0] < start) break;
        if (r[1] !== mmsi) continue;
        if (picked.length >= lim) {
          truncated = true;
          break;
        }
        picked.push(r);
      }
      picked.reverse();
      return reply(200, {
        mmsi,
        as_of: t,
        window_minutes: mins,
        fixes_count: picked.length,
        truncated,
        limit: lim,
        fixes: picked.map((r) => rowToObj(db, r, true)),
      });
    }

    if (endpoint === 'snapshot') {
      const found = new Map<string, DemoRow>();
      let scanned = 0;
      let truncated = false;
      for (let i = hi - 1; i >= 0; i--) {
        const r = rows[i];
        if (r[0] < start) break;
        scanned++;
        if (scanned > 75000) {
          truncated = true;
          break;
        }
        if (!found.has(r[1])) {
          if (found.size >= 500) {
            truncated = true;
            break;
          }
          found.set(r[1], r);
        }
      }
      return reply(200, {
        as_of: t,
        window_minutes: mins,
        records_scanned: Math.min(scanned, 75000),
        truncated,
        limits: { max_rows_scanned: 75000, max_vessels: 500 },
        vessels: [...found.values()].map((r) => {
          const o = rowToObj(db, r, false);
          // keep exactly the snapshot field order of the service
          return Object.fromEntries(SNAP_NAMES.map((k) => [k, o[k]]));
        }),
        warning:
          'Latest visible point per MMSI within window; missing vessels are unknown, not absent. No live availability established.',
      });
    }

    return reply(404, { error: 'Not found' });
  } catch (e) {
    return reply(400, { error: e instanceof Error ? e.message : String(e) });
  }
}

function demoPost(endpoint: string): ApiResponse {
  if (endpoint === 'ingest') {
    return reply(503, {
      error: 'Ingestion failed',
      details:
        'The ingestion pipeline (python/pipeline.py) runs on the local machine and is not available while the interface is showing the bundled sample data. Start ./run.sh to ingest AIS archives.',
    });
  }
  return reply(404, { error: 'Endpoint not allowed' });
}

// ---- public entry point --------------------------------------------------------------------------------------------
/** Same call shape the original page used: `localAis('snapshot?at=...&window=60')`. */
export async function localAis(path: string, init?: RequestInit): Promise<ApiResponse> {
  const [endpoint, qs = ''] = path.split('?');
  const method = (init?.method || 'GET').toUpperCase();

  if (source !== 'sample') {
    try {
      const res = await fetch(`/api/local-ais/${path}`, init);
      const type = res.headers.get('content-type') || '';
      const unavailable = res.status === 404 || res.status === 502 || res.status === 504 || !type.includes('json');
      if (!unavailable) {
        // 503 from the Next.js proxy = Python service down (JSON body). Fall back for GETs.
        if (res.status === 503 && method === 'GET') {
          setSource('sample');
        } else {
          setSource('live');
          return { ok: res.ok, status: res.status, json: () => res.json() };
        }
      } else {
        setSource('sample');
      }
    } catch {
      setSource('sample');
    }
  }

  if (method === 'POST') return demoPost(endpoint);
  return demoGet(endpoint, new URLSearchParams(qs));
}
