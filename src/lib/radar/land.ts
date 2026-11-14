import raw from '@/data/land.json';

// Natural Earth 10m land (public domain), clipped to the Baltic / Danish domain and simplified to ~100 m.
// Rings are delta-encoded in 1/1000 degree: [lon0, lat0, dLon1, dLat1, ...].
export type LonLat = [number, number];

function decode(): LonLat[][] {
  return (raw as number[][]).map((r) => {
    const ring: LonLat[] = [];
    let x = r[0];
    let y = r[1];
    ring.push([x / 1000, y / 1000]);
    for (let i = 2; i < r.length; i += 2) {
      x += r[i];
      y += r[i + 1];
      ring.push([x / 1000, y / 1000]);
    }
    return ring;
  });
}

export const LAND_RINGS: LonLat[][] = decode();

// Major reference labels (water bodies and land masses) used for orientation on the map.
export const GEO_LABELS: { text: string; lon: number; lat: number; kind: 'sea' | 'land' }[] = [
  { text: 'BALTIC SEA', lon: 16.2, lat: 55.2, kind: 'sea' },
  { text: 'KATTEGAT', lon: 11.2, lat: 57.0, kind: 'sea' },
  { text: 'ØRESUND', lon: 12.75, lat: 55.82, kind: 'sea' },
  { text: 'ARKONA BASIN', lon: 13.9, lat: 54.85, kind: 'sea' },
  { text: 'BORNHOLM BASIN', lon: 15.4, lat: 55.2, kind: 'sea' },
  { text: 'SWEDEN', lon: 14.0, lat: 56.4, kind: 'land' },
  { text: 'DENMARK', lon: 9.6, lat: 56.1, kind: 'land' },
  { text: 'GERMANY', lon: 11.0, lat: 53.9, kind: 'land' },
  { text: 'POLAND', lon: 17.0, lat: 54.1, kind: 'land' },
  { text: 'ZEALAND', lon: 11.75, lat: 55.5, kind: 'land' },
  { text: 'FYN', lon: 10.35, lat: 55.35, kind: 'land' },
  { text: 'BORNHOLM', lon: 14.92, lat: 55.12, kind: 'land' },
  { text: 'FEHMARN', lon: 11.2, lat: 54.45, kind: 'land' },
];
