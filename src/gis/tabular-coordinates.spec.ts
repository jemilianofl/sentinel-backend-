import { describe, it, expect } from 'vitest';
import { BadRequestException } from '@nestjs/common';
import type { Polygon } from 'geojson';
import { GisService } from './gis.service.js';
import { detectTemplate, parseCoordinate, readCsvTable, readXlsxTable } from './tabular-coordinates.js';

/** Construye un .xlsx mínimo (ZIP sin compresión) con una hoja "Coordenadas" en cadenas en línea. */
function buildXlsx(rows: (string | number)[][]): Buffer {
  const col = (i: number) => String.fromCharCode(65 + i);
  const esc = (v: string) => v.replace(/&/g, '&amp;').replace(/</g, '&lt;');
  const sheetRows = rows
    .map(
      (r, ri) =>
        `<row r="${ri + 1}">` +
        r
          .map((v, ci) =>
            typeof v === 'number'
              ? `<c r="${col(ci)}${ri + 1}"><v>${v}</v></c>`
              : `<c r="${col(ci)}${ri + 1}" t="inlineStr"><is><t>${esc(v)}</t></is></c>`,
          )
          .join('') +
        '</row>',
    )
    .join('');
  const files: Record<string, string> = {
    'xl/workbook.xml':
      '<?xml version="1.0"?><workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets><sheet name="Instrucciones" sheetId="1" r:id="rId1"/><sheet name="Coordenadas" sheetId="2" r:id="rId2"/></sheets></workbook>',
    'xl/_rels/workbook.xml.rels':
      '<?xml version="1.0"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Target="worksheets/sheet1.xml"/><Relationship Id="rId2" Target="worksheets/sheet2.xml"/></Relationships>',
    'xl/worksheets/sheet1.xml':
      '<?xml version="1.0"?><worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData><row r="1"><c r="A1" t="inlineStr"><is><t>Lea esto</t></is></c></row></sheetData></worksheet>',
    'xl/worksheets/sheet2.xml': `<?xml version="1.0"?><worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData>${sheetRows}</sheetData></worksheet>`,
  };

  const locals: Buffer[] = [];
  const centrals: Buffer[] = [];
  let offset = 0;
  for (const [name, content] of Object.entries(files)) {
    const nameBuf = Buffer.from(name);
    const data = Buffer.from(content);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt32LE(data.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(nameBuf.length, 26);
    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt32LE(data.length, 20);
    central.writeUInt32LE(data.length, 24);
    central.writeUInt16LE(nameBuf.length, 28);
    central.writeUInt32LE(offset, 42);
    locals.push(local, nameBuf, data);
    centrals.push(central, nameBuf);
    offset += 30 + nameBuf.length + data.length;
  }
  const centralBuf = Buffer.concat(centrals);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(Object.keys(files).length, 8);
  end.writeUInt16LE(Object.keys(files).length, 10);
  end.writeUInt32LE(centralBuf.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, centralBuf, end]);
}

const utmCsv = [
  'POLIGONO;VERTICE;ESTE_X;NORTE_Y;ZONA;HEMISFERIO',
  'A;1;799799,01;1976044,60;15;N',
  'A;3;798585,70;1975020,11;15;N',
  'A;2;799770,80;1974988,78;15;N',
  'A;4;798530,88;1976114,66;15;N',
  'B;1;181000;1993000;16;N',
  'B;2;181500;1993000;16;N',
  'B;3;181500;1993500;16;N',
  'B;4;;1993500;16;N',
].join('\n');

describe('tabular-coordinates', () => {
  it('lee coordenadas en decimal, coma decimal y GMS', () => {
    expect(parseCoordinate('-90.2313')).toBeCloseTo(-90.2313, 6);
    expect(parseCoordinate('-90,2313')).toBeCloseTo(-90.2313, 6);
    expect(parseCoordinate('90°13\'52.8"W')).toBeCloseTo(-90.231333, 5);
    expect(parseCoordinate('17 55 50 N')).toBeCloseTo(17.930556, 5);
  });

  it('reconoce las plantillas geográfica y UTM, y no confunde una tabla libre', () => {
    expect(detectTemplate(['POLIGONO', 'VERTICE', 'LATITUD', 'LONGITUD'])?.kind).toBe('geo');
    expect(detectTemplate(['Polígono', 'Vértice', 'Este_X', 'Norte_Y', 'Zona'])?.kind).toBe('utm');
    expect(detectTemplate(['Punto', 'Latitud', 'Longitud'])).toBeNull();
  });

  it('lee la hoja "Coordenadas" de un .xlsx ignorando "Instrucciones"', () => {
    const table = readXlsxTable(
      buildXlsx([
        ['POLIGONO', 'VERTICE', 'LATITUD', 'LONGITUD'],
        ['A', 1, 17.85166667, -90.17133333],
      ]),
    );
    expect(table.sheetName).toBe('Coordenadas');
    expect(table.rows[0].LONGITUD).toBe('-90.17133333');
    expect(table.rowNumbers).toEqual([2]);
  });

  it('detecta el separador ";" y conserva el número de fila', () => {
    const table = readCsvTable(Buffer.from(utmCsv));
    expect(table.headers).toContain('ESTE_X');
    expect(table.rowNumbers[0]).toBe(2);
  });
});

describe('GisService.parseTableUpload', () => {
  const service = new GisService();

  it('forma polígonos por POLIGONO, ordena por VERTICE, respeta la zona de cada fila y reporta errores por fila', () => {
    const res = service.parseTableUpload(Buffer.from(utmCsv), 'levantamiento.csv', { datum: 'WGS84' });
    expect(res.template).toBe('utm');
    expect(res.polygonCount).toBe(2);
    expect(res.errors).toEqual([{ row: 9, message: expect.stringContaining('ESTE_X') as unknown as string }]);

    const polys = res.featureCollection!.features.filter((f) => f.geometry.type === 'Polygon');
    const a = polys.find((f) => f.properties?.POLIGONO === 'A')!.geometry as Polygon;
    // Vértice 1 de A (zona 15) ≈ -90.171333, 17.851667; el 2 debe ir antes que el 3 aunque en el archivo venga después
    expect(a.coordinates[0][0][0]).toBeCloseTo(-90.171333, 5);
    expect(a.coordinates[0][1][1]).toBeCloseTo(17.842139, 5);
    // B está en zona 16: longitud al este de -90°
    const b = polys.find((f) => f.properties?.POLIGONO === 'B')!.geometry as Polygon;
    expect(b.coordinates[0][0][0]).toBeGreaterThan(-90.02);
    expect(b.coordinates[0][0][0]).toBeLessThan(-90);
  });

  it('aplica el datum NAD27 (≈200 m respecto a WGS84 en México)', () => {
    const wgs = service.parseTableUpload(Buffer.from(utmCsv), 'a.csv', { datum: 'WGS84' });
    const nad = service.parseTableUpload(Buffer.from(utmCsv), 'a.csv', { datum: 'NAD27' });
    const lat = (r: typeof wgs) => (r.featureCollection!.features[0].geometry as Polygon).coordinates[0][0][1];
    const shiftM = (lat(nad) - lat(wgs)) * 110574;
    expect(shiftM).toBeGreaterThan(150);
    expect(shiftM).toBeLessThan(250);
  });

  it('devuelve las filas cuando la tabla no usa la plantilla', () => {
    const res = service.parseTableUpload(Buffer.from('Punto,Latitud,Longitud\n1,17.93,-90.23\n'), 'libre.csv');
    expect(res.template).toBeNull();
    expect(res.rows).toHaveLength(1);
    expect(res.featureCollection).toBeUndefined();
  });

  it('rechaza .xls antiguo y tablas vacías', () => {
    expect(() => service.parseTableUpload(Buffer.from('x'), 'viejo.xls')).toThrow(BadRequestException);
    expect(() => service.parseTableUpload(Buffer.from('POLIGONO,VERTICE\n'), 'vacio.csv')).toThrow(BadRequestException);
  });
});
