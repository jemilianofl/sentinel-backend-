/* ============================================================================
 * Geodesia (backend). Copia de src/utils/datum.ts del frontend: mantener ambas
 * iguales para que la conversión sea idéntica en navegador y servidor.
 *
 * Transformación: traslación geocéntrica de 3 parámetros (Molodensky / Helmert sin
 * rotación ni escala), parámetros NIMA TR8350.2. Precisión indicada en cada datum.
 * ========================================================================== */

export interface Ellipsoid {
  name: string;
  a: number;
  f: number;
}

export const ELLIPSOIDS = {
  WGS84: { name: 'WGS84', a: 6378137, f: 1 / 298.257223563 },
  GRS80: { name: 'GRS80', a: 6378137, f: 1 / 298.257222101 },
  CLARKE1866: { name: 'Clarke 1866', a: 6378206.4, f: 1 / 294.978698214 },
} satisfies Record<string, Ellipsoid>;

export type DatumId = 'WGS84' | 'ITRF2008' | 'NAD83' | 'NAD27';

export interface DatumDef {
  id: DatumId;
  label: string;
  ellipsoid: Ellipsoid;
  /** Traslación ΔX, ΔY, ΔZ (m) del datum hacia WGS84. */
  toWgs84: [number, number, number];
  accuracy: string;
  description: string;
}

export const DATUMS: Record<DatumId, DatumDef> = {
  WGS84: {
    id: 'WGS84',
    label: 'WGS84',
    ellipsoid: ELLIPSOIDS.WGS84,
    toWgs84: [0, 0, 0],
    accuracy: 'Referencia (GPS)',
    description: 'Sistema de los receptores GPS y de las imágenes satelitales.',
  },
  ITRF2008: {
    id: 'ITRF2008',
    label: 'ITRF2008 época 2010.0',
    ellipsoid: ELLIPSOIDS.GRS80,
    toWgs84: [0, 0, 0],
    accuracy: '< 1 m respecto a WGS84',
    description: 'Marco Geodésico Nacional oficial de INEGI.',
  },
  NAD83: {
    id: 'NAD83',
    label: 'NAD83',
    ellipsoid: ELLIPSOIDS.GRS80,
    toWgs84: [0, 0, 0],
    accuracy: '≈ 1–2 m respecto a WGS84',
    description: 'Cartografía de transición y EE. UU.',
  },
  NAD27: {
    id: 'NAD27',
    label: 'NAD27 (México)',
    ellipsoid: ELLIPSOIDS.CLARKE1866,
    toWgs84: [-12, 130, 190],
    accuracy: '± 10 m (3 parámetros, NIMA TR8350.2)',
    description: 'Cartografía INEGI anterior a 1998 y planos antiguos.',
  },
};

export const DATUM_OPTIONS: DatumDef[] = [DATUMS.WGS84, DATUMS.ITRF2008, DATUMS.NAD83, DATUMS.NAD27];

const DEG = Math.PI / 180;

function geodeticToEcef(lon: number, lat: number, ell: Ellipsoid): [number, number, number] {
  const e2 = ell.f * (2 - ell.f);
  const phi = lat * DEG;
  const lam = lon * DEG;
  const n = ell.a / Math.sqrt(1 - e2 * Math.sin(phi) ** 2);
  return [n * Math.cos(phi) * Math.cos(lam), n * Math.cos(phi) * Math.sin(lam), n * (1 - e2) * Math.sin(phi)];
}

function ecefToGeodetic(x: number, y: number, z: number, ell: Ellipsoid): [number, number] {
  const e2 = ell.f * (2 - ell.f);
  const p = Math.hypot(x, y);
  const lon = Math.atan2(y, x);
  let lat = Math.atan2(z, p * (1 - e2));
  for (let i = 0; i < 6; i++) {
    const n = ell.a / Math.sqrt(1 - e2 * Math.sin(lat) ** 2);
    lat = Math.atan2(z + e2 * n * Math.sin(lat), p);
  }
  return [lon / DEG, lat / DEG];
}

const isIdentity = (d: DatumDef) => d.toWgs84.every((v) => v === 0);

/** Coordenadas geográficas en el datum indicado → WGS84. */
export function toWgs84(lon: number, lat: number, datum: DatumId): [number, number] {
  const d = DATUMS[datum];
  if (isIdentity(d)) return [lon, lat];
  const [x, y, z] = geodeticToEcef(lon, lat, d.ellipsoid);
  return ecefToGeodetic(x + d.toWgs84[0], y + d.toWgs84[1], z + d.toWgs84[2], ELLIPSOIDS.WGS84);
}

/** WGS84 → coordenadas geográficas en el datum indicado. */
export function fromWgs84(lon: number, lat: number, datum: DatumId): [number, number] {
  const d = DATUMS[datum];
  if (isIdentity(d)) return [lon, lat];
  const [x, y, z] = geodeticToEcef(lon, lat, ELLIPSOIDS.WGS84);
  return ecefToGeodetic(x - d.toWgs84[0], y - d.toWgs84[1], z - d.toWgs84[2], d.ellipsoid);
}

/* ------------------------------ UTM -------------------------------------- */

export const utmZoneFromLon = (lon: number): number => Math.min(60, Math.max(1, Math.floor((lon + 180) / 6) + 1));

/** UTM → [lon, lat] sobre el elipsoide dado (Snyder, USGS PP 1395; error < 1 mm). */
export function utmToLonLat(
  easting: number,
  northing: number,
  zone: number,
  hemisphere: 'N' | 'S',
  ell: Ellipsoid = ELLIPSOIDS.WGS84,
): [number, number] {
  const { a, f } = ell;
  const k0 = 0.9996;
  const e2 = f * (2 - f);
  const ep2 = e2 / (1 - e2);
  const x = easting - 500000;
  const y = hemisphere === 'N' ? northing : northing - 10000000;

  const m = y / k0;
  const mu = m / (a * (1 - e2 / 4 - (3 * e2 ** 2) / 64 - (5 * e2 ** 3) / 256));
  const e1 = (1 - Math.sqrt(1 - e2)) / (1 + Math.sqrt(1 - e2));
  const phi1 =
    mu +
    ((3 * e1) / 2 - (27 * e1 ** 3) / 32) * Math.sin(2 * mu) +
    ((21 * e1 ** 2) / 16 - (55 * e1 ** 4) / 32) * Math.sin(4 * mu) +
    ((151 * e1 ** 3) / 96) * Math.sin(6 * mu) +
    ((1097 * e1 ** 4) / 512) * Math.sin(8 * mu);

  const sin1 = Math.sin(phi1);
  const cos1 = Math.cos(phi1);
  const tan1 = Math.tan(phi1);
  const n1 = a / Math.sqrt(1 - e2 * sin1 ** 2);
  const t1 = tan1 ** 2;
  const c1 = ep2 * cos1 ** 2;
  const r1 = (a * (1 - e2)) / (1 - e2 * sin1 ** 2) ** 1.5;
  const d = x / (n1 * k0);

  const lat =
    phi1 -
    ((n1 * tan1) / r1) *
      (d ** 2 / 2 -
        ((5 + 3 * t1 + 10 * c1 - 4 * c1 ** 2 - 9 * ep2) * d ** 4) / 24 +
        ((61 + 90 * t1 + 298 * c1 + 45 * t1 ** 2 - 252 * ep2 - 3 * c1 ** 2) * d ** 6) / 720);
  const lon0 = ((zone - 1) * 6 - 180 + 3) * DEG;
  const lon =
    lon0 +
    (d - ((1 + 2 * t1 + c1) * d ** 3) / 6 + ((5 - 2 * c1 + 28 * t1 - 3 * c1 ** 2 + 8 * ep2 + 24 * t1 ** 2) * d ** 5) / 120) /
      cos1;

  return [lon / DEG, lat / DEG];
}

/** [lon, lat] → UTM sobre el elipsoide dado. Si no se indica zona se calcula de la longitud. */
export function lonLatToUtm(
  lon: number,
  lat: number,
  ell: Ellipsoid = ELLIPSOIDS.WGS84,
  forcedZone?: number,
): { easting: number; northing: number; zone: number; hemisphere: 'N' | 'S' } {
  const zone = forcedZone ?? utmZoneFromLon(lon);
  const { a, f } = ell;
  const k0 = 0.9996;
  const e2 = f * (2 - f);
  const ep2 = e2 / (1 - e2);
  const phi = lat * DEG;
  const lam0 = ((zone - 1) * 6 - 177) * DEG;
  const n = a / Math.sqrt(1 - e2 * Math.sin(phi) ** 2);
  const t = Math.tan(phi) ** 2;
  const c = ep2 * Math.cos(phi) ** 2;
  const A = Math.cos(phi) * (lon * DEG - lam0);
  const m =
    a *
    ((1 - e2 / 4 - (3 * e2 ** 2) / 64 - (5 * e2 ** 3) / 256) * phi -
      ((3 * e2) / 8 + (3 * e2 ** 2) / 32 + (45 * e2 ** 3) / 1024) * Math.sin(2 * phi) +
      ((15 * e2 ** 2) / 256 + (45 * e2 ** 3) / 1024) * Math.sin(4 * phi) -
      ((35 * e2 ** 3) / 3072) * Math.sin(6 * phi));

  const easting =
    k0 * n * (A + ((1 - t + c) * A ** 3) / 6 + ((5 - 18 * t + t ** 2 + 72 * c - 58 * ep2) * A ** 5) / 120) + 500000;
  let northing =
    k0 *
    (m +
      n *
        Math.tan(phi) *
        (A ** 2 / 2 + ((5 - t + 9 * c + 4 * c ** 2) * A ** 4) / 24 + ((61 - 58 * t + t ** 2 + 600 * c - 330 * ep2) * A ** 6) / 720));
  const hemisphere = lat >= 0 ? 'N' : 'S';
  if (hemisphere === 'S') northing += 10000000;
  return { easting, northing, zone, hemisphere };
}

/** Texto UTM de un punto WGS84 expresado en el datum elegido: "15N 793,305.97 E · 1,984,685.43 N". */
export function formatUtmInDatum(lonWgs: number, latWgs: number, datum: DatumId): string {
  const [lon, lat] = fromWgs84(lonWgs, latWgs, datum);
  const u = lonLatToUtm(lon, lat, DATUMS[datum].ellipsoid);
  const fmt = (v: number) => v.toLocaleString('es-MX', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  return `${u.zone}${u.hemisphere} ${fmt(u.easting)} E · ${fmt(u.northing)} N`;
}
