import { inflateRawSync } from 'node:zlib';
import { DOMParser } from '@xmldom/xmldom';
import * as turf from '@turf/turf';
import type { Feature, FeatureCollection, Point, Polygon } from 'geojson';
import { DATUMS, type DatumId, toWgs84, utmToLonLat } from './geodesy.js';

/* ============================================================================
 * Carga de coordenadas desde Excel (.xlsx) o CSV.
 *
 * - Excel se lee SIN dependencias nuevas: un .xlsx es un ZIP de XML; se descomprime
 *   con zlib (Node) y se interpreta con @xmldom/xmldom (ya usado para KML).
 * - Si el archivo usa una de las plantillas oficiales (geográficas o UTM) se arman
 *   directamente los polígonos y sus vértices, con errores por número de fila.
 * - Si es una tabla libre, se devuelven encabezados y filas para que el usuario
 *   elija las columnas en el frontend.
 * ========================================================================== */

export interface TabularTable {
  headers: string[];
  rows: Record<string, string>[];
  /** Número de fila real (como en Excel) de cada elemento de `rows`. */
  rowNumbers: number[];
  sheetName?: string;
}

export type TemplateKind = 'geo' | 'utm';

export interface TableIssue {
  row: number | null;
  message: string;
}

export interface TemplateBuildResult {
  featureCollection: FeatureCollection;
  polygonCount: number;
  vertexCount: number;
  errors: TableIssue[];
  warnings: string[];
}

export interface TemplateOptions {
  datum: DatumId;
  /** Zona por defecto si la plantilla UTM no trae columna ZONA. */
  defaultZone: number;
  defaultHemisphere: 'N' | 'S';
}

export const MAX_TABLE_ROWS = 20000;

/* ------------------------------ ZIP mínimo ------------------------------- */

function readZipEntries(buf: Buffer): Map<string, Buffer> {
  // Fin del directorio central (firma 0x06054b50), buscando desde el final
  let eocd = -1;
  for (let i = buf.length - 22; i >= Math.max(0, buf.length - 65557); i--) {
    if (buf.readUInt32LE(i) === 0x06054b50) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) throw new Error('El archivo no es un .xlsx válido (ZIP dañado).');

  const count = buf.readUInt16LE(eocd + 10);
  let ptr = buf.readUInt32LE(eocd + 16);
  const entries = new Map<string, Buffer>();

  for (let i = 0; i < count; i++) {
    if (buf.readUInt32LE(ptr) !== 0x02014b50) break;
    const method = buf.readUInt16LE(ptr + 10);
    const compSize = buf.readUInt32LE(ptr + 20);
    const nameLen = buf.readUInt16LE(ptr + 28);
    const extraLen = buf.readUInt16LE(ptr + 30);
    const commentLen = buf.readUInt16LE(ptr + 32);
    const localOffset = buf.readUInt32LE(ptr + 42);
    const name = buf.toString('utf-8', ptr + 46, ptr + 46 + nameLen);
    ptr += 46 + nameLen + extraLen + commentLen;

    // Solo interesan los XML del libro (evita descomprimir imágenes u otros binarios)
    if (!name.endsWith('.xml') && !name.endsWith('.rels')) continue;

    const lNameLen = buf.readUInt16LE(localOffset + 26);
    const lExtraLen = buf.readUInt16LE(localOffset + 28);
    const start = localOffset + 30 + lNameLen + lExtraLen;
    const data = buf.subarray(start, start + compSize);
    if (method === 0) entries.set(name, Buffer.from(data));
    else if (method === 8) entries.set(name, inflateRawSync(data));
  }
  return entries;
}

/* ------------------------------ XLSX ------------------------------------- */

const parseXml = (xml: Buffer | undefined) =>
  xml ? new DOMParser().parseFromString(xml.toString('utf-8'), 'text/xml') : null;

type XmlNode = { localName?: string | null; childNodes?: ArrayLike<XmlNode>; textContent?: string | null };
type XmlElement = XmlNode & { getAttribute: (name: string) => string | null };

function byLocalName(root: unknown, name: string): XmlElement[] {
  const out: XmlElement[] = [];
  const walk = (node: XmlNode) => {
    const kids = node.childNodes;
    if (!kids) return;
    for (let i = 0; i < kids.length; i++) {
      const child = kids[i];
      if (child.localName === name) out.push(child as XmlElement);
      walk(child);
    }
  };
  if (root) walk(root as XmlNode);
  return out;
}

const textOf = (el: XmlNode | undefined): string =>
  el ? byLocalName(el, 't').map((t) => t.textContent ?? '').join('') : '';

const columnIndex = (ref: string): number => {
  const letters = /^[A-Z]+/i.exec(ref)?.[0].toUpperCase() ?? 'A';
  let n = 0;
  for (const ch of letters) n = n * 26 + (ch.charCodeAt(0) - 64);
  return n - 1;
};

const normalize = (h: string) =>
  h
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[\s_\-.()[\]]/g, '');

/** Lee la hoja "Coordenadas" (o la primera que no sea "Instrucciones") de un .xlsx. */
export function readXlsxTable(buf: Buffer): TabularTable {
  const zip = readZipEntries(buf);
  const workbook = parseXml(zip.get('xl/workbook.xml'));
  if (!workbook) throw new Error('El archivo no es un libro de Excel (.xlsx) válido.');

  const rels = new Map<string, string>();
  byLocalName(parseXml(zip.get('xl/_rels/workbook.xml.rels')), 'Relationship').forEach((r) => {
    const target = r.getAttribute('Target') ?? '';
    rels.set(r.getAttribute('Id') ?? '', target.startsWith('/') ? target.slice(1) : `xl/${target}`);
  });

  const sheets = byLocalName(workbook, 'sheet').map((s) => ({
    name: s.getAttribute('name') ?? '',
    path: rels.get(s.getAttribute('r:id') ?? s.getAttribute('id') ?? '') ?? '',
  }));
  const chosen =
    sheets.find((s) => normalize(s.name) === 'coordenadas') ??
    sheets.find((s) => normalize(s.name) !== 'instrucciones') ??
    sheets[0];
  if (!chosen) throw new Error('El libro de Excel no tiene hojas.');

  const shared = byLocalName(parseXml(zip.get('xl/sharedStrings.xml')), 'si').map((si) => textOf(si));
  const sheetDoc = parseXml(zip.get(chosen.path));
  if (!sheetDoc) throw new Error(`No se pudo leer la hoja "${chosen.name}".`);

  const grid: { row: number; cells: string[] }[] = [];
  byLocalName(sheetDoc, 'row').forEach((rowEl, i) => {
    const rowNumber = Number(rowEl.getAttribute('r')) || i + 1;
    const cells: string[] = [];
    byLocalName(rowEl, 'c').forEach((c, j) => {
      const ref = c.getAttribute('r');
      const idx = ref ? columnIndex(ref) : j;
      const type = c.getAttribute('t');
      const v = byLocalName(c, 'v')[0]?.textContent ?? '';
      let value: string;
      if (type === 's') value = shared[Number(v)] ?? '';
      else if (type === 'inlineStr') value = textOf(byLocalName(c, 'is')[0]);
      else if (type === 'b') value = v === '1' ? 'VERDADERO' : 'FALSO';
      else value = v;
      cells[idx] = value.trim();
    });
    if (cells.some((v) => v)) grid.push({ row: rowNumber, cells });
  });

  return tableFromGrid(grid, chosen.name);
}

/* ------------------------------- CSV ------------------------------------- */

export function readCsvTable(buf: Buffer): TabularTable {
  let text = buf.toString('utf-8');
  if (text.charCodeAt(0) === 0xfeff) text = text.slice(1);
  // CSV de Excel en Windows sin "UTF-8": si hay caracteres inválidos se reintenta como Latin-1
  if (text.includes('�')) text = buf.toString('latin1');

  const firstLine = text.split(/\r?\n/, 1)[0] ?? '';
  const delimiter = [',', ';', '\t', '|'].reduce((best, d) =>
    firstLine.split(d).length > firstLine.split(best).length ? d : best,
  );

  const grid: { row: number; cells: string[] }[] = [];
  let field = '';
  let record: string[] = [];
  let inQuotes = false;
  let line = 1;
  let recordLine = 1;
  const pushRecord = () => {
    record.push(field);
    if (record.some((v) => v.trim() !== '')) grid.push({ row: recordLine, cells: record.map((v) => v.trim()) });
    record = [];
    field = '';
  };
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (inQuotes) {
      if (ch === '"' && text[i + 1] === '"') {
        field += '"';
        i++;
      } else if (ch === '"') inQuotes = false;
      else {
        if (ch === '\n') line++;
        field += ch;
      }
    } else if (ch === '"') inQuotes = true;
    else if (ch === delimiter) {
      record.push(field);
      field = '';
    } else if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && text[i + 1] === '\n') i++;
      pushRecord();
      line++;
      recordLine = line;
    } else field += ch;
  }
  pushRecord();
  return tableFromGrid(grid);
}

function tableFromGrid(grid: { row: number; cells: string[] }[], sheetName?: string): TabularTable {
  const [header, ...body] = grid;
  if (!header) return { headers: [], rows: [], rowNumbers: [], sheetName };
  const headers = Array.from({ length: header.cells.length }, (_, i) => header.cells[i] || `Columna_${i + 1}`);
  const limited = body.slice(0, MAX_TABLE_ROWS);
  return {
    headers,
    rows: limited.map((r) => Object.fromEntries(headers.map((h, i) => [h, r.cells[i] ?? '']))),
    rowNumbers: limited.map((r) => r.row),
    sheetName,
  };
}

/* ---------------------------- PLANTILLAS --------------------------------- */

interface TemplateColumns {
  kind: TemplateKind;
  poligono?: string;
  vertice: string;
  x: string;
  y: string;
  zona?: string;
  hemisferio?: string;
  descripcion?: string;
}

/** Reconoce las plantillas oficiales por sus encabezados (sin importar mayúsculas, acentos o "_"). */
export function detectTemplate(headers: string[]): TemplateColumns | null {
  const find = (...names: string[]) => headers.find((h) => names.includes(normalize(h)));
  const vertice = find('vertice', 'vertices', 'novertice', 'numvertice');
  if (!vertice) return null;
  const base = {
    poligono: find('poligono', 'idpoligono', 'predio'),
    vertice,
    descripcion: find('descripcion', 'observaciones', 'referencia'),
  };

  const lat = find('latitud', 'lat');
  const lon = find('longitud', 'lon', 'long');
  if (lat && lon) return { kind: 'geo', ...base, x: lon, y: lat };

  const este = find('estex', 'este', 'x', 'xutm', 'utmx');
  const norte = find('nortey', 'norte', 'y', 'yutm', 'utmy');
  if (este && norte) {
    return { kind: 'utm', ...base, x: este, y: norte, zona: find('zona', 'zonautm'), hemisferio: find('hemisferio', 'hemi') };
  }
  return null;
}

/** "-90.2313", "-90,2313", "90°13'52.8\"W", "O 90 13 52.8" → número. */
export function parseCoordinate(raw: string): number {
  const s = raw.trim();
  if (!s) return Number.NaN;
  if (/^[-+]?\d+(,\d+)?$/.test(s)) return Number.parseFloat(s.replace(',', '.'));
  if (/^[-+]?\d*\.?\d+(e[-+]?\d+)?$/i.test(s)) return Number.parseFloat(s);
  const hemiMatch = /^\s*([NSEWO])(?![a-z])|([NSEWO])\s*$/i.exec(s);
  const hemiLetter = (hemiMatch?.[1] ?? hemiMatch?.[2] ?? '').toUpperCase();
  const negative = s.startsWith('-') || hemiLetter === 'S' || hemiLetter === 'W' || hemiLetter === 'O';
  const nums = s.replace(',', '.').match(/\d+(\.\d+)?/g);
  if (!nums) return Number.NaN;
  const [d, m = '0', sec = '0'] = nums;
  const value = Number(d) + Number(m) / 60 + Number(sec) / 3600;
  return negative ? -value : value;
}

const compareVertex = (a: string, b: string) => {
  const na = Number(a);
  const nb = Number(b);
  if (Number.isFinite(na) && Number.isFinite(nb)) return na - nb;
  return a.localeCompare(b, 'es', { numeric: true });
};

/** Arma polígonos (uno por valor de POLIGONO, ordenados por VERTICE) y los vértices como puntos. */
export function buildFromTemplate(table: TabularTable, cols: TemplateColumns, opts: TemplateOptions): TemplateBuildResult {
  const errors: TableIssue[] = [];
  const warnings: string[] = [];
  const ellipsoid = DATUMS[opts.datum].ellipsoid;

  interface Vertex {
    poly: string;
    vertex: string;
    lon: number;
    lat: number;
    row: number;
    record: Record<string, string>;
  }
  const groups = new Map<string, Vertex[]>();

  table.rows.forEach((record, i) => {
    const row = table.rowNumbers[i];
    const poly = (cols.poligono ? record[cols.poligono] : '') || 'A';
    const vertex = record[cols.vertice] ?? '';
    const xv = parseCoordinate(record[cols.x] ?? '');
    const yv = parseCoordinate(record[cols.y] ?? '');

    if (!vertex) errors.push({ row, message: `falta ${cols.vertice}` });
    if (!Number.isFinite(xv)) errors.push({ row, message: `${cols.x} vacío o no numérico ("${record[cols.x] ?? ''}")` });
    if (!Number.isFinite(yv)) errors.push({ row, message: `${cols.y} vacío o no numérico ("${record[cols.y] ?? ''}")` });
    if (!vertex || !Number.isFinite(xv) || !Number.isFinite(yv)) return;

    let lon: number;
    let lat: number;
    if (cols.kind === 'utm') {
      const zone = cols.zona ? Number.parseInt(record[cols.zona] ?? '', 10) : opts.defaultZone;
      const hemiRaw = (cols.hemisferio ? record[cols.hemisferio] : '') || opts.defaultHemisphere;
      const hemi = hemiRaw.trim().toUpperCase().startsWith('S') ? 'S' : 'N';
      if (!Number.isInteger(zone) || zone < 1 || zone > 60) {
        errors.push({ row, message: `zona UTM inválida ("${cols.zona ? record[cols.zona] : ''}")` });
        return;
      }
      if (xv < 100000 || xv > 900000) {
        errors.push({ row, message: `Este ${xv} fuera de rango UTM (100,000–900,000 m); ¿columnas invertidas?` });
        return;
      }
      [lon, lat] = utmToLonLat(xv, yv, zone, hemi, ellipsoid);
    } else {
      [lon, lat] = [xv, yv];
      if (Math.abs(lat) > 90 || Math.abs(lon) > 180) {
        errors.push({ row, message: `coordenadas fuera de rango (lat ${yv}, lon ${xv})` });
        return;
      }
      if (lon > 0 && lat > 0 && lat < 40 && lon > 80 && lon < 120) {
        warnings.push(`Fila ${row}: longitud positiva (${lon}); en México debe ser negativa. Se tomó como Oeste.`);
        lon = -lon;
      }
    }
    [lon, lat] = toWgs84(lon, lat, opts.datum);

    if (!groups.has(poly)) groups.set(poly, []);
    groups.get(poly)!.push({ poly, vertex, lon, lat, row, record });
  });

  const polygons: Feature<Polygon>[] = [];
  const points: Feature<Point>[] = [];
  const multiplePolys = groups.size > 1;

  groups.forEach((vertices, poly) => {
    const ordered = [...vertices].sort((a, b) => compareVertex(a.vertex, b.vertex));
    const seen = new Set<string>();
    ordered.forEach((v) => {
      if (seen.has(v.vertex)) warnings.push(`Polígono ${poly}: el vértice ${v.vertex} está repetido (fila ${v.row}).`);
      seen.add(v.vertex);
    });

    let ring = ordered.map((v) => [Number(v.lon.toFixed(7)), Number(v.lat.toFixed(7))]);
    if (ring.length > 1 && ring[0][0] === ring[ring.length - 1][0] && ring[0][1] === ring[ring.length - 1][1]) {
      ring = ring.slice(0, -1);
    }

    ordered.forEach((v) => {
      const props: Record<string, unknown> = {
        POLIGONO: poly,
        VERTICE: v.vertex,
        LATITUD_WGS84: Number(v.lat.toFixed(7)),
        LONGITUD_WGS84: Number(v.lon.toFixed(7)),
        _label: multiplePolys ? `${poly}-${v.vertex}` : `V${v.vertex}`,
        _fila: v.row,
        _datumOrigen: opts.datum,
      };
      if (cols.descripcion && v.record[cols.descripcion]) props.DESCRIPCION = v.record[cols.descripcion];
      if (cols.kind === 'utm') {
        props.ESTE_X = v.record[cols.x];
        props.NORTE_Y = v.record[cols.y];
        if (cols.zona) props.ZONA = v.record[cols.zona];
      }
      points.push(turf.point([Number(v.lon.toFixed(7)), Number(v.lat.toFixed(7))], props));
    });

    if (ring.length < 3) {
      errors.push({ row: null, message: `Polígono ${poly}: solo tiene ${ring.length} vértice(s) válidos; se necesitan al menos 3.` });
      return;
    }
    const polygon = turf.polygon([[...ring, ring[0]]], { NOMBRE: poly, POLIGONO: poly, NUM_VERTICES: ring.length });
    try {
      if (turf.kinks(polygon).features.length > 0) {
        warnings.push(`Polígono ${poly}: se cruza a sí mismo; revisa el orden de la columna ${cols.vertice}.`);
      }
    } catch {
      /* geometría degenerada: la reporta turf.area más abajo */
    }
    polygons.push(polygon);
  });

  return {
    featureCollection: { type: 'FeatureCollection', features: [...polygons, ...points] },
    polygonCount: polygons.length,
    vertexCount: points.length,
    errors,
    warnings,
  };
}
