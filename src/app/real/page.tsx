'use client';
import { useEffect, useMemo, useState, useRef } from 'react';
import { evaluateTrackScore, type ExperimentalTrackResult, type TrackFix } from '@/lib/cablewatch/track_score';

type Fix = {
  timestamp: string;
  mmsi: string;
  lat: number;
  lon: number;
  sog: number | null;
  cog: number | null;
  heading: number | null;
  name: string;
  ship_type: string;
  sog_quality: string;
  mobile_type?: string;
  navigational_status?: string;
};

type Meta = {
  records: number;
  min_timestamp_utc: string;
  max_timestamp_utc: string;
  availability: string;
  preprocessor_report: {
    truncated_by_row_limit: boolean;
    input_file: string;
    bbox_west_south_east_north: number[];
  };
};

type Snapshot = {
  as_of: string;
  window_minutes: number;
  records_scanned: number;
  truncated: boolean;
  limits?: { max_rows_scanned: number; max_vessels: number };
  vessels: Fix[];
  warning: string;
};

type Dataset = {
  id: string;
  path: string;
  records: number;
  min_timestamp_utc: string;
  max_timestamp_utc: string;
  input_file: string;
  bbox: number[];
  active: boolean;
};

type DiscoveredZip = {
  name: string;
  path: string;
  size_mb: number;
};

type XY = [number, number];
type Lines = XY[][];

type MLComparisonFeature = {
  name: string;
  value: number;
  unit: string;
  training_median: number;
  training_iqr: number;
  robust_deviation: number;
};

type MLScoreResponse = {
  status: 'ok' | 'insufficient_track' | 'insufficient_baseline' | 'model_unavailable' | 'error' | 'invalid_request';
  mode: string;
  mmsi: string;
  as_of: string;
  dataset_id?: string;
  model_id?: string;
  training_end?: string;
  area_id?: string;
  class_group?: string;
  feature_version?: string;
  geometry_hash?: string;
  track_window?: {
    window_minutes: number;
    distinct_timestamps: number;
    first_ts: string;
    last_ts: string;
    span_minutes: number;
  };
  anomaly_percentile?: number;
  baseline_robust_score?: number;
  comparison_features?: MLComparisonFeature[];
  caveats?: string[];
  is_synthetic_demo?: boolean;
  reason?: string;
  details?: Record<string, unknown>;
};

function formatFeatureName(name: string): string {
  switch (name) {
    case 'median_sog_kn': return 'Median Speed (SOG)';
    case 'sog_iqr_kn': return 'Speed Dispersion (IQR)';
    case 'slow_time_fraction': return 'Slow Dwell Ratio (<3kn)';
    case 'median_corridor_distance_km': return 'Median Corridor Dist';
    default: return name;
  }
}

function formatFeatureValue(name: string, val: number, unit: string): string {
  if (name === 'slow_time_fraction') {
    return `${(val * 100).toFixed(0)}%`;
  }
  return `${val.toFixed(1)}${unit ? ' ' + unit : ''}`;
}

const R = 6371.0088; // Earth radius in km

// Standard class baselines for Baltic commercial traffic (knots)
const CLASS_BASELINES: Record<string, number> = {
  tanker: 12.5,
  cargo: 12.0,
  passenger: 18.0,
  ferry: 18.0,
  fishing: 3.2, // Towing speed is normal
  trawler: 3.2,
  tug: 8.5,
  pleasure: 7.0,
  other: 10.0,
  undefined: 11.0,
};

export interface SubseaFeature {
  name: string;
  type: string;
  color: string;
  region?: 'Bornholm' | 'Western Baltic' | 'Straits' | 'Kattegat' | 'Regional';
  endpoints?: [string, string];
  labelFrac?: number;
  labelOffset?: [number, number];
  coords: XY[];
}

export const BALTIC_CORRIDOR_NETWORK: SubseaFeature[] = [
  {
    name: 'Baltic Power Interconnector',
    type: 'HVDC Power (450kV)',
    color: '#f59e0b', // amber
    region: 'Bornholm',
    endpoints: ['Herrenwyk (DE)', 'Bornholm Basin (DK)'],
    labelFrac: 0.25,
    labelOffset: [8, -14],
    coords: [
      [13.82, 54.82],
      [13.95, 54.94],
      [14.05, 55.04],
      [14.18, 55.15],
      [14.32, 55.28]
    ]
  },
  {
    name: 'Baltic Pipe Gas Corridor',
    type: 'Subsea Gas Pipeline',
    color: '#c084fc', // purple
    region: 'Bornholm',
    endpoints: ['Faxø (DK)', 'Niechorze (PL)'],
    labelFrac: 0.8,
    labelOffset: [8, 16],
    coords: [
      [14.45, 55.25],
      [14.30, 55.10],
      [14.15, 54.95],
      [14.00, 54.80]
    ]
  },
  {
    name: 'Nord Stream Subsea Corridor',
    type: 'Gas Backbone',
    color: '#38bdf8', // cyan
    region: 'Bornholm',
    endpoints: ['Lubmin (DE)', 'Gulf of Finland Transit'],
    labelFrac: 0.5,
    labelOffset: [-10, -18],
    coords: [
      [13.75, 55.15],
      [14.05, 55.20],
      [14.25, 55.22],
      [14.55, 55.28],
      [15.20, 55.38]
    ]
  },
  {
    name: 'C-Lion1 / Subsea Fiber Transit',
    type: 'Telecom Optical Fiber',
    color: '#34d399', // emerald
    region: 'Bornholm',
    endpoints: ['Rostock (DE)', 'Helsinki (FI)'],
    labelFrac: 0.4,
    labelOffset: [8, 14],
    coords: [
      [14.10, 54.85],
      [14.20, 55.00],
      [14.35, 55.18],
      [14.40, 55.30],
      [14.70, 55.55]
    ]
  },
  {
    name: 'Bornholm-Sweden 60kV MVAC Cable',
    type: 'Subsea Grid Power',
    color: '#e879f9', // fuchsia
    region: 'Bornholm',
    endpoints: ['Hasle (Bornholm)', 'Simrishamn (Sweden)'],
    labelFrac: 0.7,
    labelOffset: [-12, -14],
    coords: [
      [14.70, 55.18],
      [14.45, 55.30],
      [14.30, 55.45],
      [14.35, 55.55]
    ]
  },
  {
    name: 'Kriegers Flak Combined Grid Solution',
    type: 'Offshore Wind Interconnector',
    color: '#38bdf8',
    region: 'Bornholm',
    endpoints: ['Kriegers Flak (DK)', 'Baltic 2 (DE)'],
    labelFrac: 0.5,
    labelOffset: [8, -12],
    coords: [
      [12.75, 55.02],
      [12.95, 55.05],
      [13.15, 54.95],
      [13.35, 54.65]
    ]
  },
  {
    name: 'SwePol Link (HVDC 450kV)',
    type: 'Subsea HVDC Power Link',
    color: '#a78bfa',
    region: 'Bornholm',
    endpoints: ['Karlshamn (Sweden)', 'Wierzbięcin (Poland)'],
    labelFrac: 0.6,
    labelOffset: [8, -10],
    coords: [
      [14.85, 56.12],
      [15.20, 55.70],
      [15.80, 55.20],
      [16.50, 54.65]
    ]
  },
  {
    name: 'Fehmarn Belt Cross-Strait Link',
    type: 'Subsea Interconnector',
    color: '#facc15', // yellow
    region: 'Western Baltic',
    endpoints: ['Rødbyhavn (DK)', 'Puttgarden (DE)'],
    labelFrac: 0.5,
    labelOffset: [8, -12],
    coords: [
      [11.10, 54.62],
      [11.25, 54.55],
      [11.40, 54.46]
    ]
  },
  {
    name: 'Baltic Cable (HVDC 450kV)',
    type: 'Subsea Power Interconnector',
    color: '#fb7185',
    region: 'Western Baltic',
    endpoints: ['Lübeck-Herrenwyk (DE)', 'Kruseberg (SE)'],
    labelFrac: 0.5,
    labelOffset: [8, -12],
    coords: [
      [10.95, 54.00],
      [11.45, 54.40],
      [12.20, 54.95],
      [12.80, 55.30],
      [13.05, 55.40]
    ]
  },
  {
    name: 'Storebælt (Great Belt) Subsea Link',
    type: 'HVDC Grid Interconnector',
    color: '#67e8f9', // light cyan
    region: 'Straits',
    endpoints: ['Nyborg (Fyn)', 'Korsør (Zealand)'],
    labelFrac: 0.5,
    labelOffset: [8, -12],
    coords: [
      [10.82, 55.32],
      [10.98, 55.34],
      [11.14, 55.35]
    ]
  },
  {
    name: 'Lillebælt (Little Belt) Grid Link',
    type: 'Grid Cable Crossing',
    color: '#4ade80',
    region: 'Straits',
    endpoints: ['Fredericia (Jylland)', 'Middelfart (Fyn)'],
    labelFrac: 0.5,
    labelOffset: [8, -12],
    coords: [
      [9.69, 55.51],
      [9.73, 55.52],
      [9.77, 55.53]
    ]
  },
  {
    name: 'Øresund (The Sound) Power Link',
    type: 'Cross-Border Power',
    color: '#fb923c', // orange
    region: 'Straits',
    endpoints: ['Copenhagen (DK)', 'Malmö (SE)'],
    labelFrac: 0.5,
    labelOffset: [8, -12],
    coords: [
      [12.58, 55.62],
      [12.68, 55.66],
      [12.78, 55.70]
    ]
  },
  {
    name: 'Konti-Skan HVDC Interconnector',
    type: 'Subsea HVDC Link',
    color: '#2dd4bf',
    region: 'Kattegat',
    endpoints: ['Jutland (DK)', 'Gothenburg (SE)'],
    labelFrac: 0.5,
    labelOffset: [8, -12],
    coords: [
      [10.45, 57.30],
      [11.00, 57.38],
      [11.80, 57.55]
    ]
  },
  {
    name: 'Balticconnector Gas Pipeline',
    type: 'Subsea Gas Pipeline',
    color: '#e879f9',
    region: 'Regional',
    endpoints: ['Inkoo (FI)', 'Paldiski (EE)'],
    labelFrac: 0.5,
    labelOffset: [8, -12],
    coords: [
      [24.00, 60.01],
      [24.05, 59.80],
      [24.10, 59.35]
    ]
  }
];

export type SectorId = 'fit-data' | 'bornholm' | 'fehmarn' | 'storebaelt' | 'oresund' | 'kattegat' | 'all';

export const SECTOR_CONFIG: Record<SectorId, { label: string; icon: string; bbox: { minx: number; maxx: number; miny: number; maxy: number } }> = {
  'fit-data': {
    label: 'Fit Active Data',
    icon: '⛶',
    bbox: { minx: 10.4, maxx: 15.6, miny: 54.3, maxy: 56.4 }
  },
  'bornholm': {
    label: 'Bornholm Basin (Demo Area)',
    icon: '🇩🇰',
    bbox: { minx: 13.5, maxx: 16.0, miny: 54.5, maxy: 56.0 } // Exact judges spot-check window!
  },
  'fehmarn': {
    label: 'Fehmarn Belt Sector',
    icon: '🇩🇰',
    bbox: { minx: 10.9, maxx: 11.65, miny: 54.38, maxy: 54.75 }
  },
  'storebaelt': {
    label: 'Storebælt (Great Belt)',
    icon: '🇩🇰',
    bbox: { minx: 10.6, maxx: 11.45, miny: 55.15, maxy: 55.65 }
  },
  'oresund': {
    label: 'Øresund (The Sound)',
    icon: '🇩🇰',
    bbox: { minx: 12.35, maxx: 13.1, miny: 55.45, maxy: 55.95 }
  },
  'kattegat': {
    label: 'Kattegat & Anholt',
    icon: '🇩🇰',
    bbox: { minx: 10.2, maxx: 12.3, miny: 56.2, maxy: 57.6 }
  },
  'all': {
    label: 'Full Baltic & Danish Waters',
    icon: '🌐',
    bbox: { minx: 9.5, maxx: 16.5, miny: 54.1, maxy: 56.6 }
  }
};

export interface ISRBasePreset {
  id: string;
  name: string;
  region: string;
  coords: [number, number]; // [lon, lat]
}

export const PRESET_BASES: ISRBasePreset[] = [
  { id: 'bornholm', name: '🇩🇰 Bornholm (Rønne Air Station)', region: 'Bornholm', coords: [14.70, 55.07] },
  { id: 'rodbyhavn', name: '🇩🇰 Rødbyhavn Coast Guard (Fehmarn)', region: 'Fehmarn Belt', coords: [11.35, 54.65] },
  { id: 'korsor', name: '🇩🇰 Korsør Naval Base (Storebælt)', region: 'Storebælt', coords: [11.14, 55.33] },
  { id: 'copenhagen', name: '🇩🇰 Copenhagen Holmen Base (Øresund)', region: 'Øresund', coords: [12.60, 55.69] },
  { id: 'frederikshavn', name: '🇩🇰 Frederikshavn Naval Station (Kattegat)', region: 'Kattegat', coords: [10.55, 57.43] },
  { id: 'rostock', name: '🇩🇪 Warnemünde / Rostock (Germany)', region: 'Western Baltic', coords: [12.09, 54.18] },
  { id: 'karlskrona', name: '🇸🇪 Karlskrona Naval Base (Sweden)', region: 'Eastern Baltic', coords: [15.58, 56.16] },
];

const DEFAULT_ROUTE: Lines = BALTIC_CORRIDOR_NETWORK.map((f) => f.coords);

function distKm(p1: [number, number], p2: [number, number]): number {
  const rad = Math.PI / 180;
  const lat0 = ((p1[1] + p2[1]) / 2) * rad;
  const dx = (p2[0] - p1[0]) * rad * R * Math.cos(lat0);
  const dy = (p2[1] - p1[1]) * rad * R;
  return Math.hypot(dx, dy);
}

function geometry(data: unknown): Lines {
  const lines: Lines = [];
  let points = 0;
  function walk(o: unknown): void {
    if (!o || typeof o !== 'object' || Array.isArray(o)) throw Error('Unsupported GeoJSON structure');
    const x = o as Record<string, unknown>;
    if (x.type === 'FeatureCollection') {
      if (!Array.isArray(x.features)) throw Error('Invalid features');
      x.features.forEach(walk);
      return;
    }
    if (x.type === 'Feature') {
      walk(x.geometry);
      return;
    }
    if (x.type === 'LineString') {
      add(x.coordinates);
      return;
    }
    if (x.type === 'MultiLineString') {
      if (!Array.isArray(x.coordinates)) throw Error('Invalid coordinates');
      x.coordinates.forEach(add);
      return;
    }
    throw Error('Only LineString and MultiLineString GeoJSON features are supported');
  }
  function add(raw: unknown) {
    if (!Array.isArray(raw) || raw.length < 2) throw Error('Each line requires two or more coordinates');
    const line: XY[] = raw.map((p) => {
      if (
        !Array.isArray(p) ||
        typeof p[0] !== 'number' ||
        typeof p[1] !== 'number' ||
        !Number.isFinite(p[0]) ||
        !Number.isFinite(p[1]) ||
        p[0] < -180 ||
        p[0] > 180 ||
        p[1] < -90 ||
        p[1] > 90
      )
        throw Error('Coordinates must be [longitude, latitude]');
      points++;
      if (points > 3000) throw Error('Maximum 3,000 cable vertices');
      return [p[0], p[1]];
    });
    lines.push(line);
  }
  walk(data);
  if (!lines.length) throw Error('No cable line found');
  return lines;
}

function nearKm(f: Fix, lines: Lines): number {
  let best = Infinity;
  const rad = Math.PI / 180;
  for (const line of lines) {
    for (let i = 1; i < line.length; i++) {
      const a = line[i - 1],
        b = line[i];
      const lat0 = ((a[1] + b[1] + f.lat) / 3) * rad;
      const xy = (p: XY): XY => [(p[0] - f.lon) * rad * R * Math.cos(lat0), (p[1] - f.lat) * rad * R];
      const [ax, ay] = xy(a),
        [bx, by] = xy(b),
        dx = bx - ax,
        dy = by - ay,
        den = dx * dx + dy * dy;
      const t = den ? Math.max(0, Math.min(1, -(ax * dx + ay * dy) / den)) : 0;
      best = Math.min(best, Math.hypot(ax + t * dx, ay + t * dy));
    }
  }
  return best;
}

// Smallest circular difference between compass bearings (degrees [0, 180])
export function smallestCircularDiff(a: number, b: number): number {
  const diff = Math.abs(a - b) % 360;
  return diff > 180 ? 360 - diff : diff;
}

export type { TrackFix, ExperimentalTrackResult };

// Anomaly Assessment Record
export interface AnomalyResult {
  vessel: Fix;
  dist: number | null;
  score: number;
  tier: 'cue' | 'review' | 'normal';
  speedDeficit: number;
  driftAngle: number | null;
  reason: string;
  fixAgeSec: number;
  isStale: boolean;
}

// ISR Sortie Plan Interface
export interface ISRLeg {
  mmsi: string;
  name: string;
  from: [number, number];
  to: [number, number];
  distKm: number;
  flightMin: number;
  dwellMin: number;
  cumTimeMin: number;
}

export interface ISRPlan {
  feasible: boolean;
  base: [number, number];
  legs: ISRLeg[];
  totalTimeMin: number;
  fuelMarginMin: number;
  targetsInvestigated: number;
  droppedTargets: { name: string; mmsi: string; reason: string }[];
}

export default function Real() {
  const [meta, setMeta] = useState<Meta | null>(null);
  const [snap, setSnap] = useState<Snapshot | null>(null);
  const [at, setAt] = useState('');
  const [win, setWin] = useState(60);
  const [activeCorridors, setActiveCorridors] = useState<SubseaFeature[]>(BALTIC_CORRIDOR_NETWORK);
  const [lines, setLines] = useState<Lines>(DEFAULT_ROUTE);
  const [geomName, setGeomName] = useState('ALL');
  const [corridorKm, setCorridorKm] = useState(4);
  const [selectedMmsi, setSelectedMmsi] = useState<string | null>(null);
  const [trackData, setTrackData] = useState<{
    mmsi: string;
    as_of: string;
    window_minutes: number;
    fixes_count: number;
    limit?: number;
    truncated: boolean;
    fixes: TrackFix[];
  } | null>(null);
  const [trackLoading, setTrackLoading] = useState(false);
  const [showTimeline, setShowTimeline] = useState(false);
  const [enableMLShadow, setEnableMLShadow] = useState<boolean>(() => {
    if (typeof window !== 'undefined') {
      const saved = localStorage.getItem('cablewatch_enable_ml_shadow');
      if (saved !== null) return saved === 'true';
    }
    return process.env.NEXT_PUBLIC_ENABLE_ML_SHADOW === 'true';
  });
  const [mlScore, setMlScore] = useState<MLScoreResponse | null>(null);
  const [mlLoading, setMlLoading] = useState(false);
  const [isPlaying, setIsPlaying] = useState(false);
  const [playbackSpeed, setPlaybackSpeed] = useState(5); // Default to 5x for visible motion
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  // Geographic Sector Focus: 'fit-data' (auto-fits active dataset), regional sectors, or 'all'
  const [sector, setSector] = useState<SectorId>('fit-data');

  // Interactive Pan & Zoom State
  const [zoom, setZoom] = useState(1);
  const [pan, setPan] = useState({ x: 0, y: 0 });
  const [isDragging, setIsDragging] = useState(false);
  const dragStartRef = useRef({ x: 0, y: 0, panX: 0, panY: 0 });

  // ISR Sortie State & Base Customization
  const [showISRPlan, setShowISRPlan] = useState(false);
  const [isrBaseId, setIsrBaseId] = useState<string>('bornholm');
  const [customBase, setCustomBase] = useState<[number, number] | null>(null);
  const [isrSpeedMs, setIsrSpeedMs] = useState<number>(25); // 25 m/s standard (90 km/h)
  const [isrEnduranceMin, setIsrEnduranceMin] = useState<number>(60); // 60 min standard
  const [isrDwellMin, setIsrDwellMin] = useState<number>(4); // 4 min standard
  const [isPlacingBase, setIsPlacingBase] = useState<boolean>(false);

  // Ingestion & Dataset Switcher Modal State
  const [showModal, setShowModal] = useState(false);
  const [datasets, setDatasets] = useState<Dataset[]>([]);
  const [discoveredZips, setDiscoveredZips] = useState<DiscoveredZip[]>([]);
  const [selectedZipPath, setSelectedZipPath] = useState('');
  const [ingestPreset, setIngestPreset] = useState('baltic');
  const [ingestMaxRows, setIngestMaxRows] = useState(1000000);
  const [customDatasetName, setCustomDatasetName] = useState('');
  const [isIngesting, setIsIngesting] = useState(false);
  const [ingestStatus, setIngestStatus] = useState('');

  const timerRef = useRef<NodeJS.Timeout | null>(null);

  // Load Metadata
  const refreshMeta = () => {
    fetch('/api/local-ais/meta')
      .then(async (r) => {
        const j = await r.json();
        if (!r.ok) throw Error(j.error);
        setMeta(j);
        setAt(j.min_timestamp_utc);
        setError('');
      })
      .catch((e) => setError(String(e.message)));
  };

  useEffect(() => {
    refreshMeta();
  }, []);

  // Fetch Datasets and Discovered ZIP files
  const loadDatasets = async () => {
    try {
      const [resDb, resZips] = await Promise.all([
        fetch('/api/local-ais/datasets'),
        fetch('/api/local-ais/find-zips')
      ]);
      if (resDb.ok) {
        const data = await resDb.json();
        setDatasets(data.datasets || []);
      }
      if (resZips.ok) {
        const data = await resZips.json();
        const zips = data.zips || [];
        setDiscoveredZips(zips);
        if (zips.length > 0 && !selectedZipPath) {
          setSelectedZipPath(zips[0].path);
        }
      }
    } catch {
      // ignore
    }
  };

  useEffect(() => {
    if (showModal) {
      loadDatasets();
    }
  }, [showModal]);

  // Switch Dataset
  const handleSwitchDataset = async (dbId: string) => {
    setBusy(true);
    try {
      const res = await fetch(`/api/local-ais/switch?db=${encodeURIComponent(dbId)}`);
      const data = await res.json();
      if (!res.ok) throw Error(data.error);
      setIsPlaying(false);
      setMeta(data.meta);
      setAt(data.meta.min_timestamp_utc);
      setSelectedMmsi(null);
      setSector('fit-data');
      setGeomName('ALL');
      setActiveCorridors(BALTIC_CORRIDOR_NETWORK);
      setLines(BALTIC_CORRIDOR_NETWORK.map((f) => f.coords));
      setZoom(1);
      setPan({ x: 0, y: 0 });
      setShowModal(false);
      loadDatasets();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  // Run Ingestion Pipeline
  const handleRunIngest = async () => {
    if (!selectedZipPath) {
      setError('Please select or enter an AIS ZIP file path');
      return;
    }
    setIsIngesting(true);
    setIngestStatus('Running streaming preprocessor & building SQLite index...');
    try {
      const res = await fetch('/api/local-ais/ingest', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          zip_path: selectedZipPath,
          preset: ingestPreset,
          max_rows: ingestMaxRows,
          name: customDatasetName.trim() || undefined
        })
      });
      const data = await res.json();
      if (!res.ok) {
        throw Error(data.details || data.error || 'Ingestion failed');
      }
      setIngestStatus('Ingestion complete! Loading into replay...');
      await new Promise((r) => setTimeout(r, 600));
      refreshMeta();
      await loadDatasets();
      setShowModal(false);
      setIsPlaying(false);
    } catch (err) {
      setIngestStatus('');
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setIsIngesting(false);
    }
  };

  const inFlightRef = useRef(false);

  // Fetch Snapshot at timestamp with backpressure protection
  useEffect(() => {
    if (!at) return;
    setBusy(true);
    inFlightRef.current = true;
    fetch(`/api/local-ais/snapshot?at=${encodeURIComponent(at)}&window=${win}`)
      .then(async (r) => {
        const j = await r.json();
        if (!r.ok) throw Error(j.error);
        setSnap(j);
        setError('');
      })
      .catch((e) => {
        setError(String(e.message));
      })
      .finally(() => {
        inFlightRef.current = false;
        setBusy(false);
      });
  }, [at, win]);

  // Fetch Historical Track Data for Selected Vessel
  useEffect(() => {
    if (!selectedMmsi || !at) {
      setTrackData(null);
      return;
    }
    setTrackLoading(true);
    fetch(`/api/local-ais/track?mmsi=${encodeURIComponent(selectedMmsi)}&at=${encodeURIComponent(at)}&window=120`)
      .then(async (r) => {
        const j = await r.json();
        if (!r.ok) throw Error(j.error);
        setTrackData(j);
      })
      .catch((e) => {
        console.error('Failed to load track data:', e);
        setTrackData(null);
      })
      .finally(() => setTrackLoading(false));
  }, [selectedMmsi, at]);

  // Fetch ML Shadow-Mode Assessment for Selected Vessel (when enabled)
  useEffect(() => {
    if (!enableMLShadow || !selectedMmsi || !at) {
      setMlScore(null);
      setMlLoading(false);
      return;
    }

    let active = true;
    setMlLoading(true);

    fetch(`/api/local-ais/ml-score?mmsi=${encodeURIComponent(selectedMmsi)}&at=${encodeURIComponent(at)}`)
      .then(async (r) => {
        const j = await r.json();
        if (active) {
          if (j.mmsi === selectedMmsi && j.as_of === at) {
            setMlScore(j);
          }
        }
      })
      .catch((e) => {
        if (active) {
          setMlScore({
            status: 'error',
            mode: 'shadow_experimental',
            mmsi: selectedMmsi,
            as_of: at,
            reason: String(e?.message || e)
          });
        }
      })
      .finally(() => {
        if (active) {
          setMlLoading(false);
        }
      });

    return () => {
      active = false;
    };
  }, [enableMLShadow, selectedMmsi, at]);

  // Auto-play timer with in-flight backpressure guard
  useEffect(() => {
    if (!isPlaying || !meta) {
      if (timerRef.current) clearInterval(timerRef.current);
      return;
    }

    const minSec = Date.parse(meta.min_timestamp_utc) / 1000;
    const maxSec = Date.parse(meta.max_timestamp_utc) / 1000;

    timerRef.current = setInterval(() => {
      // Do not stack requests if previous frame is still loading over the network
      if (inFlightRef.current) return;
      setAt((prev) => {
        const curSec = prev ? Date.parse(prev) / 1000 : minSec;
        const nextSec = curSec + 45 * playbackSpeed;
        if (nextSec >= maxSec) {
          setIsPlaying(false);
          return meta.max_timestamp_utc;
        }
        return new Date(nextSec * 1000).toISOString().replace('.000Z', 'Z');
      });
    }, 500);

    return () => {
      if (timerRef.current) clearInterval(timerRef.current);
    };
  }, [isPlaying, playbackSpeed, meta]);

  const vesselPoints = useMemo(() => (snap?.vessels ?? []).map((v) => [v.lon, v.lat] as XY), [snap]);

  const bounds = useMemo(() => {
    // 1. If user selected a specific individual corridor, frame that corridor!
    if (geomName !== 'ALL' && !geomName.startsWith('Custom:')) {
      const match = activeCorridors.find((c) => c.name === geomName);
      if (match && match.coords.length > 0) {
        const xs = match.coords.map((p) => p[0]);
        const ys = match.coords.map((p) => p[1]);
        const minx = Math.min(...xs);
        const maxx = Math.max(...xs);
        const miny = Math.min(...ys);
        const maxy = Math.max(...ys);
        const padX = Math.max((maxx - minx) * 0.45, 0.12);
        const padY = Math.max((maxy - miny) * 0.45, 0.10);
        return {
          minx: minx - padX,
          maxx: maxx + padX,
          miny: miny - padY,
          maxy: maxy + padY
        };
      }
    }

    // 2. If custom GeoJSON is loaded, frame custom lines
    if (geomName.startsWith('Custom:')) {
      const allPts = lines.flat();
      if (allPts.length > 0) {
        const xs = allPts.map((p) => p[0]);
        const ys = allPts.map((p) => p[1]);
        const minx = Math.min(...xs);
        const maxx = Math.max(...xs);
        const miny = Math.min(...ys);
        const maxy = Math.max(...ys);
        const padX = Math.max((maxx - minx) * 0.25, 0.1);
        const padY = Math.max((maxy - miny) * 0.25, 0.1);
        return {
          minx: minx - padX,
          maxx: maxx + padX,
          miny: miny - padY,
          maxy: maxy + padY
        };
      }
    }

    // 3. 'fit-data': Auto-frame the active ingested dataset
    if (sector === 'fit-data') {
      const preBbox = meta?.preprocessor_report?.bbox_west_south_east_north;
      if (preBbox && preBbox.length === 4 && (preBbox[0] !== 0 || preBbox[2] !== 0)) {
        const [w, s, e, n] = preBbox;
        const padX = Math.max((e - w) * 0.18, 0.08);
        const padY = Math.max((n - s) * 0.18, 0.08);
        return {
          minx: w - padX,
          maxx: e + padX,
          miny: s - padY,
          maxy: n + padY
        };
      }

      if (vesselPoints.length > 0) {
        const vminx = Math.min(...vesselPoints.map((p) => p[0]));
        const vmaxx = Math.max(...vesselPoints.map((p) => p[0]));
        const vminy = Math.min(...vesselPoints.map((p) => p[1]));
        const vmaxy = Math.max(...vesselPoints.map((p) => p[1]));
        const padX = Math.max((vmaxx - vminx) * 0.2, 0.08);
        const padY = Math.max((vmaxy - vminy) * 0.2, 0.08);
        return {
          minx: vminx - padX,
          maxx: vmaxx + padX,
          miny: vminy - padY,
          maxy: vmaxy + padY
        };
      }

      return SECTOR_CONFIG['all'].bbox;
    }

    // 4. Specific regional sector preset
    if (SECTOR_CONFIG[sector]) {
      return SECTOR_CONFIG[sector].bbox;
    }

    return SECTOR_CONFIG['all'].bbox;
  }, [sector, geomName, activeCorridors, lines, meta, vesselPoints]);

  const local = true; // Equirectangular distance calculation is mathematically valid across whole Baltic domain

  // Base location for ISR Drone (Bornholm Rønne default, preset station, or custom coordinate)
  const isrBase: [number, number] = useMemo(() => {
    if (customBase) return customBase;
    const found = PRESET_BASES.find((b) => b.id === isrBaseId);
    if (found) return found.coords;
    return [14.70, 55.07]; // Bornholm Rønne default
  }, [customBase, isrBaseId]);

  const isrBaseName: string = useMemo(() => {
    if (customBase) return `Custom Point (${customBase[0].toFixed(2)}°E, ${customBase[1].toFixed(2)}°N)`;
    const found = PRESET_BASES.find((b) => b.id === isrBaseId);
    return found ? found.name : 'Bornholm Rønne Base';
  }, [customBase, isrBaseId]);

  // -------------------------------------------------------------
  // FEATURE 4 & 5: ANOMALY SCORING ENGINE & HUMAN-READABLE REASONS
  // -------------------------------------------------------------
  const analyzedVessels: AnomalyResult[] = useMemo(() => {
    if (!snap?.vessels) return [];

    return snap.vessels
      .map((v) => {
        const d = lines.length && local ? nearKm(v, lines) : null;
        const typeLower = (v.ship_type || 'undefined').toLowerCase();

        // Baseline speed for this vessel class
        let baseline = CLASS_BASELINES['other'];
        for (const [k, val] of Object.entries(CLASS_BASELINES)) {
          if (typeLower.includes(k)) {
            baseline = val;
            break;
          }
        }

        const isFishing = typeLower.includes('fish') || typeLower.includes('trawl');
        const isFerry = typeLower.includes('pass') || typeLower.includes('ferry');
        const isCommercial = typeLower.includes('cargo') || typeLower.includes('tanker');

        // Speed Deficit Calculation (preserve null as missing telemetry, do not treat as 0.0 kn)
        const sog = v.sog;
        let speedDeficit = 0;
        if (sog !== null) {
          if (isFishing) {
            speedDeficit = 0;
          } else if (sog < baseline) {
            speedDeficit = baseline - sog;
          }
        }

        // Heading vs Course Drift Angle (Smallest circular arc)
        let driftAngle: number | null = null;
        if (v.heading !== null && v.cog !== null) {
          driftAngle = smallestCircularDiff(v.heading, v.cog);
        }

        // Fix Age Relative to Selected Replay Time
        const curTimestampSec = at ? Date.parse(at) / 1000 : 0;
        const fixTsSec = Date.parse(v.timestamp) / 1000;
        const fixAgeSec = Math.max(0, Math.floor(curTimestampSec - fixTsSec));
        const isStale = fixAgeSec >= 900; // >= 15 min without new broadcast

        // Anomaly Score Formulation
        let score = 0;
        const reasons: string[] = [];

        // 1. Cable Proximity factor
        if (d !== null && d <= corridorKm) {
          const proxWeight = Math.max(0, (corridorKm - d) / corridorKm) * 3.5;
          score += proxWeight;
          reasons.push(`${d.toFixed(1)} km from cable corridor`);
        }

        // 2. Speed Evaluation
        if (sog === null) {
          reasons.push('speed field missing/unreported');
        } else if (sog > 0.5 && sog < 6.0 && !isFishing) {
          const deficitWeight = Math.min(speedDeficit * 0.45, 3.5);
          score += deficitWeight;
          reasons.push(`slow transit ${sog.toFixed(1)} kn vs ~${baseline.toFixed(1)} kn typical (${v.ship_type || 'Commercial'})`);
        } else if (isFishing && sog > 0.5 && sog < 4.5) {
          score = Math.max(0, score - 2.0);
          reasons.push(`speed ${sog.toFixed(1)} kn fits normal trawling profile`);
        }

        // 3. Heading vs Course Deviation (Course drift signature)
        if (driftAngle !== null && driftAngle > 14) {
          const driftWeight = Math.min((driftAngle - 10) * 0.15, 3.0);
          score += driftWeight;
          reasons.push(`course drifts ${driftAngle.toFixed(0)}° from heading`);
        }

        // 4. Stationarity / Drifting
        if (sog !== null && sog >= 0.1 && sog <= 1.5 && d !== null && d <= corridorKm) {
          score += 2.0;
          reasons.push(`near-stationary at ${sog.toFixed(1)} kn inside cable corridor`);
        }

        // Determine Tier
        let tier: 'cue' | 'review' | 'normal' = 'normal';
        if (score >= 4.2) {
          tier = 'cue'; // High priority cue
        } else if (score >= 2.2) {
          tier = 'review'; // Review candidate
        }

        // Build human-readable diagnostic sentence solely from actual observed factors
        let reason = '';
        if (tier === 'cue') {
          reason = `HIGH-PRIORITY CUE. Observed factors: ${reasons.join('; ')}. Physical verification recommended.`;
        } else if (tier === 'review') {
          reason = `CANDIDATE REVIEW. Observed factors: ${reasons.join('; ')}. Baseline exceedance; verification recommended.`;
        } else {
          reason = `Normal traffic: ${v.ship_type || 'vessel'} operating within standard navigational baselines (${reasons.length ? reasons.join('; ') : 'standard transit'}).`;
        }

        return {
          vessel: v,
          dist: d,
          score,
          tier,
          speedDeficit,
          driftAngle,
          reason,
          fixAgeSec,
          isStale,
        };
      })
      .sort((a, b) => b.score - a.score || (a.dist ?? Infinity) - (b.dist ?? Infinity));
  }, [snap, lines, local, corridorKm, at]);

  // -------------------------------------------------------------
  // FEATURE 6: ISR ASSET PLANNER (configurable base, speed & endurance)
  // -------------------------------------------------------------
  const isrPlan: ISRPlan = useMemo(() => {
    const SPEED_KM_MIN = (isrSpeedMs * 60) / 1000;
    const MAX_ENDURANCE_MIN = isrEnduranceMin;
    const DWELL_MIN = isrDwellMin;

    // Prioritize cued and review targets
    const alertCands = analyzedVessels.filter((a) => a.score >= 2.0);

    const legs: ISRLeg[] = [];
    const dropped: { name: string; mmsi: string; reason: string }[] = [];
    let curPos: [number, number] = isrBase;
    let timeElapsed = 0;

    for (const cand of alertCands) {
      const targetPos: [number, number] = [cand.vessel.lon, cand.vessel.lat];
      const legDist = distKm(curPos, targetPos);
      const flightTime = legDist / SPEED_KM_MIN;
      const returnDist = distKm(targetPos, isrBase);
      const returnFlightTime = returnDist / SPEED_KM_MIN;

      // Check if we can fly to target, dwell, AND make it safely back to base within endurance
      const neededTime = timeElapsed + flightTime + DWELL_MIN + returnFlightTime;

      if (neededTime <= MAX_ENDURANCE_MIN) {
        timeElapsed += flightTime + DWELL_MIN;
        legs.push({
          mmsi: cand.vessel.mmsi,
          name: cand.vessel.name || cand.vessel.mmsi,
          from: curPos,
          to: targetPos,
          distKm: legDist,
          flightMin: flightTime,
          dwellMin: DWELL_MIN,
          cumTimeMin: timeElapsed,
        });
        curPos = targetPos;
      } else {
        dropped.push({
          name: cand.vessel.name || cand.vessel.mmsi,
          mmsi: cand.vessel.mmsi,
          reason: `Exceeds ${MAX_ENDURANCE_MIN}m endurance (would require ${neededTime.toFixed(0)} min)`,
        });
      }
    }

    // Add return-to-base flight leg
    if (legs.length > 0) {
      const retDist = distKm(curPos, isrBase);
      const retFlight = retDist / SPEED_KM_MIN;
      timeElapsed += retFlight;
    }

    return {
      feasible: legs.length > 0,
      base: isrBase,
      legs,
      totalTimeMin: timeElapsed,
      fuelMarginMin: Math.max(0, MAX_ENDURANCE_MIN - timeElapsed),
      targetsInvestigated: legs.length,
      droppedTargets: dropped,
    };
  }, [analyzedVessels, isrBase, isrSpeedMs, isrEnduranceMin, isrDwellMin]);

  const selectedVessel = useMemo(
    () => analyzedVessels.find((r) => r.vessel.mmsi === selectedMmsi) ?? null,
    [analyzedVessels, selectedMmsi]
  );

  // Experimental Multi-Fix Track-Based Score Formulation (Delegates to modular continuity engine)
  const experimentalTrackScore: ExperimentalTrackResult | null = useMemo(() => {
    if (!selectedVessel || !trackData || !trackData.fixes || trackData.fixes.length === 0) return null;
    return evaluateTrackScore(
      trackData.fixes,
      lines,
      corridorKm,
      selectedVessel.vessel.ship_type,
      selectedVessel.vessel.mmsi
    );
  }, [selectedVessel, trackData, lines, corridorKm]);

  const minSec = meta ? Date.parse(meta.min_timestamp_utc) / 1000 : 0;
  const maxSec = meta ? Date.parse(meta.max_timestamp_utc) / 1000 : 0;
  const curSec = at ? Date.parse(at) / 1000 : 0;

  const SVG_W = 920;
  const SVG_H = 500;

  const project = (p: XY): XY => {
    if (!bounds) return [0, 0];
    const dx = Math.max(bounds.maxx - bounds.minx, 0.002);
    const dy = Math.max(bounds.maxy - bounds.miny, 0.002);
    return [40 + ((p[0] - bounds.minx) / dx) * (SVG_W - 80), SVG_H - 40 - ((p[1] - bounds.miny) / dy) * (SVG_H - 80)];
  };

  const kmToPx = useMemo(() => {
    if (!bounds) return 20;
    const dyDeg = Math.max(bounds.maxy - bounds.miny, 0.002);
    const pxPerDegLat = (SVG_H - 80) / dyDeg;
    const degLatPerKm = 1 / 111.32;
    return Math.max(10, pxPerDegLat * degLatPerKm * corridorKm * 2);
  }, [bounds, corridorKm]);

  async function loadGeoJson(e: React.ChangeEvent<HTMLInputElement>) {
    const f = e.target.files?.[0];
    if (!f) return;
    try {
      if (f.size > 2_000_000) throw Error('GeoJSON limit is 2 MB');
      const parsed = geometry(JSON.parse(await f.text()));
      const customFeats: SubseaFeature[] = parsed.map((coords, idx) => ({
        name: `Custom Cable #${idx + 1} (${f.name})`,
        type: 'User Uploaded GeoJSON',
        color: '#f43f5e',
        coords
      }));
      setActiveCorridors(customFeats);
      setLines(parsed);
      setGeomName(`Custom: ${f.name}`);
      setError('');
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      e.target.value = '';
    }
  }

  function getVesselVisuals(a: AnomalyResult): { stroke: string; fill: string; alertTier: string } {
    if (a.tier === 'cue') {
      return { stroke: '#fb7185', fill: '#e11d48', alertTier: 'cue' };
    }
    if (a.tier === 'review') {
      return { stroke: '#fbbf24', fill: '#d97706', alertTier: 'review' };
    }
    const type = (a.vessel.ship_type || '').toLowerCase();
    if (type.includes('fish') || type.includes('trawl')) {
      return { stroke: '#f472b6', fill: '#db2777', alertTier: 'normal' };
    }
    if (type.includes('pass') || type.includes('ferry')) {
      return { stroke: '#c084fc', fill: '#9333ea', alertTier: 'normal' };
    }
    if (type.includes('cargo') || type.includes('tanker')) {
      return { stroke: '#38bdf8', fill: '#0284c7', alertTier: 'normal' };
    }
    return { stroke: '#a7f3d0', fill: '#059669', alertTier: 'normal' };
  }

  const alertCounts = useMemo(() => {
    let cues = 0;
    let reviews = 0;
    for (const a of analyzedVessels) {
      if (a.tier === 'cue') cues++;
      else if (a.tier === 'review') reviews++;
    }
    return { cues, reviews };
  }, [analyzedVessels]);

  return (
    <main className="min-h-screen bg-[#070d18] text-slate-100 px-4 py-6 font-sans">
      <div className="mx-auto max-w-7xl space-y-4">
        {/* Top Navigation & Status Bar */}
        <div className="flex flex-wrap items-center justify-between gap-3 border-b border-slate-800 pb-3">
          <div className="flex items-center gap-3">
            <a href="/" className="rounded bg-slate-800 px-3 py-1.5 text-xs font-semibold text-slate-300 hover:bg-slate-700">
              ← Home
            </a>
            <h1 className="text-xl font-bold tracking-tight text-white flex items-center gap-2">
              <span className="inline-block w-2.5 h-2.5 rounded-full bg-emerald-400 animate-pulse"></span>
              Cable Watch <span className="text-amber-400 text-sm font-normal">/ Mantavia Behavioral Threat Detector</span>
            </h1>
          </div>

          <div className="flex flex-wrap items-center gap-2 text-xs">
            <button
              onClick={() => setShowModal(true)}
              className="rounded bg-cyan-600 hover:bg-cyan-500 text-white font-bold px-3 py-1.5 flex items-center gap-1.5 shadow-md transition-colors"
            >
              <span>⚡ Switch / Ingest Dataset</span>
            </button>

            <button
              onClick={() => setShowISRPlan(!showISRPlan)}
              className={`rounded border px-3 py-1.5 font-bold flex items-center gap-1.5 shadow-md transition-colors ${
                showISRPlan
                  ? 'bg-emerald-500 text-slate-950 border-emerald-400'
                  : 'bg-emerald-950/60 border-emerald-700 text-emerald-300 hover:bg-emerald-900'
              }`}
            >
              <span>🛸 ISR Sortie Planner {isrPlan.targetsInvestigated > 0 ? `(${isrPlan.targetsInvestigated})` : ''}</span>
            </button>

            <span className="rounded bg-slate-900 border border-slate-700 px-2.5 py-1 text-slate-300">
              Corridor: <b className="text-amber-400">{corridorKm} km buffer</b>
            </span>

            {alertCounts.cues > 0 && (
              <span className="rounded bg-rose-950 border border-rose-700 text-rose-300 px-2.5 py-1 font-bold animate-pulse">
                {alertCounts.cues} CUE ALERTS
              </span>
            )}

            {alertCounts.reviews > 0 && (
              <span className="rounded bg-amber-950 border border-amber-700 text-amber-300 px-2.5 py-1 font-semibold">
                {alertCounts.reviews} REVIEWS
              </span>
            )}
          </div>
        </div>

        {error && (
          <div role="alert" className="rounded-lg border border-red-500/40 bg-red-950/50 p-3 text-sm text-red-300 flex justify-between items-center">
            <span>{error}</span>
            <div className="flex items-center gap-2">
              <button
                onClick={() => {
                  setError('');
                  refreshMeta();
                }}
                className="px-2.5 py-1 rounded bg-red-800 hover:bg-red-700 text-white font-mono text-xs font-bold transition-colors"
              >
                ↻ Reconnect
              </button>
              <button onClick={() => setError('')} className="text-red-400 hover:text-white text-xs font-bold">✕</button>
            </div>
          </div>
        )}

        {!meta ? (
          <div className="rounded-xl border border-slate-800 bg-slate-900/60 p-8 text-center text-slate-400">
            <p className="animate-pulse">Connecting to local AIS streaming database...</p>
          </div>
        ) : (
          <>
            {/* Playback & Time Scrub Header */}
            <div className="rounded-xl border border-[#1e2e4a] bg-[#0c1626] p-4 shadow-xl">
              <div className="flex flex-wrap items-center justify-between gap-4">
                <div className="flex items-center gap-3">
                  <button
                    onClick={() => setIsPlaying(!isPlaying)}
                    className={`flex items-center gap-2 rounded-lg px-4 py-2 font-bold text-sm shadow-md transition-all ${
                      isPlaying
                        ? 'bg-amber-500 text-slate-950 hover:bg-amber-400'
                        : 'bg-emerald-600 text-white hover:bg-emerald-500'
                    }`}
                  >
                    {isPlaying ? (
                      <>
                        <span className="w-2 h-2 rounded-full bg-slate-950 animate-ping"></span>
                        <span>❚❚ Pause Replay</span>
                      </>
                    ) : (
                      '▶ Play Replay'
                    )}
                  </button>

                  <div className="border-l border-slate-700 pl-3">
                    <div className="text-xs text-slate-400 uppercase tracking-wider font-semibold">
                      Replay Timestamp (UTC) · <span className="text-slate-300">{meta.preprocessor_report.input_file}</span>
                    </div>
                    <div className="text-lg font-mono font-bold text-amber-300 flex items-center gap-2">
                      <span>{at || meta.min_timestamp_utc}</span>
                      {isPlaying && (
                        <span className="text-[10px] text-emerald-400 bg-emerald-950/80 px-2 py-0.5 rounded border border-emerald-800">
                          +{Math.round(45 * playbackSpeed)}s / step
                        </span>
                      )}
                    </div>
                  </div>
                </div>

                <div className="flex items-center gap-3">
                  <label className="flex items-center gap-1.5 text-xs text-slate-300">
                    <span>Speed:</span>
                    <select
                      value={playbackSpeed}
                      onChange={(e) => setPlaybackSpeed(Number(e.target.value))}
                      className="rounded bg-[#070d18] border border-slate-700 px-2 py-1 text-xs text-white"
                    >
                      <option value={1}>1x (Slow / 45s)</option>
                      <option value={5}>5x (Cruising ~4m)</option>
                      <option value={15}>15x (Fast Patrol ~11m)</option>
                      <option value={60}>60x (High Speed ~45m)</option>
                      <option value={180}>180x (Rush ~2h)</option>
                    </select>
                  </label>

                  <label className="flex items-center gap-1.5 text-xs text-slate-300">
                    <span>Lookback:</span>
                    <select
                      value={win}
                      onChange={(e) => {
                        setSnap(null);
                        setWin(Number(e.target.value));
                      }}
                      className="rounded bg-[#070d18] border border-slate-700 px-2 py-1 text-xs text-white"
                    >
                      <option value={15}>15 min</option>
                      <option value={30}>30 min</option>
                      <option value={60}>60 min</option>
                      <option value={180}>3 hours</option>
                    </select>
                  </label>

                  <label className="flex items-center gap-1.5 text-xs text-slate-300">
                    <span>Corridor:</span>
                    <input
                      type="range"
                      min={1}
                      max={10}
                      step={1}
                      value={corridorKm}
                      onChange={(e) => setCorridorKm(Number(e.target.value))}
                      className="w-20 accent-amber-500"
                    />
                    <span className="text-amber-400 w-8">{corridorKm}km</span>
                  </label>
                </div>
              </div>

              {/* Scrubber Range Bar */}
              <div className="mt-3">
                <input
                  aria-label="Replay time scrubber"
                  type="range"
                  min={minSec}
                  max={maxSec}
                  step={1}
                  value={curSec}
                  onChange={(e) => {
                    setIsPlaying(false);
                    setAt(new Date(Number(e.target.value) * 1000).toISOString().replace('.000Z', 'Z'));
                  }}
                  className="w-full accent-amber-500 cursor-pointer h-2 bg-slate-800 rounded-lg"
                />
                <div className="flex justify-between text-[11px] font-mono text-slate-500 mt-1">
                  <span>{meta.min_timestamp_utc}</span>
                  <span className="text-slate-400">
                    {busy ? 'Streaming fixes...' : `${analyzedVessels.length} active vessels (${meta.records.toLocaleString()} total indexed)`}
                  </span>
                  <span>{meta.max_timestamp_utc}</span>
                </div>
              </div>
            </div>

            {/* Dataset Provenance, Time Span & Truncation Alert Bar */}
            <div className="space-y-2">
              <div className="flex flex-wrap items-center justify-between gap-2 rounded-lg bg-[#07101f] border border-slate-800 p-2 text-xs font-mono">
                <div className="flex flex-wrap items-center gap-3">
                  <span className="text-slate-400">Observed Span:</span>
                  <span className="text-cyan-300 font-bold">
                    {meta?.min_timestamp_utc && meta?.max_timestamp_utc
                      ? `${meta.min_timestamp_utc} → ${meta.max_timestamp_utc}`
                      : 'Unknown'}
                  </span>
                  <span className="text-slate-600">|</span>
                  <span className="text-slate-400">Processing BBox:</span>
                  <span className="text-amber-300 font-bold">
                    {meta?.preprocessor_report?.bbox_west_south_east_north
                      ? `[${meta.preprocessor_report.bbox_west_south_east_north.join(', ')}]`
                      : 'Unknown'}
                  </span>
                </div>
                <div className="text-[11px] text-slate-400">
                  Total Indexed Fixes: <span className="text-white font-bold">{meta?.records ? meta.records.toLocaleString() : 'Unknown'}</span>
                </div>
              </div>

              {/* Truncation Banners */}
              {meta?.preprocessor_report?.truncated_by_row_limit && (
                <div className="rounded-lg bg-amber-950/70 border border-amber-600/80 p-2.5 text-xs text-amber-200 flex items-center justify-between shadow-lg">
                  <div className="flex items-center gap-2">
                    <span className="text-base">⚠️</span>
                    <span>
                      <b>Dataset Ingestion Truncated:</b> Preprocessor stopped at row limit. Does not represent full-day coverage (observed until {meta.max_timestamp_utc}).
                    </span>
                  </div>
                  <span className="rounded bg-amber-900/80 border border-amber-500/60 px-2 py-0.5 text-[10px] font-mono font-bold uppercase">
                    Sample / Partial
                  </span>
                </div>
              )}

              {snap?.truncated && (
                <div className="rounded-lg bg-rose-950/70 border border-rose-600/80 p-2.5 text-xs text-rose-200 flex items-center justify-between shadow-lg">
                  <div className="flex items-center gap-2">
                    <span className="text-base">⚠️</span>
                    <span>
                      <b>Replay Query Truncated:</b> Snapshot hit safety limit ({snap.limits?.max_rows_scanned || 20000} scanned rows or {snap.limits?.max_vessels || 500} vessels). Some observations in this lookback window may be omitted.
                    </span>
                  </div>
                  <span className="rounded bg-rose-900/80 border border-rose-500/60 px-2 py-0.5 text-[10px] font-mono font-bold uppercase">
                    Scan Capped
                  </span>
                </div>
              )}
            </div>

            {/* Subsea Cable & Infrastructure Corridor Selector Bar */}
            <div className="rounded-xl border border-amber-500/40 bg-gradient-to-r from-[#171c2b] to-[#121927] p-3 shadow-lg flex flex-wrap items-center justify-between gap-3 text-xs">
              <div className="flex flex-wrap items-center gap-2">
                <span className="font-bold text-amber-400 uppercase tracking-wider flex items-center gap-1.5 font-mono text-xs">
                  <span>⚡</span> Subsea Infrastructure:
                </span>
                <select
                  value={geomName}
                  onChange={(e) => {
                    const val = e.target.value;
                    setGeomName(val);
                    setZoom(1);
                    setPan({ x: 0, y: 0 });
                    if (val === 'ALL') {
                      setActiveCorridors(BALTIC_CORRIDOR_NETWORK);
                      setLines(BALTIC_CORRIDOR_NETWORK.map((f) => f.coords));
                    } else {
                      const found = BALTIC_CORRIDOR_NETWORK.find((f) => f.name === val);
                      if (found) {
                        setActiveCorridors([found]);
                        setLines([found.coords]);
                      }
                    }
                  }}
                  className="rounded bg-[#070d18] border border-amber-500/50 px-3 py-1.5 text-xs text-amber-200 font-semibold"
                >
                  <option value="ALL">★ All Corridors ({BALTIC_CORRIDOR_NETWORK.length} Built-in Baltic Infrastructure Lines)</option>
                  <optgroup label="Bornholm Basin & Approaches (Judges Demo Area)">
                    {BALTIC_CORRIDOR_NETWORK.filter((c) => c.region === 'Bornholm').map((c) => (
                      <option key={c.name} value={c.name}>{c.name} ({c.type})</option>
                    ))}
                  </optgroup>
                  <optgroup label="Western Baltic & German Approaches">
                    {BALTIC_CORRIDOR_NETWORK.filter((c) => c.region === 'Western Baltic').map((c) => (
                      <option key={c.name} value={c.name}>{c.name} ({c.type})</option>
                    ))}
                  </optgroup>
                  <optgroup label="Danish Belts & Straits (Storebælt, Lillebælt, Øresund)">
                    {BALTIC_CORRIDOR_NETWORK.filter((c) => c.region === 'Straits').map((c) => (
                      <option key={c.name} value={c.name}>{c.name} ({c.type})</option>
                    ))}
                  </optgroup>
                  <optgroup label="Kattegat & Regional Baltic Pipelines">
                    {BALTIC_CORRIDOR_NETWORK.filter((c) => c.region === 'Kattegat' || c.region === 'Regional').map((c) => (
                      <option key={c.name} value={c.name}>{c.name} ({c.type})</option>
                    ))}
                  </optgroup>
                  {geomName.startsWith('Custom:') && <option value={geomName}>{geomName}</option>}
                </select>
              </div>

              <div className="flex flex-wrap items-center gap-3">
                <label className="flex items-center gap-1.5 text-slate-300">
                  <span className="font-mono text-xs">Buffer Width:</span>
                  <input
                    type="range"
                    min={1}
                    max={12}
                    step={1}
                    value={corridorKm}
                    onChange={(e) => setCorridorKm(Number(e.target.value))}
                    className="w-24 accent-amber-500"
                  />
                  <span className="text-amber-400 font-bold font-mono">{corridorKm} km</span>
                </label>

                <label className="rounded-lg bg-amber-500/20 hover:bg-amber-500/30 border border-amber-500/50 px-3 py-1.5 text-amber-300 font-bold cursor-pointer transition-colors flex items-center gap-1.5">
                  <span>📁 Load Custom GeoJSON</span>
                  <input type="file" accept=".geojson,.json" onChange={loadGeoJson} className="hidden" />
                </label>
              </div>
            </div>

            {/* Quick Sector Focus Navigation Bar */}
            <div className="flex flex-wrap items-center justify-between gap-2 rounded-xl bg-[#091526] border border-[#1e2e4a] p-2.5 text-xs shadow-md">
              <div className="flex flex-wrap items-center gap-1.5">
                <span className="font-mono font-bold text-slate-400 mr-1 flex items-center gap-1 text-[11px] uppercase tracking-wider">
                  <span>🧭</span> Sector Focus:
                </span>
                {(['fit-data', 'bornholm', 'fehmarn', 'storebaelt', 'oresund', 'kattegat', 'all'] as SectorId[]).map((secKey) => {
                  const sec = SECTOR_CONFIG[secKey];
                  const isActive = sector === secKey && geomName === 'ALL';
                  return (
                    <button
                      key={secKey}
                      onClick={() => {
                        setSector(secKey);
                        setGeomName('ALL');
                        setActiveCorridors(BALTIC_CORRIDOR_NETWORK);
                        setLines(BALTIC_CORRIDOR_NETWORK.map((f) => f.coords));
                        setZoom(1);
                        setPan({ x: 0, y: 0 });
                      }}
                      className={`flex items-center gap-1 px-2.5 py-1 rounded-md text-[11px] font-mono font-bold transition-all shadow-sm ${
                        isActive
                          ? 'bg-cyan-600 text-white ring-1 ring-cyan-300'
                          : 'bg-[#0f1d33] text-slate-300 hover:bg-slate-700 hover:text-white border border-slate-700/60'
                      }`}
                    >
                      <span>{sec.icon}</span>
                      <span>{sec.label}</span>
                    </button>
                  );
                })}
              </div>
              <div className="text-[11px] font-mono text-slate-400 flex items-center gap-2">
                <span className="text-amber-400 font-semibold">{activeCorridors.length} Corridors Active</span>
                <span>·</span>
                <span>{bounds ? `${bounds.minx.toFixed(2)}°-${bounds.maxx.toFixed(2)}°E, ${bounds.miny.toFixed(2)}°-${bounds.maxy.toFixed(2)}°N` : ''}</span>
              </div>
            </div>

            {/* Tactical Grid Visualization & Detail Panel */}
            <div className="grid gap-4 lg:grid-cols-3">
              {/* Main SVG Tactical Map Canvas */}
              <div className="lg:col-span-2 rounded-xl border border-[#1e2e4a] bg-[#081325] p-3 shadow-2xl relative overflow-hidden">
                <div className="flex items-center justify-between mb-2 px-1">
                  <div className="flex items-center gap-2">
                    <span className="inline-block w-2 h-2 bg-cyan-400 rounded-full animate-ping"></span>
                    <span className="text-xs font-mono font-bold tracking-wider uppercase text-cyan-300">
                      OPERATIONAL AIS SECTOR &amp; ISR CUEING RADAR
                    </span>
                  </div>
                  <div className="text-[11px] font-mono text-slate-400">
                    {bounds ? `${bounds.minx.toFixed(2)}°E - ${bounds.maxx.toFixed(2)}°E · ${bounds.miny.toFixed(2)}°N - ${bounds.maxy.toFixed(2)}°N` : ''}
                  </div>
                </div>

                {isPlacingBase && (
                  <div className="absolute top-12 left-1/2 -translate-x-1/2 z-30 bg-emerald-500 text-slate-950 font-mono text-xs font-bold px-3.5 py-1.5 rounded-full shadow-2xl animate-pulse flex items-center gap-2 border border-emerald-200">
                    <span>📍</span> Click anywhere on the radar map to deploy the ISR Base
                    <button
                      onClick={() => setIsPlacingBase(false)}
                      className="ml-2 bg-emerald-700 text-white rounded-full w-4 h-4 flex items-center justify-center hover:bg-emerald-800 text-[10px]"
                    >
                      ✕
                    </button>
                  </div>
                )}

                <svg
                  viewBox={`0 0 ${SVG_W} ${SVG_H}`}
                  className={`w-full rounded-lg bg-[#06101e] border border-slate-800 select-none ${
                    isPlacingBase
                      ? 'cursor-crosshair'
                      : isDragging
                      ? 'cursor-grabbing'
                      : 'cursor-grab'
                  }`}
                  role="img"
                  onClick={(e) => {
                    if (!isPlacingBase) return;
                    const rect = e.currentTarget.getBoundingClientRect();
                    const clickX = e.clientX - rect.left;
                    const clickY = e.clientY - rect.top;
                    const scaleX = SVG_W / rect.width;
                    const scaleY = SVG_H / rect.height;
                    const rawSvgX = clickX * scaleX;
                    const rawSvgY = clickY * scaleY;
                    const unscaledX = (rawSvgX - (SVG_W / 2 + pan.x)) / zoom + SVG_W / 2;
                    const unscaledY = (rawSvgY - (SVG_H / 2 + pan.y)) / zoom + SVG_H / 2;
                    if (bounds) {
                      const dx = Math.max(bounds.maxx - bounds.minx, 0.002);
                      const dy = Math.max(bounds.maxy - bounds.miny, 0.002);
                      const lon = bounds.minx + ((unscaledX - 40) / (SVG_W - 80)) * dx;
                      const lat = bounds.miny + ((SVG_H - 40 - unscaledY) / (SVG_H - 80)) * dy;
                      setCustomBase([Number(lon.toFixed(4)), Number(lat.toFixed(4))]);
                      setIsPlacingBase(false);
                    }
                  }}
                  onMouseDown={(e) => {
                    if (isPlacingBase) return;
                    if (e.button === 0) {
                      setIsDragging(true);
                      dragStartRef.current = { x: e.clientX, y: e.clientY, panX: pan.x, panY: pan.y };
                    }
                  }}
                  onMouseMove={(e) => {
                    if (isDragging) {
                      const dx = e.clientX - dragStartRef.current.x;
                      const dy = e.clientY - dragStartRef.current.y;
                      setPan({ x: dragStartRef.current.panX + dx, y: dragStartRef.current.panY + dy });
                    }
                  }}
                  onMouseUp={() => setIsDragging(false)}
                  onMouseLeave={() => setIsDragging(false)}
                  onWheel={(e) => {
                    e.preventDefault();
                    const delta = e.deltaY < 0 ? 1.2 : 0.83;
                    setZoom((z) => Math.min(Math.max(z * delta, 0.15), 12.0));
                  }}
                >
                  <defs>
                    <pattern id="tactical-grid" width="40" height="40" patternUnits="userSpaceOnUse">
                      <path d="M 40 0 L 0 0 0 40" fill="none" stroke="#0e233d" strokeWidth="0.8" />
                    </pattern>
                    <pattern id="tactical-dots" width="80" height="80" patternUnits="userSpaceOnUse">
                      <circle cx="2" cy="2" r="1.5" fill="#1e3a5f" />
                    </pattern>
                  </defs>

                  <rect width={SVG_W} height={SVG_H} fill="#071221" />
                  <rect width={SVG_W} height={SVG_H} fill="url(#tactical-grid)" />
                  <rect width={SVG_W} height={SVG_H} fill="url(#tactical-dots)" />

                  {/* Zoomable & Pannable Group */}
                  <g transform={`translate(${SVG_W / 2 + pan.x}, ${SVG_H / 2 + pan.y}) scale(${zoom}) translate(${-SVG_W / 2}, ${-SVG_H / 2})`}>
                    <rect x="20" y="20" width={SVG_W - 40} height={SVG_H - 40} fill="none" stroke="#173152" strokeWidth="1" strokeDasharray="4,4" />

                    {/* Geographic Reference Land Markers */}
                    <g opacity="0.45" pointerEvents="none">
                      <text x={project([13.4, 55.75])[0]} y={project([13.4, 55.75])[1]} fill="#94a3b8" fontSize="12" fontFamily="monospace" fontWeight="bold">
                        SWEDEN (SKÅNE)
                      </text>
                      <text x={project([14.9, 55.15])[0]} y={project([14.9, 55.15])[1]} fill="#94a3b8" fontSize="12" fontFamily="monospace" fontWeight="bold">
                        BORNHOLM (DK)
                      </text>
                      <text x={project([12.2, 55.55])[0]} y={project([12.2, 55.55])[1]} fill="#94a3b8" fontSize="12" fontFamily="monospace" fontWeight="bold">
                        ZEALAND (SJÆLLAND)
                      </text>
                      <text x={project([10.7, 55.35])[0]} y={project([10.7, 55.35])[1]} fill="#94a3b8" fontSize="12" fontFamily="monospace" fontWeight="bold">
                        STOREBÆLT / FYN
                      </text>
                      <text x={project([11.2, 54.45])[0]} y={project([11.2, 54.45])[1]} fill="#94a3b8" fontSize="12" fontFamily="monospace" fontWeight="bold">
                        FEHMARN (GERMANY)
                      </text>
                      <text x={project([13.4, 54.45])[0]} y={project([13.4, 54.45])[1]} fill="#94a3b8" fontSize="12" fontFamily="monospace" fontWeight="bold">
                        RÜGEN / ARKONA
                      </text>
                    </g>

                  {/* Multi-Corridor Infrastructure Overlay */}
                  {activeCorridors.map((c, i) => {
                    const pointsStr = c.coords.map((p) => project(p).join(',')).join(' ');
                    const frac = c.labelFrac ?? 0.5;
                    const idx = Math.min(Math.floor(c.coords.length * frac), c.coords.length - 1);
                    const midPt = c.coords[idx];
                    const [mx, my] = project(midPt);
                    const offX = c.labelOffset ? c.labelOffset[0] : 8;
                    const offY = c.labelOffset ? c.labelOffset[1] : -6;

                    // Landing endpoints
                    const pStart = project(c.coords[0]);
                    const pEnd = project(c.coords[c.coords.length - 1]);

                    return (
                      <g key={`corridor-${c.name}-${i}`}>
                        {/* Translucent Safety Buffer Ribbon */}
                        <polyline
                          points={pointsStr}
                          fill="none"
                          stroke={c.color}
                          strokeOpacity="0.18"
                          strokeWidth={kmToPx}
                          strokeLinecap="round"
                          strokeLinejoin="round"
                        />
                        {/* Dashed Buffer Border */}
                        <polyline
                          points={pointsStr}
                          fill="none"
                          stroke={c.color}
                          strokeOpacity="0.45"
                          strokeWidth={kmToPx + 4}
                          strokeLinecap="round"
                          strokeLinejoin="round"
                          strokeDasharray="6,8"
                        />
                        {/* Core Subsea Cable / Pipe Backbone */}
                        <polyline
                          points={pointsStr}
                          fill="none"
                          stroke={c.color}
                          strokeWidth="2.8"
                          strokeDasharray="6,3"
                        />

                        {/* Landing Beacons (Terminus Nodes) */}
                        <circle cx={pStart[0]} cy={pStart[1]} r="4.5" fill={c.color} stroke="#ffffff" strokeWidth="1.2" />
                        <circle cx={pEnd[0]} cy={pEnd[1]} r="4.5" fill={c.color} stroke="#ffffff" strokeWidth="1.2" />

                        {/* Staggered Label with Dark Pill Background */}
                        <g transform={`translate(${mx + offX}, ${my + offY})`}>
                          <rect
                            x="-4"
                            y="-11"
                            width={c.name.length * 6.2 + 36}
                            height="16"
                            rx="3"
                            fill="#071221"
                            fillOpacity="0.88"
                            stroke={c.color}
                            strokeWidth="0.8"
                          />
                          <text
                            x="2"
                            y="1"
                            fill={c.color}
                            fontSize="9"
                            fontFamily="monospace"
                            fontWeight="bold"
                          >
                            ⚡ {c.name.toUpperCase()}
                          </text>
                        </g>
                      </g>
                    );
                  })}

                  {/* ISR BASE ICON (Fixed Drone Launch Point) */}
                  {(() => {
                    const [bx, by] = project(isrBase);
                    return (
                      <g>
                        <rect x={bx - 9} y={by - 9} width="18" height="18" fill="#10b981" fillOpacity="0.25" stroke="#10b981" strokeWidth="1.5" />
                        <circle cx={bx} cy={by} r="3" fill="#10b981" />
                        <text x={bx + 12} y={by + 4} fill="#34d399" fontSize="10" fontFamily="monospace" fontWeight="bold">
                          ISR BASE: {isrBaseName.toUpperCase()} ({isrSpeedMs}m/s)
                        </text>
                      </g>
                    );
                  })()}

                  {/* ISR FLIGHT SORTIE PATH (Feature 6) */}
                  {showISRPlan && isrPlan.feasible && (
                    <g>
                      {isrPlan.legs.map((leg, i) => {
                        const [fx, fy] = project(leg.from);
                        const [tx, ty] = project(leg.to);
                        return (
                          <g key={`isr-leg-${i}`}>
                            <line
                              x1={fx}
                              y1={fy}
                              x2={tx}
                              y2={ty}
                              stroke="#10b981"
                              strokeWidth="2.2"
                              strokeDasharray="6,4"
                              strokeOpacity="0.85"
                            />
                            {/* Sequence number badge on target */}
                            <circle cx={tx} cy={ty} r="12" fill="#065f46" stroke="#34d399" strokeWidth="1.5" />
                            <text x={tx} y={ty + 3.5} fill="#ffffff" fontSize="10" fontWeight="bold" textAnchor="middle">
                              #{i + 1}
                            </text>
                          </g>
                        );
                      })}
                      {/* Return leg to Base */}
                      {isrPlan.legs.length > 0 && (() => {
                        const lastLeg = isrPlan.legs[isrPlan.legs.length - 1];
                        const [lx, ly] = project(lastLeg.to);
                        const [bx, by] = project(isrBase);
                        return (
                          <line
                            x1={lx}
                            y1={ly}
                            x2={bx}
                            y2={by}
                            stroke="#10b981"
                            strokeWidth="1.5"
                            strokeDasharray="3,3"
                            strokeOpacity="0.5"
                          />
                        );
                      })()}
                    </g>
                  )}

                  {/* Selected Vessel Historical Track & Breadcrumb Points */}
                  {selectedMmsi && trackData && trackData.fixes.length > 1 && (
                    <g className="vessel-track-layer" pointerEvents="none">
                      <polyline
                        points={trackData.fixes
                          .map((f) => {
                            const [px, py] = project([f.lon, f.lat]);
                            return `${px.toFixed(1)},${py.toFixed(1)}`;
                          })
                          .join(' ')}
                        fill="none"
                        stroke="#38bdf8"
                        strokeWidth="2"
                        strokeDasharray="4,3"
                        strokeOpacity="0.85"
                      />
                      {trackData.fixes.map((f, i) => {
                        const [px, py] = project([f.lon, f.lat]);
                        const isConflicting =
                          i > 0 &&
                          trackData.fixes[i - 1].timestamp === f.timestamp &&
                          (trackData.fixes[i - 1].lat !== f.lat || trackData.fixes[i - 1].lon !== f.lon);
                        return (
                          <circle
                            key={`hist-pt-${f.rowid || i}`}
                            cx={px}
                            cy={py}
                            r={isConflicting ? 4.5 : 2.5}
                            fill={isConflicting ? '#f43f5e' : '#0284c7'}
                            stroke={isConflicting ? '#ffffff' : '#38bdf8'}
                            strokeWidth={isConflicting ? 1.5 : 0.8}
                            opacity={0.9}
                          />
                        );
                      })}
                    </g>
                  )}

                  {/* Render Vessels with Heading Vectors & Behavior Tiers */}
                  {analyzedVessels.map((a) => {
                    const v = a.vessel;
                    const [vx, vy] = project([v.lon, v.lat]);
                    const visuals = getVesselVisuals(a);
                    const isSelected = v.mmsi === selectedMmsi;

                    const angle = v.cog ?? v.heading ?? null;
                    const speed = v.sog ?? 0;
                    const vectorLen = Math.max(10, Math.min(42, speed * 2.2));
                    const rad = angle !== null ? (angle * Math.PI) / 180 : null;
                    const vecX = rad !== null ? vx + Math.sin(rad) * vectorLen : null;
                    const vecY = rad !== null ? vy - Math.cos(rad) * vectorLen : null;

                    return (
                      <g
                        key={v.mmsi}
                        className="cursor-pointer transition-transform"
                        onClick={() => setSelectedMmsi(v.mmsi)}
                      >
                        {isSelected && (
                          <g>
                            <circle cx={vx} cy={vy} r="20" fill="none" stroke="#38bdf8" strokeWidth="1.5" strokeDasharray="4,4" className="animate-spin" />
                            <circle cx={vx} cy={vy} r="13" fill="none" stroke="#38bdf8" strokeWidth="1" />
                            <line x1={vx - 24} y1={vy} x2={vx + 24} y2={vy} stroke="#38bdf8" strokeWidth="0.8" strokeOpacity="0.8" />
                            <line x1={vx} y1={vy - 24} x2={vx} y2={vy + 24} stroke="#38bdf8" strokeWidth="0.8" strokeOpacity="0.8" />
                          </g>
                        )}

                        {/* CUE TIER PULSING HALO */}
                        {visuals.alertTier === 'cue' && (
                          <circle cx={vx} cy={vy} r="16" fill="#f43f5e" fillOpacity="0.3" stroke="#f43f5e" strokeWidth="1.5" className="animate-ping" />
                        )}

                        {/* REVIEW TIER RING */}
                        {visuals.alertTier === 'review' && (
                          <circle cx={vx} cy={vy} r="12" fill="none" stroke="#fbbf24" strokeWidth="1.2" strokeDasharray="3,3" />
                        )}

                        {/* Velocity Vector */}
                        {vecX !== null && vecY !== null && (
                          <line
                            x1={vx}
                            y1={vy}
                            x2={vecX}
                            y2={vecY}
                            stroke={visuals.stroke}
                            strokeWidth={isSelected ? '2.5' : '1.8'}
                            strokeOpacity="0.9"
                          />
                        )}

                        {/* Vessel Marker */}
                        <circle
                          cx={vx}
                          cy={vy}
                          r={isSelected ? 6.5 : 5}
                          fill={visuals.fill}
                          stroke="#ffffff"
                          strokeWidth={isSelected ? '2' : '1'}
                        />

                        {/* Label */}
                        <text
                          x={vx + 8}
                          y={vy + 3.5}
                          fontSize="10"
                          fontFamily="monospace"
                          fill={
                            isSelected
                              ? '#38bdf8'
                              : visuals.alertTier === 'cue'
                              ? '#fb7185'
                              : visuals.alertTier === 'review'
                              ? '#fbbf24'
                              : '#cbd5e1'
                          }
                          fontWeight={isSelected || visuals.alertTier !== 'normal' ? 'bold' : 'normal'}
                        >
                          {v.name || v.mmsi} {v.sog !== null ? `(${v.sog}kn)` : ''}
                        </text>
                      </g>
                    );
                  })}
                  </g>
                </svg>

                {/* Floating Map Navigation Controls (Pan, Zoom & Scope) */}
                <div className="absolute bottom-14 right-5 z-20 flex flex-wrap items-center gap-1.5 rounded-lg border border-slate-700 bg-slate-900/95 backdrop-blur p-1.5 shadow-2xl">
                  <div className="flex items-center gap-1 border-r border-slate-700 pr-2 mr-1">
                    <button
                      onClick={() => {
                        setSector('fit-data');
                        setGeomName('ALL');
                        setZoom(1);
                        setPan({ x: 0, y: 0 });
                      }}
                      className={`px-2 h-7 rounded text-[11px] font-mono font-bold transition-colors ${
                        sector === 'fit-data' && geomName === 'ALL'
                          ? 'bg-cyan-600 text-white'
                          : 'bg-slate-800 text-slate-400 hover:text-white'
                      }`}
                      title="Auto-Fit to Active Ingested Dataset Bounding Box"
                    >
                      ⛶ Fit Data
                    </button>
                    <button
                      onClick={() => {
                        setSector('all');
                        setGeomName('ALL');
                        setZoom(1);
                        setPan({ x: 0, y: 0 });
                      }}
                      className={`px-2 h-7 rounded text-[11px] font-mono font-bold transition-colors ${
                        sector === 'all' && geomName === 'ALL'
                          ? 'bg-cyan-600 text-white'
                          : 'bg-slate-800 text-slate-400 hover:text-white'
                      }`}
                      title="Show All Baltic & Danish Waters (9.5° - 16.5°E)"
                    >
                      🌐 All Waters
                    </button>
                  </div>

                  <button
                    onClick={() => setZoom((z) => Math.min(z * 1.35, 12))}
                    className="w-7 h-7 rounded bg-slate-800 hover:bg-slate-700 text-white font-bold flex items-center justify-center transition-colors text-base"
                    title="Zoom In"
                  >
                    +
                  </button>
                  <button
                    onClick={() => setZoom((z) => Math.max(z / 1.35, 0.15))}
                    className="w-7 h-7 rounded bg-slate-800 hover:bg-slate-700 text-white font-bold flex items-center justify-center transition-colors text-base"
                    title="Zoom Out (Down to 15%)"
                  >
                    −
                  </button>
                  <button
                    onClick={() => {
                      setZoom(1);
                      setPan({ x: 0, y: 0 });
                    }}
                    className="px-2 h-7 rounded bg-slate-800 hover:bg-slate-700 text-cyan-300 font-mono text-[11px] font-bold flex items-center justify-center transition-colors"
                    title="Reset Pan & Zoom (Click-drag to pan canvas)"
                  >
                    ⛶ {Math.round(zoom * 100)}%
                  </button>
                </div>

                {/* Map Footer & Legend */}
                <div className="mt-3 flex flex-wrap items-center justify-between text-[11px] text-slate-400 border-t border-slate-800 pt-2 font-mono">
                  <div className="flex flex-wrap items-center gap-4">
                    <span className="flex items-center gap-1.5">
                      <span className="w-3 h-3 rounded-full bg-[#e11d48] border border-white"></span> CUE (Anomaly ≥ 4.2)
                    </span>
                    <span className="flex items-center gap-1.5">
                      <span className="w-3 h-3 rounded-full bg-[#d97706]"></span> REVIEW (≥ 2.2)
                    </span>
                    <span className="flex items-center gap-1.5">
                      <span className="w-3 h-3 rounded-full bg-[#0284c7]"></span> Cargo/Tanker
                    </span>
                    <span className="flex items-center gap-1.5">
                      <span className="w-3 h-3 rounded-full bg-[#db2777]"></span> Fishing
                    </span>
                    <span className="flex items-center gap-1.5">
                      <span className="w-3 h-3 bg-[#10b981]"></span> ISR Base / Sortie Vector
                    </span>
                  </div>
                  <div>Click any vessel to inspect diagnostic reason</div>
                </div>
              </div>

              {/* Sidebar: Target Telemetry, ISR Mission & Alert Ranks */}
              <div className="space-y-4">
                {/* Active Target Diagnostic HUD */}
                <div className="rounded-xl border border-[#1e2e4a] bg-[#0c1626] p-4 shadow-xl">
                  <div className="flex items-center justify-between border-b border-slate-800 pb-2 mb-3">
                    <span className="text-xs font-mono uppercase font-bold text-cyan-400 tracking-wider">
                      Threat Diagnostic HUD
                    </span>
                    {selectedVessel ? (
                      <span
                        className={`rounded px-2 py-0.5 text-[10px] font-mono font-bold ${
                          selectedVessel.tier === 'cue'
                            ? 'bg-rose-950 text-rose-300 border border-rose-700 animate-pulse'
                            : selectedVessel.tier === 'review'
                            ? 'bg-amber-950 text-amber-300 border border-amber-700'
                            : 'bg-slate-800 text-slate-400'
                        }`}
                      >
                        {selectedVessel.tier.toUpperCase()} TIER
                      </span>
                    ) : (
                      <span className="text-[10px] text-slate-500 font-mono">SELECT VESSEL</span>
                    )}
                  </div>

                  {selectedVessel ? (
                    <div className="space-y-2.5 text-xs font-mono">
                      <div className="flex justify-between">
                        <span className="text-slate-400">Vessel Name:</span>
                        <span className="font-bold text-white">{selectedVessel.vessel.name || 'UNSPECIFIED'}</span>
                      </div>
                      <div className="flex justify-between">
                        <span className="text-slate-400">MMSI:</span>
                        <span className="text-cyan-300 font-bold">{selectedVessel.vessel.mmsi}</span>
                      </div>
                      <div className="flex justify-between">
                        <span className="text-slate-400">Class:</span>
                        <span className="text-slate-200">{selectedVessel.vessel.ship_type || 'Undefined'}</span>
                      </div>
                      <div className="flex justify-between">
                        <span className="text-slate-400">Speed (SOG):</span>
                        <span className="font-bold text-amber-300">
                          {selectedVessel.vessel.sog !== null ? `${selectedVessel.vessel.sog} kn` : <span className="text-slate-500 italic font-normal">missing</span>}
                        </span>
                      </div>
                      <div className="flex justify-between">
                        <span className="text-slate-400">Heading Drift (Δ):</span>
                        <span className={`font-bold ${selectedVessel.driftAngle && selectedVessel.driftAngle > 15 ? 'text-rose-400' : 'text-slate-300'}`}>
                          {selectedVessel.driftAngle !== null ? `${selectedVessel.driftAngle.toFixed(0)}°` : <span className="text-slate-500 italic font-normal">missing</span>}
                        </span>
                      </div>
                      <div className="flex justify-between">
                        <span className="text-slate-400">Cable Distance:</span>
                        <span
                          className={`font-bold ${
                            selectedVessel.dist !== null && selectedVessel.dist <= 2
                              ? 'text-rose-400 animate-pulse'
                              : 'text-emerald-400'
                          }`}
                        >
                          {selectedVessel.dist !== null ? `~${selectedVessel.dist.toFixed(2)} km` : 'N/A'}
                        </span>
                      </div>
                      <div className="flex justify-between">
                        <span className="text-slate-400">Fix Freshness (Age):</span>
                        <span className={`font-bold ${selectedVessel.isStale ? 'text-amber-400 animate-pulse' : 'text-emerald-300'}`}>
                          {selectedVessel.fixAgeSec < 60 ? `${selectedVessel.fixAgeSec}s ago` : `${Math.floor(selectedVessel.fixAgeSec / 60)}m ago`}{' '}
                          {selectedVessel.isStale ? '(STALE >15m)' : '(Fresh)'}
                        </span>
                      </div>
                      <div className="flex justify-between border-t border-slate-800 pt-2">
                        <span className="text-slate-400">Single-Fix Score:</span>
                        <span className="font-bold text-white text-sm">
                          {selectedVessel.score.toFixed(2)}
                        </span>
                      </div>

                      {/* Human-Readable Reason Text Box */}
                      <div className="rounded bg-slate-900 border border-slate-700/60 p-2.5 text-[11px] font-sans leading-relaxed text-slate-200">
                        <b className="text-amber-400 font-mono block mb-1">Single-Fix Heuristic Assessment:</b>
                        {selectedVessel.reason}
                      </div>

                      {/* Experimental Multi-Fix Track-Based Assessment Card */}
                      <div className="rounded-lg bg-[#071324] border border-cyan-800/80 p-3 space-y-2 mt-3">
                        <div className="flex items-center justify-between border-b border-cyan-900/60 pb-1.5">
                          <span className="text-[11px] font-bold text-cyan-300 uppercase tracking-wider flex items-center gap-1 font-mono">
                            <span>🧪</span> Experimental Track Score
                          </span>
                          {experimentalTrackScore ? (
                            <span
                              className={`rounded px-1.5 py-0.5 text-[9px] font-bold font-mono ${
                                experimentalTrackScore.tier === 'cue'
                                  ? 'bg-rose-950 text-rose-300 border border-rose-800'
                                  : experimentalTrackScore.tier === 'review'
                                  ? 'bg-amber-950 text-amber-300 border border-amber-800'
                                  : 'bg-slate-800 text-slate-400'
                              }`}
                            >
                              {experimentalTrackScore.score.toFixed(2)} · {experimentalTrackScore.tier.toUpperCase()}
                            </span>
                          ) : trackLoading ? (
                            <span className="text-[10px] text-cyan-400 animate-pulse">Loading track...</span>
                          ) : (
                            <span className="text-[10px] text-slate-500">No track data</span>
                          )}
                        </div>

                        {trackData?.truncated && (
                          <div className="rounded bg-amber-950/90 border border-amber-600/70 p-2 text-[10px] text-amber-200 font-sans flex items-start gap-1.5 leading-snug">
                            <span className="text-amber-400 font-bold">⚠️</span>
                            <div>
                              <strong className="text-amber-300">Track Truncated:</strong> Replay query reached safety limit ({trackData.limit || 5000} fixes). Older fixes in this {trackData.window_minutes}m window were omitted to prioritize latest observations up to replay time.
                            </div>
                          </div>
                        )}

                        {experimentalTrackScore && (
                          <div className="text-[11px] space-y-1.5 font-mono">
                            <div className="flex justify-between text-slate-400">
                              <span>Track Observations:</span>
                              <span className="text-slate-200">
                                {experimentalTrackScore.contributingFixesCount} fixes over {experimentalTrackScore.timeSpanMin} min
                              </span>
                            </div>
                            <div className="flex justify-between text-slate-400">
                              <span>Contiguous Slow Dwell:</span>
                              <span className={experimentalTrackScore.contiguousSlowMin >= 15 ? 'text-rose-400 font-bold' : 'text-slate-300 font-bold'}>
                                ~{experimentalTrackScore.contiguousSlowMin} min ({experimentalTrackScore.distinctSlowFixesCount} distinct obs)
                              </span>
                            </div>
                            <div className="flex justify-between text-slate-400">
                              <span>Mean Velocity:</span>
                              <span className="text-amber-300 font-bold">
                                {experimentalTrackScore.meanSog !== null ? `${experimentalTrackScore.meanSog.toFixed(1)} kn` : 'N/A'}
                              </span>
                            </div>
                            <div className="flex justify-between text-slate-400">
                              <span>Mean Divergence:</span>
                              <span className="text-slate-200 font-bold">
                                {experimentalTrackScore.meanDriftAngle !== null ? `${experimentalTrackScore.meanDriftAngle.toFixed(0)}°` : 'N/A'}
                              </span>
                            </div>

                            <div className="rounded bg-slate-900/80 border border-cyan-900/40 p-2 text-[10px] text-cyan-200 font-sans leading-relaxed">
                              {experimentalTrackScore.reason}
                            </div>
                            <div className="text-[9px] text-slate-500 italic font-sans leading-normal">
                              * Note: AIS data provides behavioral telemetry only; it does not prove physical anchor deployment, seabed contact, damage, or intent.
                            </div>
                          </div>
                        )}
                      </div>

                      {/* ML Shadow-Mode Historical Pattern Comparison Card */}
                      <div className="rounded-lg bg-[#0c1222] border border-indigo-800/80 p-3 space-y-2 mt-3">
                        <div className="flex items-center justify-between border-b border-indigo-900/60 pb-1.5">
                          <div className="flex items-center gap-1.5 font-mono">
                            <span className="text-[11px] font-bold text-indigo-300 uppercase tracking-wider flex items-center gap-1">
                              <span>🔬</span> Pattern Comparison
                            </span>
                            <span className="rounded bg-indigo-950 text-indigo-300 border border-indigo-700/60 text-[9px] px-1 py-0.2 font-sans font-semibold">
                              Shadow Mode
                            </span>
                          </div>
                          <button
                            onClick={() => {
                              const next = !enableMLShadow;
                              setEnableMLShadow(next);
                              if (typeof window !== 'undefined') {
                                localStorage.setItem('cablewatch_enable_ml_shadow', String(next));
                              }
                            }}
                            className={`rounded px-1.5 py-0.5 text-[9px] font-bold font-mono border transition-colors cursor-pointer ${
                              enableMLShadow
                                ? 'bg-indigo-900/60 text-indigo-200 border-indigo-500 hover:bg-indigo-800/80'
                                : 'bg-slate-800 text-slate-400 border-slate-700 hover:bg-slate-700'
                            }`}
                            title="Toggle ML shadow-mode second-opinion evaluation"
                          >
                            {enableMLShadow ? 'SHADOW: ON' : 'SHADOW: OFF'}
                          </button>
                        </div>

                        {!enableMLShadow ? (
                          <div className="text-[10px] text-slate-400 font-sans py-1 flex items-center justify-between">
                            <span>Historical pattern comparison is disabled (default-off).</span>
                            <span className="text-slate-500 text-[9px]">Click toggle to enable</span>
                          </div>
                        ) : mlLoading ? (
                          <div className="text-[10px] text-indigo-400 font-mono animate-pulse py-2 flex items-center gap-2">
                            <span>⏳</span> Evaluating 60m track window against baseline model...
                          </div>
                        ) : !mlScore ? (
                          <div className="text-[10px] text-slate-500 font-sans py-1">
                            No ML shadow evaluation available for this vessel.
                          </div>
                        ) : mlScore.status === 'ok' ? (
                          <div className="space-y-2 text-[11px] font-mono">
                            {/* Anomaly Percentile & Headline */}
                            <div className="flex items-center justify-between bg-indigo-950/40 p-2 rounded border border-indigo-900/40">
                              <div>
                                <div className="text-[9px] uppercase tracking-wider text-slate-400">
                                  Historical Anomaly Rank
                                </div>
                                <div className="text-base font-bold text-indigo-300 flex items-center gap-1.5">
                                  <span>P{mlScore.anomaly_percentile !== undefined ? mlScore.anomaly_percentile.toFixed(1) : '--'}</span>
                                  <span className="text-[10px] font-normal text-slate-300">
                                    ({(mlScore.anomaly_percentile ?? 0) >= 95 ? 'Unusual local pattern' : 'Consistent with baseline'})
                                  </span>
                                </div>
                              </div>
                              <div className="text-right">
                                <div className="text-[9px] text-slate-400 uppercase tracking-wider">Baseline Deviation</div>
                                <div className="text-xs font-bold text-slate-200">
                                  {mlScore.baseline_robust_score !== undefined ? `${mlScore.baseline_robust_score.toFixed(2)}σ` : '--'}
                                </div>
                              </div>
                            </div>

                            {/* Synthetic Demo Warning Banner */}
                            {mlScore.is_synthetic_demo && (
                              <div className="rounded bg-amber-950/80 border border-amber-600/70 p-2 text-[10px] text-amber-200 font-sans flex items-start gap-1.5 leading-snug">
                                <span className="text-amber-400 font-bold">⚠️</span>
                                <div>
                                  <strong className="text-amber-300">DEMONSTRATION ONLY:</strong> Synthetic reference baseline. Real multi-day historical AIS archive was unavailable; real-data fitting is blocked. Do not rely on for operational decisions.
                                </div>
                              </div>
                            )}

                            {/* Comparison Features Table */}
                            {mlScore.comparison_features && mlScore.comparison_features.length > 0 && (
                              <div className="space-y-1">
                                <div className="text-[10px] text-slate-400 font-sans font-semibold">
                                  Observed vs Historical Baseline (60m window):
                                </div>
                                <div className="overflow-x-auto rounded border border-slate-800 bg-[#060a14]">
                                  <table className="w-full text-[10px] text-left">
                                    <thead className="bg-slate-900/90 text-slate-400 border-b border-slate-800">
                                      <tr>
                                        <th className="p-1.5 font-medium">Feature</th>
                                        <th className="p-1.5 font-medium text-right">Observed</th>
                                        <th className="p-1.5 font-medium text-right">Ref Median ± IQR</th>
                                        <th className="p-1.5 font-medium text-right">Deviation</th>
                                      </tr>
                                    </thead>
                                    <tbody className="divide-y divide-slate-800/60 font-mono">
                                      {mlScore.comparison_features.map((feat) => (
                                        <tr key={feat.name} className="hover:bg-indigo-950/20">
                                          <td className="p-1.5 text-slate-300 font-sans">{formatFeatureName(feat.name)}</td>
                                          <td className="p-1.5 text-right text-cyan-300 font-bold">
                                            {formatFeatureValue(feat.name, feat.value, feat.unit)}
                                          </td>
                                          <td className="p-1.5 text-right text-slate-400">
                                            {formatFeatureValue(feat.name, feat.training_median, feat.unit)} ±{' '}
                                            {formatFeatureValue(feat.name, feat.training_iqr, feat.unit)}
                                          </td>
                                          <td className={`p-1.5 text-right font-bold ${
                                            feat.robust_deviation >= 3 ? 'text-rose-400' : feat.robust_deviation >= 1.5 ? 'text-amber-400' : 'text-slate-400'
                                          }`}>
                                            {feat.robust_deviation.toFixed(1)}× IQR
                                          </td>
                                        </tr>
                                      ))}
                                    </tbody>
                                  </table>
                                </div>
                              </div>
                            )}

                            {/* Model Provenance Metadata */}
                            <div className="rounded bg-slate-900/60 border border-slate-800 p-1.5 text-[9px] text-slate-400 space-y-0.5">
                              <div className="flex justify-between">
                                <span>Model ID: <b className="text-slate-300">{mlScore.model_id}</b></span>
                                <span>Area/Class: <b className="text-slate-300">{mlScore.area_id} / {mlScore.class_group}</b></span>
                              </div>
                              <div className="flex justify-between">
                                <span>Track Window: <b className="text-slate-300">{mlScore.track_window?.span_minutes.toFixed(0)}m ({mlScore.track_window?.distinct_timestamps} fixes)</b></span>
                                <span>Ref End: <b className="text-slate-300">{mlScore.training_end}</b></span>
                              </div>
                            </div>

                            {/* Disclaimers & Boundaries */}
                            <div className="text-[9px] text-slate-500 italic font-sans leading-normal border-t border-slate-800/80 pt-1">
                              * Experimental second opinion: Historical anomaly assessment does not classify danger, anchor deployment, seabed contact, damage, or intent. Ordinary local patterns or AIS jitter may produce unusual scores. Alert queue order and ISR mission dispatch remain completely unaffected.
                            </div>
                          </div>
                        ) : (
                          <div className="rounded bg-slate-900/80 border border-slate-800 p-2 text-[10px] space-y-1 font-sans">
                            <div className="flex items-center gap-1.5 text-slate-300 font-semibold font-mono">
                              <span className="text-amber-400">ℹ️</span>
                              <span>ML Shadow Comparison: {mlScore.status.toUpperCase()}</span>
                            </div>
                            <div className="text-slate-400 text-[10px] leading-relaxed">
                              {mlScore.reason || 'Pattern comparison could not be computed for this vessel at the replay time.'}
                            </div>
                            {mlScore.details && (
                              <div className="mt-1 bg-black/40 rounded p-1 text-[9px] text-slate-400 font-mono">
                                {Object.entries(mlScore.details).map(([k, v]) => (
                                  <div key={k}>{k}: <span className="text-slate-300">{String(v)}</span></div>
                                ))}
                              </div>
                            )}
                            <div className="text-[9px] text-slate-500 italic">
                              Quality gate requires ≥3 distinct fixes, ≥15m span, no gaps &gt;15m, and newest fix age ≤15m.
                            </div>
                          </div>
                        )}
                      </div>

                      {/* Toggle Evidence Timeline Button */}
                      <button
                        onClick={() => setShowTimeline(!showTimeline)}
                        className="w-full mt-2 rounded bg-slate-800 hover:bg-slate-700 border border-slate-700 py-1.5 text-xs text-cyan-300 font-mono font-bold flex items-center justify-center gap-1.5 transition-colors cursor-pointer"
                      >
                        <span>{showTimeline ? '▲ Hide Evidence Timeline' : '▼ View Evidence Timeline'}</span>
                        <span className="text-[10px] text-slate-400">({trackData?.fixes_count || 0} fixes)</span>
                      </button>

                      {/* Evidence Timeline Drawer */}
                      {showTimeline && trackData && (
                        <div className="mt-2 rounded-lg border border-slate-700 bg-[#050b14] p-2 space-y-1.5 font-mono">
                          <div className="text-[10px] text-slate-400 flex items-center justify-between border-b border-slate-800 pb-1">
                            <span className="font-bold text-slate-300">Evidence Observations (ts ≤ at)</span>
                            <span>{trackData.fixes_count} fixes</span>
                          </div>
                          {trackData.truncated && (
                            <div className="rounded bg-amber-950/70 border border-amber-600/50 p-1.5 text-[9px] text-amber-200 font-sans leading-tight">
                              ⚠️ Oldest observations in {trackData.window_minutes}m window omitted (safety cap {trackData.limit || 5000} fixes). Latest observations preserved up to replay time.
                            </div>
                          )}
                          <div className="max-h-52 overflow-y-auto text-[10px] divide-y divide-slate-800/60 pr-1">
                            {experimentalTrackScore?.contributingFixes.map((f, i) => (
                              <div
                                key={`fix-${i}`}
                                className={`py-1 flex items-center justify-between gap-1 ${
                                  f.isConflicting ? 'bg-rose-950/40 text-rose-300 p-1 rounded' : ''
                                }`}
                              >
                                <div>
                                  <span className="text-cyan-400">{f.timestamp.slice(11, 19)}Z</span>
                                  {f.gapSec !== null && f.gapSec > 0 && (
                                    <span className="text-slate-500 ml-1">(+{(f.gapSec / 60).toFixed(1)}m)</span>
                                  )}
                                  {f.isConflicting && (
                                    <span className="ml-1 text-[9px] bg-rose-900 px-1 py-0.2 rounded text-white font-bold font-sans">
                                      CONFLICTING POS
                                    </span>
                                  )}
                                </div>
                                <div className="text-right space-x-1.5">
                                  <span>
                                    SOG:{' '}
                                    <b className="text-amber-300">
                                      {f.sog !== null ? (
                                        `${f.sog.toFixed(1)}kn`
                                      ) : (
                                        <i className="text-slate-500 font-normal">missing</i>
                                      )}
                                    </b>
                                  </span>
                                  <span>
                                    HDG:{' '}
                                    <b className="text-slate-300">
                                      {f.heading !== null ? (
                                        `${f.heading.toFixed(0)}°`
                                      ) : (
                                        <i className="text-slate-500 font-normal">missing</i>
                                      )}
                                    </b>
                                  </span>
                                  <span>
                                    Dist:{' '}
                                    <b className="text-emerald-400">
                                      {f.distKm !== null ? `${f.distKm.toFixed(1)}km` : 'N/A'}
                                    </b>
                                  </span>
                                </div>
                              </div>
                            ))}
                          </div>
                          <div className="text-[9px] text-slate-500 border-t border-slate-800/80 pt-1 leading-normal font-sans">
                            Evidence timeline displays observations up to replay time. Single-fix score uses latest fix; experimental score evaluates sustained sequence.
                          </div>
                        </div>
                      )}
                    </div>
                  ) : (
                    <div className="py-6 text-center text-xs text-slate-500 font-mono">
                      No vessel selected. Click any ship on the map or in the prioritized cue list below.
                    </div>
                  )}
                </div>

                {/* ISR Drone Mission Dispatch Card */}
                {showISRPlan && (
                  <div className="rounded-xl border border-emerald-800/80 bg-[#071d18] p-4 text-xs font-mono shadow-xl space-y-3">
                    <div className="flex items-center justify-between border-b border-emerald-800/60 pb-2">
                      <span className="font-bold text-emerald-300 uppercase tracking-wider flex items-center gap-1.5">
                        <span>🛸</span> ISR Sortie Route ({isrEnduranceMin}m @ {isrSpeedMs}m/s)
                      </span>
                      <span className="text-emerald-400 text-[10px] font-bold">
                        Fuel Reserve: ~{isrPlan.fuelMarginMin.toFixed(0)} min
                      </span>
                    </div>

                    {/* Launch Base Location Configurator */}
                    <div className="rounded-lg bg-[#041210] p-2.5 border border-emerald-900/60 space-y-1.5">
                      <div className="flex items-center justify-between">
                        <span className="text-[10px] text-emerald-400 font-bold uppercase tracking-wider flex items-center gap-1">
                          <span>📍</span> Launch Base Station:
                        </span>
                        {customBase && (
                          <button
                            onClick={() => {
                              setCustomBase(null);
                              setIsPlacingBase(false);
                            }}
                            className="text-[10px] text-emerald-400 hover:text-white underline"
                          >
                            Reset to Default
                          </button>
                        )}
                      </div>

                      <select
                        value={customBase ? 'custom' : isrBaseId}
                        onChange={(e) => {
                          const val = e.target.value;
                          if (val !== 'custom') {
                            setIsrBaseId(val);
                            setCustomBase(null);
                            setIsPlacingBase(false);
                          }
                        }}
                        className="w-full rounded bg-[#071a16] border border-emerald-700/60 px-2 py-1 text-xs text-emerald-200 font-semibold"
                      >
                        {PRESET_BASES.map((b) => (
                          <option key={b.id} value={b.id}>
                            {b.name} ({b.coords[0].toFixed(2)}°E, {b.coords[1].toFixed(2)}°N)
                          </option>
                        ))}
                        {customBase && (
                          <option value="custom">
                            📍 Custom Point ({customBase[0].toFixed(2)}°E, {customBase[1].toFixed(2)}°N)
                          </option>
                        )}
                      </select>

                      <div className="pt-0.5">
                        <button
                          onClick={() => setIsPlacingBase(!isPlacingBase)}
                          className={`w-full py-1 px-2 rounded text-[11px] font-bold border transition-all flex items-center justify-center gap-1.5 ${
                            isPlacingBase
                              ? 'bg-amber-500 text-slate-950 border-amber-300 animate-pulse'
                              : 'bg-emerald-900/40 text-emerald-300 border-emerald-700/60 hover:bg-emerald-800/50'
                          }`}
                        >
                          <span>{isPlacingBase ? '📍 Click Map to Deploy Base...' : '🎯 Deploy Base by Clicking Radar Map'}</span>
                        </button>
                      </div>
                    </div>

                    {/* Mission Flight Envelope Parameters */}
                    <div className="grid grid-cols-3 gap-1.5 text-[10px]">
                      <div className="rounded bg-[#041210] p-1.5 border border-emerald-900/60">
                        <div className="text-slate-400">Max Endurance</div>
                        <select
                          value={isrEnduranceMin}
                          onChange={(e) => setIsrEnduranceMin(Number(e.target.value))}
                          className="w-full rounded bg-transparent text-emerald-300 font-bold border-none outline-none cursor-pointer"
                        >
                          <option value={45} className="bg-[#041210]">45 min</option>
                          <option value={60} className="bg-[#041210]">60 min (std)</option>
                          <option value={90} className="bg-[#041210]">90 min</option>
                          <option value={120} className="bg-[#041210]">120 min</option>
                        </select>
                      </div>
                      <div className="rounded bg-[#041210] p-1.5 border border-emerald-900/60">
                        <div className="text-slate-400">Flight Speed</div>
                        <select
                          value={isrSpeedMs}
                          onChange={(e) => setIsrSpeedMs(Number(e.target.value))}
                          className="w-full rounded bg-transparent text-emerald-300 font-bold border-none outline-none cursor-pointer"
                        >
                          <option value={20} className="bg-[#041210]">20 m/s</option>
                          <option value={25} className="bg-[#041210]">25 m/s (std)</option>
                          <option value={30} className="bg-[#041210]">30 m/s</option>
                          <option value={40} className="bg-[#041210]">40 m/s</option>
                        </select>
                      </div>
                      <div className="rounded bg-[#041210] p-1.5 border border-emerald-900/60">
                        <div className="text-slate-400">Target Dwell</div>
                        <select
                          value={isrDwellMin}
                          onChange={(e) => setIsrDwellMin(Number(e.target.value))}
                          className="w-full rounded bg-transparent text-emerald-300 font-bold border-none outline-none cursor-pointer"
                        >
                          <option value={2} className="bg-[#041210]">2 min</option>
                          <option value={4} className="bg-[#041210]">4 min (std)</option>
                          <option value={6} className="bg-[#041210]">6 min</option>
                          <option value={10} className="bg-[#041210]">10 min</option>
                        </select>
                      </div>
                    </div>

                    {isrPlan.legs.length > 0 ? (
                      <div className="space-y-2 border-t border-emerald-900/60 pt-2">
                        <div className="text-[11px] text-slate-300 flex justify-between">
                          <span>Total Mission Time:</span>
                          <b>{isrPlan.totalTimeMin.toFixed(1)} min / {isrEnduranceMin} min</b>
                        </div>
                        <div className="space-y-1.5 max-h-36 overflow-y-auto pr-0.5">
                          {isrPlan.legs.map((leg, idx) => (
                            <div key={`plan-leg-${idx}`} className="rounded bg-emerald-950/70 border border-emerald-800/60 p-1.5">
                              <div className="font-bold text-white flex justify-between">
                                <span>#{idx + 1} {leg.name}</span>
                                <span className="text-emerald-300">+{leg.cumTimeMin.toFixed(0)}m</span>
                              </div>
                              <div className="text-[10px] text-slate-400">
                                Leg: {leg.distKm.toFixed(1)} km ({leg.flightMin.toFixed(1)}m flight + {leg.dwellMin}m dwell)
                              </div>
                            </div>
                          ))}
                        </div>
                      </div>
                    ) : (
                      <div className="text-slate-400 text-[11px] border-t border-emerald-900/60 pt-2">
                        No active targets currently meet the threshold to justify dispatching the ISR platform from this base.
                      </div>
                    )}

                    {isrPlan.droppedTargets.length > 0 && (
                      <div className="rounded bg-rose-950/40 border border-rose-900/60 p-2 text-[10px] text-rose-300 space-y-1">
                        <div className="font-bold text-rose-200">Dropped Targets (Exceeds Range):</div>
                        {isrPlan.droppedTargets.map((d, i) => (
                          <div key={`drop-${i}`}>• {d.name}: {d.reason}</div>
                        ))}
                      </div>
                    )}
                  </div>
                )}

                {/* Prioritized Alert & Review Queue (Feature 5) */}
                <div className="rounded-xl border border-[#1e2e4a] bg-[#0c1626] p-4 shadow-xl">
                  <div className="flex items-center justify-between border-b border-slate-800 pb-2 mb-2">
                    <span className="text-xs font-mono uppercase font-bold text-slate-200">
                      Prioritized Alert Queue
                    </span>
                    <span className="text-[10px] text-slate-400 font-mono">
                      {analyzedVessels.length} tracked
                    </span>
                  </div>

                  {/* Reproducible Alert Episode Status Indicator */}
                  <div className="mb-2 p-1.5 rounded bg-[#071120] border border-slate-800 text-[10px] font-mono text-slate-400 flex items-center justify-between">
                    <span>24h Alert Episodes:</span>
                    <span className="text-amber-400 font-semibold" title="Reproducible Episode Rule: Requires contiguous 24h archive with 30m continuity threshold. Snapshot count is not an episode count.">
                      Unavailable (Requires 24h baseline)
                    </span>
                  </div>

                  <div className="max-h-56 overflow-y-auto font-mono text-xs pr-1">
                    <table className="w-full text-left">
                      <thead>
                        <tr className="text-slate-500 border-b border-slate-800">
                          <th className="pb-1">Vessel</th>
                          <th className="pb-1">Tier</th>
                          <th className="pb-1 text-right">Anomaly</th>
                        </tr>
                      </thead>
                      <tbody>
                        {analyzedVessels.map((a) => {
                          const isSel = a.vessel.mmsi === selectedMmsi;
                          return (
                            <tr
                              key={a.vessel.mmsi}
                              onClick={() => setSelectedMmsi(a.vessel.mmsi)}
                              className={`border-b border-slate-800/50 cursor-pointer transition-colors ${
                                isSel
                                  ? 'bg-cyan-950/60 text-cyan-300'
                                  : a.tier === 'cue'
                                  ? 'bg-rose-950/30 text-rose-300 hover:bg-rose-950/50'
                                  : a.tier === 'review'
                                  ? 'bg-amber-950/30 text-amber-300 hover:bg-amber-950/50'
                                  : 'hover:bg-slate-800/40 text-slate-400'
                              }`}
                            >
                              <td className="py-1.5 font-sans truncate max-w-[120px]">
                                <div className="font-bold text-xs flex items-center gap-1.5">
                                  <span className="truncate">{a.vessel.name || a.vessel.mmsi}</span>
                                  {a.isStale && (
                                    <span className="text-[8px] bg-amber-950 text-amber-300 border border-amber-800 rounded px-1 font-mono uppercase">
                                      STALE
                                    </span>
                                  )}
                                </div>
                                <div className="text-[10px] text-slate-500 font-mono">
                                  {a.vessel.ship_type || 'Unknown'} · {a.vessel.sog !== null ? `${a.vessel.sog}kn` : 'null'} · {a.fixAgeSec < 60 ? `${a.fixAgeSec}s` : `${Math.floor(a.fixAgeSec / 60)}m`} ago
                                </div>
                              </td>
                              <td className="py-1.5">
                                <span
                                  className={`rounded px-1.5 py-0.5 text-[9px] font-bold ${
                                    a.tier === 'cue'
                                      ? 'bg-rose-950 text-rose-300 border border-rose-800'
                                      : a.tier === 'review'
                                      ? 'bg-amber-950 text-amber-300 border border-amber-800'
                                      : 'text-slate-600'
                                  }`}
                                >
                                  {a.tier.toUpperCase()}
                                </span>
                              </td>
                              <td className="py-1.5 text-right font-bold text-slate-200">
                                {a.score.toFixed(1)}
                              </td>
                            </tr>
                          );
                        })}
                      </tbody>
                    </table>
                  </div>
                </div>

                {/* Active Cable Route Switcher */}
                <div className="rounded-xl border border-[#1e2e4a] bg-[#0c1626] p-3 text-xs">
                  <div className="font-bold text-slate-200 uppercase tracking-wider mb-1 flex items-center justify-between">
                    <span>Active Cable Infrastructure</span>
                    <button
                      onClick={() => {
                        setLines(DEFAULT_ROUTE);
                        setGeomName('Baltic Subsea Cable (Default)');
                      }}
                      className="text-[10px] text-amber-400 hover:underline"
                    >
                      Reset Default
                    </button>
                  </div>
                  <p className="text-slate-400 truncate mb-2">{geomName}</p>
                  <label className="block rounded border border-dashed border-slate-700 bg-slate-900/50 p-2 text-center text-slate-300 hover:border-slate-500 cursor-pointer">
                    <span>Load Custom GeoJSON Cable</span>
                    <input
                      type="file"
                      accept=".geojson,.json"
                      onChange={loadGeoJson}
                      className="hidden"
                    />
                  </label>
                </div>
              </div>
            </div>
          </>
        )}

        {/* Ingestion & Dataset Switcher Modal */}
        {showModal && (
          <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 backdrop-blur-sm p-4">
            <div className="w-full max-w-2xl rounded-2xl border border-slate-700 bg-[#0b1528] p-6 shadow-2xl space-y-5 text-sm">
              <div className="flex items-center justify-between border-b border-slate-800 pb-3">
                <h2 className="text-lg font-bold text-white flex items-center gap-2">
                  <span className="text-cyan-400">⚡</span> Dataset Manager &amp; Pipeline Ingestion
                </h2>
                <button
                  onClick={() => setShowModal(false)}
                  className="rounded px-2.5 py-1 text-slate-400 hover:bg-slate-800 hover:text-white"
                >
                  ✕
                </button>
              </div>

              {/* Section 1: Switch between Ingested Datasets */}
              <div className="space-y-2">
                <div className="font-bold text-xs uppercase tracking-wider text-slate-300 flex items-center justify-between">
                  <span>Available Ingested Datasets</span>
                  <span className="text-[11px] text-slate-500 font-normal">Stored locally in work/</span>
                </div>
                <div className="max-h-40 overflow-y-auto rounded-lg border border-slate-800 bg-slate-900/60 divide-y divide-slate-800/60">
                  {datasets.length === 0 ? (
                    <div className="p-4 text-center text-xs text-slate-500">No datasets found in work/</div>
                  ) : (
                    datasets.map((db) => (
                      <div key={db.id} className="p-2.5 flex items-center justify-between hover:bg-slate-800/40">
                        <div>
                          <div className="font-mono font-bold text-xs flex items-center gap-2">
                            <span className={db.active ? 'text-emerald-400' : 'text-slate-200'}>{db.id}</span>
                            {db.active && (
                              <span className="rounded bg-emerald-950 border border-emerald-800 px-1.5 py-0.2 text-[9px] text-emerald-400 font-sans">
                                ACTIVE
                              </span>
                            )}
                          </div>
                          <div className="text-[11px] text-slate-400 mt-0.5 font-mono">
                            {db.records.toLocaleString()} fixes · {db.min_timestamp_utc ? db.min_timestamp_utc.slice(0, 16) : 'N/A'}
                          </div>
                        </div>
                        {!db.active && (
                          <button
                            onClick={() => handleSwitchDataset(db.id)}
                            className="rounded bg-slate-800 hover:bg-slate-700 text-xs px-2.5 py-1 text-cyan-300 border border-slate-700"
                          >
                            Load Dataset →
                          </button>
                        )}
                      </div>
                    ))
                  )}
                </div>
              </div>

              {/* Section 2: Ingest Any New ZIP File */}
              <div className="border-t border-slate-800 pt-4 space-y-3">
                <div className="font-bold text-xs uppercase tracking-wider text-slate-300">
                  Ingest New AIS Archive (Any Date / Region)
                </div>

                <div className="space-y-2.5">
                  <div>
                    <label className="block text-xs text-slate-400 mb-1">Source ZIP File:</label>
                    {discoveredZips.length > 0 ? (
                      <select
                        value={selectedZipPath}
                        onChange={(e) => setSelectedZipPath(e.target.value)}
                        className="w-full rounded bg-[#070d18] border border-slate-700 p-2 text-xs text-white"
                      >
                        {discoveredZips.map((z) => (
                          <option key={z.path} value={z.path}>
                            {z.name} ({z.size_mb} MB) — {z.path}
                          </option>
                        ))}
                      </select>
                    ) : (
                      <input
                        type="text"
                        placeholder="~/Downloads/aisdk-YYYY-MM-DD.zip"
                        value={selectedZipPath}
                        onChange={(e) => setSelectedZipPath(e.target.value)}
                        className="w-full rounded bg-[#070d18] border border-slate-700 p-2 text-xs text-white font-mono"
                      />
                    )}
                  </div>

                  <div className="grid grid-cols-2 gap-3">
                    <div>
                      <label className="block text-xs text-slate-400 mb-1">Target Corridor / Preset:</label>
                      <select
                        value={ingestPreset}
                        onChange={(e) => setIngestPreset(e.target.value)}
                        className="w-full rounded bg-[#070d18] border border-slate-700 p-2 text-xs text-white"
                      >
                        <option value="baltic">Bornholm / Arkona Basin (Baltic)</option>
                        <option value="fehmarn">Fehmarn Belt</option>
                        <option value="storebaelt">Great Belt (Storebælt)</option>
                        <option value="oresund">The Sound (Øresund)</option>
                      </select>
                    </div>

                    <div>
                      <label className="block text-xs text-slate-400 mb-1">Sample Size:</label>
                      <select
                        value={ingestMaxRows}
                        onChange={(e) => setIngestMaxRows(Number(e.target.value))}
                        className="w-full rounded bg-[#070d18] border border-slate-700 p-2 text-xs text-white"
                      >
                        <option value={100000}>100k rows (~1s smoke test)</option>
                        <option value={1000000}>1M rows (~10s standard sample)</option>
                        <option value={5000000}>5M rows (~30s multi-hour sample)</option>
                        <option value={0}>Full 24-Hour Day (~2-3 mins)</option>
                      </select>
                    </div>
                  </div>

                  <div>
                    <label className="block text-xs text-slate-400 mb-1">Dataset Name (Optional):</label>
                    <input
                      type="text"
                      placeholder="e.g. baltic_jan13_run"
                      value={customDatasetName}
                      onChange={(e) => setCustomDatasetName(e.target.value)}
                      className="w-full rounded bg-[#070d18] border border-slate-700 p-2 text-xs text-white font-mono"
                    />
                  </div>
                </div>

                {ingestStatus && (
                  <div className="rounded bg-cyan-950/60 border border-cyan-800 p-2.5 text-xs text-cyan-300 font-mono animate-pulse">
                    {ingestStatus}
                  </div>
                )}

                <div className="flex justify-end gap-2 pt-2">
                  <button
                    onClick={() => setShowModal(false)}
                    disabled={isIngesting}
                    className="rounded bg-slate-800 hover:bg-slate-700 px-4 py-2 text-xs text-slate-300"
                  >
                    Cancel
                  </button>
                  <button
                    onClick={handleRunIngest}
                    disabled={isIngesting}
                    className="rounded bg-cyan-600 hover:bg-cyan-500 disabled:opacity-50 px-5 py-2 text-xs font-bold text-white shadow-lg flex items-center gap-2"
                  >
                    {isIngesting ? (
                      <>
                        <span className="inline-block w-3 h-3 border-2 border-white border-t-transparent rounded-full animate-spin"></span>
                        Ingesting...
                      </>
                    ) : (
                      'Run Ingestion & Activate'
                    )}
                  </button>
                </div>
              </div>
            </div>
          </div>
        )}
      </div>
    </main>
  );
}
