import { useEffect, useMemo, useRef, useState } from 'react';
import { evaluateTrackScore, type ExperimentalTrackResult, type TrackFix } from '@/lib/cablewatch/track_score';
import { localAis } from './api';
import { analyzeVessels, planIsr } from './analysis';
import {
  BALTIC_CORRIDOR_NETWORK,
  DEFAULT_ROUTE,
  PRESET_BASES,
  SECTOR_CONFIG,
  geometry,
  type AnomalyResult,
  type Dataset,
  type DiscoveredZip,
  type ISRPlan,
  type Lines,
  type MLScoreResponse,
  type Meta,
  type SectorId,
  type Snapshot,
  type SubseaFeature,
  type XY,
} from './model';

// State, effects and derived data of the AIS replay page. The logic is carried over unchanged from the original
// `src/app/real/page.tsx`; only the transport (`localAis('…')` -> `localAis('…')`) and the module
// layout differ so that the presentation can be rebuilt independently.
export function useRadar() {
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
    return (import.meta as any).env?.VITE_ENABLE_ML_SHADOW === 'true';
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

  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null);

  // Load Metadata
  const refreshMeta = () => {
    localAis('meta')
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
        localAis('datasets'),
        localAis('find-zips')
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
          const aisdkZip = zips.find((z: DiscoveredZip) => z.name.toLowerCase().startsWith('aisdk'));
          setSelectedZipPath((aisdkZip || zips[0]).path);
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
      const res = await localAis(`switch?db=${encodeURIComponent(dbId)}`);
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
      const res = await localAis('ingest', {
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

  const cancelIngest = async () => {
    try {
      await localAis('abort-ingest', { method: 'POST' });
    } catch {}
    setIsIngesting(false);
    setIngestStatus('');
  };

  const inFlightRef = useRef(false);

  // Fetch Snapshot at timestamp with backpressure protection
  useEffect(() => {
    if (!at) return;
    setBusy(true);
    inFlightRef.current = true;
    localAis(`snapshot?at=${encodeURIComponent(at)}&window=${win}`)
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
    localAis(`track?mmsi=${encodeURIComponent(selectedMmsi)}&at=${encodeURIComponent(at)}&window=120`)
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

    localAis(`ml-score?mmsi=${encodeURIComponent(selectedMmsi)}&at=${encodeURIComponent(at)}`)
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

  const analyzedVessels: AnomalyResult[] = useMemo(
    () => analyzeVessels(snap, lines, corridorKm, at),
    [snap, lines, corridorKm, at]
  );

  const isrPlan: ISRPlan = useMemo(
    () => planIsr(analyzedVessels, isrBase, isrSpeedMs, isrEnduranceMin, isrDwellMin),
    [analyzedVessels, isrBase, isrSpeedMs, isrEnduranceMin, isrDwellMin]
  );

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
  const alertCounts = useMemo(() => {
    let cues = 0;
    let reviews = 0;
    for (const a of analyzedVessels) {
      if (a.tier === 'cue') cues++;
      else if (a.tier === 'review') reviews++;
    }
    return { cues, reviews };
  }, [analyzedVessels]);

  // ---- view actions (unchanged behaviour of the original sector / corridor controls) ------------------------------
  const resetView = () => {
    setZoom(1);
    setPan({ x: 0, y: 0 });
  };

  const focusSector = (secKey: SectorId) => {
    setSector(secKey);
    setGeomName('ALL');
    setActiveCorridors(BALTIC_CORRIDOR_NETWORK);
    setLines(BALTIC_CORRIDOR_NETWORK.map((f) => f.coords));
    setZoom(1);
    setPan({ x: 0, y: 0 });
  };

  const selectCorridor = (val: string) => {
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
  };

  const resetDefaultRoute = () => {
    setLines(DEFAULT_ROUTE);
    setGeomName('Baltic Subsea Cable (Default)');
  };

  const toggleMLShadow = () => {
    const next = !enableMLShadow;
    setEnableMLShadow(next);
    if (typeof window !== 'undefined') {
      localStorage.setItem('cablewatch_enable_ml_shadow', String(next));
    }
  };

  return {
    // data
    meta, snap, setSnap, at, setAt, win, setWin, busy, error, setError,
    activeCorridors, lines, geomName, corridorKm, setCorridorKm,
    selectedMmsi, setSelectedMmsi, trackData, trackLoading, showTimeline, setShowTimeline,
    enableMLShadow, toggleMLShadow, mlScore, mlLoading,
    isPlaying, setIsPlaying, playbackSpeed, setPlaybackSpeed,
    sector, bounds, zoom, setZoom, pan, setPan, isDragging, setIsDragging, dragStartRef,
    showISRPlan, setShowISRPlan, isrBaseId, setIsrBaseId, customBase, setCustomBase,
    isrSpeedMs, setIsrSpeedMs, isrEnduranceMin, setIsrEnduranceMin, isrDwellMin, setIsrDwellMin,
    isPlacingBase, setIsPlacingBase, isrBase, isrBaseName, isrPlan,
    showModal, setShowModal, datasets, discoveredZips, selectedZipPath, setSelectedZipPath,
    ingestPreset, setIngestPreset, ingestMaxRows, setIngestMaxRows, customDatasetName, setCustomDatasetName,
    isIngesting, ingestStatus,
    analyzedVessels, selectedVessel, experimentalTrackScore, alertCounts,
    minSec, maxSec, curSec,
    // actions
    refreshMeta, handleSwitchDataset, handleRunIngest, cancelIngest, loadGeoJson,
    resetView, focusSector, selectCorridor, resetDefaultRoute,
    PRESET_BASES, SECTOR_CONFIG,
  };
}

export type Radar = ReturnType<typeof useRadar>;

