import { useEffect, useMemo, useRef, useState } from 'react';
import { cn } from '@/utils/cn';
import type { Radar } from '@/lib/radar/useRadar';
import { SECTOR_CONFIG, type SectorId, type XY } from '@/lib/radar/model';
import { GEO_LABELS, LAND_RINGS } from '@/lib/radar/land';
import { Icon, IconButton, VESSEL_PATH, vesselVisuals } from '@/components/ui';

const SECTOR_ORDER: SectorId[] = ['fit-data', 'bornholm', 'fehmarn', 'storebaelt', 'oresund', 'kattegat', 'all'];
const MIN_ZOOM = 0.15;
const MAX_ZOOM = 12;
const GRID_STEPS = [10, 5, 2, 1, 0.5, 0.25, 0.1, 0.05, 0.02, 0.01];
const SCALE_STEPS = [1, 2, 5, 10, 20, 50, 100, 200, 500];

function fmtLat(v: number) {
  const a = Math.abs(v);
  return `${Number.isInteger(a) ? a : a.toFixed(2).replace(/0+$/, '')}°${v >= 0 ? 'N' : 'S'}`;
}
function fmtLon(v: number) {
  const a = Math.abs(v);
  return `${Number.isInteger(a) ? a : a.toFixed(2).replace(/0+$/, '')}°${v >= 0 ? 'E' : 'W'}`;
}

export function MapCanvas({ r, detailOpen }: { r: Radar; detailOpen: boolean }) {
  const wrapRef = useRef<HTMLDivElement>(null);
  const svgRef = useRef<SVGSVGElement>(null);
  const [size, setSize] = useState({ w: 960, h: 560 });
  const [hover, setHover] = useState<{ mmsi: string; x: number; y: number } | null>(null);
  const movedRef = useRef(0);

  const { bounds, zoom, pan } = r;

  useEffect(() => {
    const el = wrapRef.current;
    if (!el) return;
    const ro = new ResizeObserver(() => {
      const b = el.getBoundingClientRect();
      if (b.width > 0 && b.height > 0) setSize({ w: b.width, h: b.height });
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  /* ---- projection: aspect-correct fit of `bounds`, then pan / zoom about the viewport centre ---- */
  const fit = useMemo(() => {
    const b = bounds ?? SECTOR_CONFIG.all.bbox;
    const topPad = 68;
    const botPad = 52;
    const side = 56;
    const midLat = (b.miny + b.maxy) / 2;
    const midLon = (b.minx + b.maxx) / 2;
    const cosLat = Math.cos((midLat * Math.PI) / 180);
    const dx = Math.max(b.maxx - b.minx, 0.002) * cosLat;
    const dy = Math.max(b.maxy - b.miny, 0.002);
    const availW = Math.max(size.w - 2 * side, 120);
    const availH = Math.max(size.h - topPad - botPad, 120);
    const s = Math.min(availW / dx, availH / dy); // px per degree of latitude
    return { s, cosLat, midLon, midLat, cx: size.w / 2, cy: topPad + availH / 2 };
  }, [bounds, size]);

  const view = useRef({ zoom, pan, size, fit });
  view.current = { zoom, pan, size, fit };

  const toBase = (lon: number, lat: number): XY => [
    fit.cx + (lon - fit.midLon) * fit.cosLat * fit.s,
    fit.cy - (lat - fit.midLat) * fit.s,
  ];
  const project = (p: XY): XY => {
    const [bx, by] = toBase(p[0], p[1]);
    return [size.w / 2 + pan.x + (bx - size.w / 2) * zoom, size.h / 2 + pan.y + (by - size.h / 2) * zoom];
  };
  const unproject = (sx: number, sy: number): XY => {
    const bx = (sx - size.w / 2 - pan.x) / zoom + size.w / 2;
    const by = (sy - size.h / 2 - pan.y) / zoom + size.h / 2;
    return [(bx - fit.cx) / (fit.cosLat * fit.s) + fit.midLon, fit.midLat - (by - fit.cy) / fit.s];
  };

  const pxPerKm = (fit.s / 111.32) * zoom;
  const bufferPx = Math.max(6, pxPerKm * r.corridorKm * 2);

  /* ---- wheel zoom about the cursor (needs a non-passive listener) ---- */
  useEffect(() => {
    const svg = svgRef.current;
    if (!svg) return;
    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      const v = view.current;
      const rect = svg.getBoundingClientRect();
      const mx = e.clientX - rect.left;
      const my = e.clientY - rect.top;
      const factor = e.deltaY < 0 ? 1.2 : 0.83;
      const z2 = Math.min(Math.max(v.zoom * factor, MIN_ZOOM), MAX_ZOOM);
      if (z2 === v.zoom) return;
      const bx = (mx - v.size.w / 2 - v.pan.x) / v.zoom + v.size.w / 2;
      const by = (my - v.size.h / 2 - v.pan.y) / v.zoom + v.size.h / 2;
      r.setZoom(z2);
      r.setPan({ x: mx - v.size.w / 2 - (bx - v.size.w / 2) * z2, y: my - v.size.h / 2 - (by - v.size.h / 2) * z2 });
    };
    svg.addEventListener('wheel', onWheel, { passive: false });
    return () => svg.removeEventListener('wheel', onWheel);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [r.setZoom, r.setPan]);

  const zoomBy = (factor: number) => {
    const z2 = Math.min(Math.max(zoom * factor, MIN_ZOOM), MAX_ZOOM);
    if (z2 === zoom) return;
    const k = z2 / zoom;
    r.setZoom(z2);
    r.setPan({ x: pan.x * k, y: pan.y * k }); // zoom about the viewport centre
  };

  /* ---- static layers ---- */
  const landPath = useMemo(() => {
    let d = '';
    for (const ring of LAND_RINGS) {
      for (let i = 0; i < ring.length; i++) {
        const [bx, by] = [fit.cx + (ring[i][0] - fit.midLon) * fit.cosLat * fit.s, fit.cy - (ring[i][1] - fit.midLat) * fit.s];
        d += (i === 0 ? 'M' : 'L') + bx.toFixed(1) + ' ' + by.toFixed(1);
      }
      d += 'Z';
    }
    return d;
  }, [fit]);

  const graticule = useMemo(() => {
    const tl = unproject(0, 0);
    const br = unproject(size.w, size.h);
    const lonSpan = Math.abs(br[0] - tl[0]);
    const step = GRID_STEPS.find((s) => lonSpan / s >= 5) ?? GRID_STEPS[GRID_STEPS.length - 1];
    const lons: number[] = [];
    const lats: number[] = [];
    for (let l = Math.ceil(tl[0] / step) * step; l <= br[0] + 1e-9 && lons.length < 60; l += step) lons.push(Number(l.toFixed(4)));
    for (let l = Math.ceil(br[1] / step) * step; l <= tl[1] + 1e-9 && lats.length < 60; l += step) lats.push(Number(l.toFixed(4)));
    return { lons, lats };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [fit, size, zoom, pan]);

  const scaleBar = useMemo(() => {
    let km = SCALE_STEPS[0];
    for (const s of SCALE_STEPS) if (s * pxPerKm <= 140) km = s;
    return { km, px: km * pxPerKm };
  }, [pxPerKm]);

  /* ---- vessels: render low priority first so alerts / selection sit on top ---- */
  const drawOrder = useMemo(() => {
    const list = [...r.analyzedVessels].reverse();
    const idx = list.findIndex((a) => a.vessel.mmsi === r.selectedMmsi);
    if (idx >= 0) list.push(list.splice(idx, 1)[0]);
    return list;
  }, [r.analyzedVessels, r.selectedMmsi]);

  const hovered = hover ? r.analyzedVessels.find((a) => a.vessel.mmsi === hover.mmsi) : null;

  const placeBase = (e: React.MouseEvent<SVGSVGElement>) => {
    if (!r.isPlacingBase) return;
    const rect = e.currentTarget.getBoundingClientRect();
    const [lon, lat] = unproject(e.clientX - rect.left, e.clientY - rect.top);
    r.setCustomBase([Number(lon.toFixed(4)), Number(lat.toFixed(4))]);
    r.setIsPlacingBase(false);
  };

  const cursor = r.isPlacingBase ? 'cursor-crosshair' : r.isDragging ? 'cursor-grabbing' : 'cursor-grab';
  const fitActive = r.sector === 'fit-data' && r.geomName === 'ALL';
  const allActive = r.sector === 'all' && r.geomName === 'ALL';

  return (
    <div ref={wrapRef} className="absolute inset-0 overflow-hidden bg-[#0b131f]">
      <svg
        ref={svgRef}
        width={size.w}
        height={size.h}
        role="img"
        aria-label="Operational AIS sector map with subsea infrastructure corridors, vessels and ISR sortie plan"
        className={cn('block select-none', cursor)}
        style={{ touchAction: 'none' }}
        onClick={placeBase}
        onPointerDown={(e) => {
          if (r.isPlacingBase || e.button !== 0) return;
          r.setIsDragging(true);
          movedRef.current = 0;
          r.dragStartRef.current = { x: e.clientX, y: e.clientY, panX: pan.x, panY: pan.y };
        }}
        onPointerMove={(e) => {
          if (!r.isDragging) return;
          const dx = e.clientX - r.dragStartRef.current.x;
          const dy = e.clientY - r.dragStartRef.current.y;
          movedRef.current = Math.max(movedRef.current, Math.hypot(dx, dy));
          r.setPan({ x: r.dragStartRef.current.panX + dx, y: r.dragStartRef.current.panY + dy });
        }}
        onPointerUp={() => r.setIsDragging(false)}
        onPointerLeave={() => {
          r.setIsDragging(false);
          setHover(null);
        }}
      >
        <defs>
          <radialGradient id="vignette" cx="50%" cy="50%" r="75%">
            <stop offset="60%" stopColor="#000" stopOpacity="0" />
            <stop offset="100%" stopColor="#000" stopOpacity="0.45" />
          </radialGradient>
        </defs>

        {/* sea */}
        <rect width={size.w} height={size.h} fill="#0b131f" />

        {/* graticule */}
        <g pointerEvents="none">
          {graticule.lons.map((lon) => {
            const x = project([lon, fit.midLat])[0];
            return (
              <g key={`lo-${lon}`}>
                <line x1={x} y1={0} x2={x} y2={size.h} stroke="#ffffff" strokeOpacity="0.045" />
                <text x={x + 4} y={size.h - 8} fontSize="9.5" fontFamily="ui-monospace, monospace" fill="#5d6c88">
                  {fmtLon(lon)}
                </text>
              </g>
            );
          })}
          {graticule.lats.map((lat) => {
            const y = project([fit.midLon, lat])[1];
            return (
              <g key={`la-${lat}`}>
                <line x1={0} y1={y} x2={size.w} y2={y} stroke="#ffffff" strokeOpacity="0.045" />
                <text x={6} y={y - 4} fontSize="9.5" fontFamily="ui-monospace, monospace" fill="#5d6c88">
                  {fmtLat(lat)}
                </text>
              </g>
            );
          })}
        </g>

        {/* land (zoom / pan applied as a group transform) */}
        <g transform={`translate(${size.w / 2 + pan.x} ${size.h / 2 + pan.y}) scale(${zoom}) translate(${-size.w / 2} ${-size.h / 2})`} pointerEvents="none">
          <path d={landPath} fill="#1a2536" stroke="#2d405f" strokeWidth="1" vectorEffect="non-scaling-stroke" fillRule="evenodd" strokeLinejoin="round" />
        </g>

        {/* geographic reference labels */}
        <g pointerEvents="none">
          {GEO_LABELS.map((g) => {
            const [x, y] = project([g.lon, g.lat]);
            if (x < -80 || x > size.w + 80 || y < -20 || y > size.h + 20) return null;
            const sea = g.kind === 'sea';
            return (
              <text
                key={g.text}
                x={x}
                y={y}
                textAnchor="middle"
                fontSize={sea ? 11 : 10.5}
                letterSpacing={sea ? 3 : 2}
                fontStyle={sea ? 'italic' : 'normal'}
                fontWeight={600}
                fill={sea ? '#3b5f8f' : '#55658a'}
                opacity={sea ? 0.8 : 0.9}
              >
                {g.text}
              </text>
            );
          })}
        </g>

        {/* subsea infrastructure corridors */}
        {r.activeCorridors.map((c, i) => {
          const pts = c.coords.map((p) => project(p));
          const pointsStr = pts.map((p) => `${p[0].toFixed(1)},${p[1].toFixed(1)}`).join(' ');
          const frac = c.labelFrac ?? 0.5;
          const idx = Math.min(Math.floor(c.coords.length * frac), c.coords.length - 1);
          const [mx, my] = pts[idx];
          const offX = c.labelOffset ? c.labelOffset[0] : 8;
          const offY = c.labelOffset ? c.labelOffset[1] : -6;
          let lenPx = 0;
          for (let k = 1; k < pts.length; k++) lenPx += Math.hypot(pts[k][0] - pts[k - 1][0], pts[k][1] - pts[k - 1][1]);
          const showLabel = r.activeCorridors.length === 1 || lenPx > 110;
          const label = c.name.toUpperCase();
          const pillW = label.length * 5.9 + 20;
          return (
            <g key={`corridor-${c.name}-${i}`}>
              {/* safety buffer ribbon */}
              <polyline points={pointsStr} fill="none" stroke={c.color} strokeOpacity="0.08" strokeWidth={bufferPx} strokeLinecap="round" strokeLinejoin="round" />
              <polyline points={pointsStr} fill="none" stroke={c.color} strokeOpacity="0.3" strokeWidth={bufferPx} strokeLinecap="round" strokeLinejoin="round" strokeDasharray="1 9" />
              {/* cable / pipe backbone */}
              <polyline points={pointsStr} fill="none" stroke="#080d16" strokeOpacity="0.7" strokeWidth="4.5" strokeLinecap="round" strokeLinejoin="round" />
              <polyline points={pointsStr} fill="none" stroke={c.color} strokeWidth="2.2" strokeDasharray="7 3" strokeLinecap="round" strokeLinejoin="round" />
              {[pts[0], pts[pts.length - 1]].map((p, k) => (
                <circle key={k} cx={p[0]} cy={p[1]} r="4.5" fill={c.color} stroke="#080d16" strokeWidth="2" />
              ))}
              {showLabel && (
                <g transform={`translate(${mx + offX} ${my + offY})`} pointerEvents="none">
                  <rect x="-4" y="-11" width={pillW} height="16" rx="8" fill="#080d16" fillOpacity="0.9" stroke={c.color} strokeOpacity="0.8" strokeWidth="1" />
                  <circle cx="4" cy="-3" r="2.2" fill={c.color} />
                  <text x="10" y="0.5" fill="#dfe6f3" fontSize="8.5" fontFamily="ui-monospace, monospace" fontWeight="700">
                    {label}
                  </text>
                </g>
              )}
            </g>
          );
        })}

        {/* ISR sortie path */}
        {r.showISRPlan && r.isrPlan.feasible && (
          <g pointerEvents="none">
            {r.isrPlan.legs.map((leg, i) => {
              const [fx, fy] = project(leg.from);
              const [tx, ty] = project(leg.to);
              return (
                <g key={`isr-leg-${i}`}>
                  <line x1={fx} y1={fy} x2={tx} y2={ty} stroke="#2ee6a6" strokeWidth="2.2" strokeDasharray="7 5" strokeOpacity="0.9" />
                  <circle cx={tx} cy={ty} r="12" fill="#06382b" stroke="#2ee6a6" strokeWidth="1.6" />
                  <text x={tx} y={ty + 3.5} fill="#fff" fontSize="10" fontWeight="700" textAnchor="middle">
                    #{i + 1}
                  </text>
                </g>
              );
            })}
            {r.isrPlan.legs.length > 0 &&
              (() => {
                const last = r.isrPlan.legs[r.isrPlan.legs.length - 1];
                const [lx, ly] = project(last.to);
                const [bx, by] = project(r.isrBase);
                return <line x1={lx} y1={ly} x2={bx} y2={by} stroke="#2ee6a6" strokeWidth="1.5" strokeDasharray="3 4" strokeOpacity="0.55" />;
              })()}
          </g>
        )}

        {/* ISR base */}
        {(() => {
          const [bx, by] = project(r.isrBase);
          const text = `ISR BASE · ${r.isrBaseName.toUpperCase()} (${r.isrSpeedMs}m/s)`;
          return (
            <g pointerEvents="none">
              <rect x={bx - 9} y={by - 9} width="18" height="18" rx="4" fill="#06382b" stroke="#2ee6a6" strokeWidth="1.8" />
              <circle cx={bx} cy={by} r="3" fill="#2ee6a6" />
              {r.showISRPlan && (
                <g transform={`translate(${bx + 14} ${by - 8})`}>
                  <rect width={text.length * 5.6 + 14} height="16" rx="8" fill="#080d16" fillOpacity="0.92" stroke="#2ee6a6" strokeOpacity="0.7" />
                  <text x="8" y="11.2" fill="#7df0c6" fontSize="8.5" fontFamily="ui-monospace, monospace" fontWeight="700">
                    {text}
                  </text>
                </g>
              )}
            </g>
          );
        })()}

        {/* selected vessel track + breadcrumbs */}
        {r.selectedMmsi && r.trackData && r.trackData.fixes.length > 1 && (
          <g pointerEvents="none">
            <polyline
              points={r.trackData.fixes.map((f) => project([f.lon, f.lat]).map((n) => n.toFixed(1)).join(',')).join(' ')}
              fill="none"
              stroke="#080d16"
              strokeWidth="5"
              strokeLinejoin="round"
              strokeLinecap="round"
              strokeOpacity="0.6"
            />
            <polyline
              points={r.trackData.fixes.map((f) => project([f.lon, f.lat]).map((n) => n.toFixed(1)).join(',')).join(' ')}
              fill="none"
              stroke="#ffc400"
              strokeWidth="2.2"
              strokeLinejoin="round"
              strokeLinecap="round"
              strokeOpacity="0.95"
            />
            {r.trackData.fixes.map((f, i) => {
              const [px, py] = project([f.lon, f.lat]);
              const prev = r.trackData!.fixes[i - 1];
              const conflicting = i > 0 && prev.timestamp === f.timestamp && (prev.lat !== f.lat || prev.lon !== f.lon);
              return (
                <circle
                  key={`hist-pt-${f.rowid || i}`}
                  cx={px}
                  cy={py}
                  r={conflicting ? 4.5 : 2.6}
                  fill={conflicting ? '#ff4259' : '#ffc400'}
                  stroke={conflicting ? '#ffffff' : '#080d16'}
                  strokeWidth={conflicting ? 1.5 : 1}
                />
              );
            })}
          </g>
        )}

        {/* vessels */}
        {drawOrder.map((a) => {
          const v = a.vessel;
          const [vx, vy] = project([v.lon, v.lat]);
          if (vx < -60 || vx > size.w + 60 || vy < -60 || vy > size.h + 60) return null;
          const vis = vesselVisuals(a);
          const sel = v.mmsi === r.selectedMmsi;
          const angle = v.cog ?? v.heading ?? null;
          const speed = v.sog ?? 0;
          const vecLen = Math.max(10, Math.min(42, speed * 2.2));
          const rad = angle !== null ? (angle * Math.PI) / 180 : null;
          const showLabel = sel || vis.alertTier !== 'normal' || zoom >= 1.7;
          const labelColor = sel ? '#ffc400' : vis.alertTier === 'cue' ? '#ff8595' : vis.alertTier === 'review' ? '#ffbf5e' : '#c4cee0';
          const scale = sel ? 1.3 : 1;
          return (
            <g
              key={v.mmsi}
              className="cursor-pointer"
              opacity={a.isStale && !sel ? 0.55 : 1}
              onClick={(e) => {
                e.stopPropagation();
                if (movedRef.current > 4) return;
                r.setSelectedMmsi(v.mmsi);
              }}
              onPointerEnter={() => setHover({ mmsi: v.mmsi, x: vx, y: vy })}
              onPointerLeave={() => setHover(null)}
            >
              {/* generous invisible hit target */}
              <circle cx={vx} cy={vy} r="14" fill="transparent" />
              {vis.alertTier === 'cue' && (
                <>
                  <circle cx={vx} cy={vy} r="16" fill="#ff4259" fillOpacity="0.16" stroke="#ff4259" strokeWidth="1.4" />
                  <circle cx={vx} cy={vy} r="16" fill="none" stroke="#ff4259" strokeWidth="1.5" className="vessel-halo" />
                </>
              )}
              {vis.alertTier === 'review' && <circle cx={vx} cy={vy} r="13" fill="none" stroke="#ff9f1a" strokeWidth="1.3" strokeDasharray="3 3" />}
              {sel && (
                <g>
                  <circle cx={vx} cy={vy} r="21" fill="none" stroke="#ffc400" strokeWidth="1.4" strokeDasharray="4 4" />
                  <circle cx={vx} cy={vy} r="14" fill="#ffc400" fillOpacity="0.1" stroke="#ffc400" strokeWidth="1.2" />
                </g>
              )}
              {rad !== null && (
                <line
                  x1={vx}
                  y1={vy}
                  x2={vx + Math.sin(rad) * vecLen}
                  y2={vy - Math.cos(rad) * vecLen}
                  stroke={vis.stroke}
                  strokeWidth={sel ? 2 : 1.3}
                  strokeOpacity="0.75"
                  strokeLinecap="round"
                />
              )}
              {angle !== null ? (
                <path
                  d={VESSEL_PATH}
                  transform={`translate(${vx} ${vy}) rotate(${angle}) scale(${scale})`}
                  fill={vis.fill}
                  stroke={sel ? '#ffffff' : '#080d16'}
                  strokeWidth={sel ? 1.5 : 1.3}
                  strokeLinejoin="round"
                />
              ) : (
                <circle cx={vx} cy={vy} r={5.5 * scale} fill={vis.fill} stroke={sel ? '#ffffff' : '#080d16'} strokeWidth="1.4" />
              )}
              {showLabel && (
                <text
                  x={vx + 14}
                  y={vy + 3.5}
                  fontSize="10.5"
                  fontFamily="ui-monospace, monospace"
                  fill={labelColor}
                  fontWeight={sel || vis.alertTier !== 'normal' ? 700 : 500}
                  className="map-label"
                  pointerEvents="none"
                >
                  {v.name || v.mmsi} {v.sog !== null ? `${v.sog}kn` : ''}
                </text>
              )}
            </g>
          );
        })}

        <rect width={size.w} height={size.h} fill="url(#vignette)" pointerEvents="none" />
      </svg>

      {/* hover card */}
      {hovered && hover && !r.isDragging && (
        <div
          className="pointer-events-none absolute z-20 min-w-44 rounded-lg border border-ink-600 bg-ink-900/95 px-3 py-2 shadow-xl shadow-black/50 backdrop-blur"
          style={{ left: Math.min(hover.x + 16, size.w - 200), top: Math.max(hover.y - 20, 8) }}
        >
          <div className="flex items-center justify-between gap-3">
            <span className="text-xs font-bold text-white">{hovered.vessel.name || hovered.vessel.mmsi}</span>
            {hovered.tier !== 'normal' && (
              <span className={cn('text-[9px] font-bold uppercase', hovered.tier === 'cue' ? 'text-cue' : 'text-review')}>{hovered.tier}</span>
            )}
          </div>
          <div className="mt-0.5 font-mono text-[10px] text-mute">
            {hovered.vessel.ship_type || 'Unknown'} · {hovered.vessel.sog !== null ? `${hovered.vessel.sog} kn` : 'sog n/a'} · score {hovered.score.toFixed(1)}
          </div>
        </div>
      )}

      {/* sector focus chips */}
      <div className="absolute left-3 right-16 top-3 z-10 flex gap-1.5 overflow-x-auto pb-1" role="group" aria-label="Sector focus">
        {SECTOR_ORDER.map((key) => {
          const sec = SECTOR_CONFIG[key];
          const active = r.sector === key && r.geomName === 'ALL';
          return (
            <button
              key={key}
              type="button"
              onClick={() => r.focusSector(key)}
              className={cn(
                'flex shrink-0 items-center gap-1.5 whitespace-nowrap rounded-full border px-3 py-1.5 text-[11px] font-semibold shadow-lg shadow-black/30 backdrop-blur transition-colors',
                active
                  ? 'border-brand bg-brand text-ink-950'
                  : 'border-ink-600 bg-ink-900/90 text-soft hover:border-ink-500 hover:bg-ink-800 hover:text-white'
              )}
            >
              {key === 'fit-data' && <Icon name="fit" size={12} />}
              {key === 'all' && <Icon name="globe" size={12} />}
              {sec.label}
            </button>
          );
        })}
      </div>

      {r.isPlacingBase && (
        <div className="fade-in absolute left-1/2 top-14 z-20 flex -translate-x-1/2 items-center gap-3 rounded-full border border-ok/60 bg-ink-900/95 px-4 py-2 text-xs font-semibold text-ok shadow-xl backdrop-blur">
          <Icon name="pin" size={14} /> Click anywhere on the radar map to deploy the ISR Base
          <button onClick={() => r.setIsPlacingBase(false)} className="rounded-full p-0.5 text-mute hover:text-white" aria-label="Cancel base placement">
            <Icon name="close" size={13} />
          </button>
        </div>
      )}

      {/* map controls */}
      <div className={cn('absolute top-14 z-10 flex flex-col gap-1.5 transition-[right] duration-200', detailOpen ? 'right-3 lg:right-[404px]' : 'right-3')}>
        <IconButton title="Zoom In" onClick={() => zoomBy(1.35)}>
          <Icon name="plus" size={16} />
        </IconButton>
        <IconButton title="Zoom Out (down to 15%)" onClick={() => zoomBy(1 / 1.35)}>
          <Icon name="minus" size={16} />
        </IconButton>
        <IconButton title="Reset Pan & Zoom (click-drag to pan, wheel to zoom)" onClick={r.resetView} className="text-[10px] font-mono">
          {Math.round(zoom * 100)}%
        </IconButton>
        <IconButton title="Auto-fit to active dataset bounding box" onClick={() => r.focusSector('fit-data')} active={fitActive}>
          <Icon name="fit" size={16} />
        </IconButton>
        <IconButton title="Show all Baltic & Danish waters (9.5° – 16.5°E)" onClick={() => r.focusSector('all')} active={allActive}>
          <Icon name="globe" size={16} />
        </IconButton>
      </div>

      {/* legend */}
      <div className="absolute bottom-3 left-3 z-10 hidden rounded-xl border border-ink-700 bg-ink-900/90 px-3 py-2.5 text-[10.5px] text-soft shadow-xl backdrop-blur md:block">
        <div className="mb-1.5 text-[9px] font-bold uppercase tracking-widest text-mute">Legend</div>
        <ul className="grid grid-cols-2 gap-x-4 gap-y-1">
          <LegendItem color="#ff4259" label="CUE (anomaly ≥ 4.2)" />
          <LegendItem color="#ff9f1a" label="REVIEW (≥ 2.2)" />
          <LegendItem color="#3db8ff" label="Cargo / Tanker" />
          <LegendItem color="#a98bff" label="Passenger / Ferry" />
          <LegendItem color="#ff6fb1" label="Fishing" />
          <LegendItem color="#2ee6a6" label="Other / ISR base & sortie" />
        </ul>
      </div>

      {/* scale + extent */}
      <div className="pointer-events-none absolute bottom-3 right-3 z-10 flex flex-col items-end gap-1 text-[10px] text-mute">
        <div className="rounded-md bg-ink-900/80 px-2 py-1 font-mono backdrop-blur">
          {bounds ? `${bounds.minx.toFixed(2)}–${bounds.maxx.toFixed(2)}°E · ${bounds.miny.toFixed(2)}–${bounds.maxy.toFixed(2)}°N` : ''}
        </div>
        <div className="flex items-center gap-2 rounded-md bg-ink-900/80 px-2 py-1 backdrop-blur">
          <span className="font-mono text-soft">{scaleBar.km} km</span>
          <span className="block h-1.5 border-x border-b border-soft" style={{ width: scaleBar.px }} />
        </div>
      </div>
    </div>
  );
}

function LegendItem({ color, label }: { color: string; label: string }) {
  return (
    <li className="flex items-center gap-1.5">
      <svg width="12" height="12" viewBox="-12 -12 24 24" aria-hidden>
        <path d={VESSEL_PATH} fill={color} stroke="#080d16" strokeWidth="2" />
      </svg>
      {label}
    </li>
  );
}
