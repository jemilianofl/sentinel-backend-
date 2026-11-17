import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { Test, TestingModule } from '@nestjs/testing';
import {
  BadRequestException,
  InternalServerErrorException,
} from '@nestjs/common';
import type { Feature, Polygon } from 'geojson';
import { GisService } from './gis.service.js';

describe('GisService', () => {
  let service: GisService;

  const predioPolygon: Polygon = {
    type: 'Polygon',
    coordinates: [
      [
        [-96.132, 15.752],
        [-96.13, 15.752],
        [-96.13, 15.754],
        [-96.132, 15.754],
        [-96.132, 15.752],
      ],
    ],
  };

  beforeEach(async () => {
    process.env.R2_PUBLIC_URL = 'https://r2-test.profepa.gob.mx';

    const module: TestingModule = await Test.createTestingModule({
      providers: [GisService],
    }).compile();

    service = module.get<GisService>(GisService);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe('parseSpatialUpload', () => {
    it('debe parsear un GeoJSON válido, asignar polyId y calcular áreas en m² y ha', async () => {
      const geojsonPayload = JSON.stringify({
        type: 'FeatureCollection',
        features: [
          {
            type: 'Feature',
            properties: { PREDIO: 'Lote Norte' },
            geometry: predioPolygon,
          },
        ],
      });

      const result = await service.parseSpatialUpload(
        Buffer.from(geojsonPayload, 'utf-8'),
        'predio.geojson',
      );

      expect(result.success).toBe(true);
      expect(result.polygons).toHaveLength(1);
      expect(result.polygons[0].polyId).toBe('A');
      expect(result.polygons[0].name).toBe('Polígono A');
      expect(result.totalAreaM2).toBeGreaterThan(40000);
      expect(result.totalAreaHa).toBeCloseTo(result.totalAreaM2 / 10000, 4);
      expect(result.featureCollection.features[0].properties?.polyId).toBe('A');
    });

    it('debe parsear un archivo KML válido y convertirlo a FeatureCollection', async () => {
      const kmlPayload = `<?xml version="1.0" encoding="UTF-8"?>
<kml xmlns="http://www.opengis.net/kml/2.2">
  <Placemark>
    <name>Poligono KML</name>
    <Polygon>
      <outerBoundaryIs>
        <LinearRing>
          <coordinates>-96.132,15.752,0 -96.130,15.752,0 -96.130,15.754,0 -96.132,15.754,0 -96.132,15.752,0</coordinates>
        </LinearRing>
      </outerBoundaryIs>
    </Polygon>
  </Placemark>
</kml>`;

      const result = await service.parseSpatialUpload(
        Buffer.from(kmlPayload, 'utf-8'),
        'poligono.kml',
      );

      expect(result.success).toBe(true);
      expect(result.polygons).toHaveLength(1);
      expect(result.polygons[0].polyId).toBe('A');
      expect(result.totalAreaM2).toBeGreaterThan(40000);
    });

    it('debe rechazar formatos de archivo no soportados con BadRequestException', async () => {
      await expect(
        service.parseSpatialUpload(Buffer.from('contenido invalido'), 'documento.pdf'),
      ).rejects.toThrow(BadRequestException);
    });

    it('debe rechazar un GeoJSON sin entidades geométricas', async () => {
      const emptyFc = JSON.stringify({ type: 'FeatureCollection', features: [] });

      await expect(
        service.parseSpatialUpload(Buffer.from(emptyFc, 'utf-8'), 'vacio.geojson'),
      ).rejects.toThrow(BadRequestException);
    });
  });

  describe('getSpatialContext', () => {
    it('debe lanzar InternalServerErrorException si no está configurada R2_PUBLIC_URL', async () => {
      delete process.env.R2_PUBLIC_URL;
      delete process.env.VITE_R2_PUBLIC_URL;

      await expect(
        service.getSpatialContext({
          geometry: predioPolygon,
          planos: [2],
        }),
      ).rejects.toThrow(InternalServerErrorException);
    });

    it('debe filtrar solo coberturas que tocan el predio en modo intersect vs buffer10km', async () => {
      const featureInsidePredio: Feature = {
        type: 'Feature',
        properties: { RAMSAR: 'Cuencas y Corales de la Zona Costera de Huatulco' },
        geometry: {
          type: 'Polygon',
          coordinates: [
            [
              [-96.133, 15.751],
              [-96.129, 15.751],
              [-96.129, 15.755],
              [-96.133, 15.755],
              [-96.133, 15.751],
            ],
          ],
        },
      };

      // Polígono a ~5 km del predio (dentro del buffer de 10 km, pero fuera del predio)
      const featureWithin10km: Feature = {
        type: 'Feature',
        properties: { NOMBRE: 'Huatulco II' },
        geometry: {
          type: 'Polygon',
          coordinates: [
            [
              [-96.09, 15.751],
              [-96.085, 15.751],
              [-96.085, 15.755],
              [-96.09, 15.755],
              [-96.09, 15.751],
            ],
          ],
        },
      };

      const querySpy = vi
        .spyOn(
          service as unknown as {
            queryFgbLayer: (file: string) => Promise<Feature[]>;
          },
          'queryFgbLayer',
        )
        .mockImplementation(async (fileName: string) => {
          if (fileName === 'ramsar.fgb') return [featureInsidePredio];
          if (fileName === 'anp_federal.fgb') return [featureWithin10km];
          return [];
        });

      const intersectResult = await service.getSpatialContext({
        geometry: predioPolygon,
        filterMode: 'intersect',
        planos: [2],
      });

      expect(intersectResult.layers.eco).toHaveLength(1);
      expect(intersectResult.layers.eco?.[0].properties?._layerId).toBe('ramsar');
      expect(intersectResult.layers.eco?.[0].properties?._siteName).toBe(
        'Cuencas y Corales de la Zona Costera de Huatulco',
      );
      expect(intersectResult.summary.ecologiaPredio).toHaveLength(1);

      const bufferResult = await service.getSpatialContext({
        geometry: predioPolygon,
        filterMode: 'buffer10km',
        planos: [2],
      });

      expect(bufferResult.layers.eco).toHaveLength(2);
      // En el resumen del predio solo debe figurar el sitio que realmente intersecta el polígono
      expect(bufferResult.summary.ecologiaPredio).toHaveLength(1);
      expect(querySpy).toHaveBeenCalled();
    });

    it('debe enriquecer vegetación, climas, edafología e hidrología y usar caché en consultas repetidas', async () => {
      const mockFeaturesByFile: Record<string, Feature[]> = {
        'usv_serie_7.fgb': [
          {
            type: 'Feature',
            properties: { DESCRIPCIO: 'SELVA MEDIANA CADUCIFOLIA' },
            geometry: predioPolygon,
          },
          {
            type: 'Feature',
            properties: { DESCRIPCIO: 'VEGETACIÓN SECUNDARIA ARBUSTIVA DE SELVA MEDIANA CADUCIFOLIA' },
            geometry: predioPolygon,
          },
        ],
        'climas.fgb': [
          {
            type: 'Feature',
            properties: { CLAVE: 'Aw2', TIPO_C: 'Cálido subhúmedo' },
            geometry: predioPolygon,
          },
          {
            type: 'Feature',
            properties: { CLAVE: 'P/E', TIPO_C: 'País extranjero' },
            geometry: predioPolygon,
          },
        ],
        'edafologia.fgb': [
          {
            type: 'Feature',
            properties: {
              CLAVE_WRB: 'LP/1',
              N_G1: 'LEPTOSOL',
              TEXTURA: 'Media',
              CLASE_TEX: 2,
              F_SUPERF: 'L',
            },
            geometry: predioPolygon,
          },
        ],
        'subcuencas_50k.fgb': [
          {
            type: 'Feature',
            properties: {
              CVE_SUBCUE: 'RH21Aa',
              SUBCUENCA: 'San Pedro Pochutla',
              CUENCA: 'R. COPALITA Y OTROS',
              RH: 'Costa de Oaxaca (Puerto Ángel)',
            },
            geometry: predioPolygon,
          },
        ],
        'red_hidrografica_50k.fgb': [
          {
            type: 'Feature',
            properties: { ORDER_1: 3, CONDICION: 'Intermitente', LENGTHM: 450 },
            geometry: {
              type: 'LineString',
              coordinates: [
                [-96.1315, 15.7525],
                [-96.1305, 15.7535],
              ],
            },
          },
        ],
      };

      const querySpy = vi
        .spyOn(
          service as unknown as {
            queryFgbLayer: (file: string) => Promise<Feature[]>;
          },
          'queryFgbLayer',
        )
        .mockImplementation(async (fileName: string) => mockFeaturesByFile[fileName] ?? []);

      const firstCall = await service.getSpatialContext({
        geometry: predioPolygon,
        filterMode: 'buffer10km',
        planos: [3, 4, 5, 6],
        vegSerie: 'serie_7',
      });

      expect(firstCall.success).toBe(true);
      expect(firstCall.cached).toBe(false);

      // Vegetación primaria vs secundaria con colores distintos
      expect(firstCall.layers.veg).toHaveLength(2);
      expect(firstCall.layers.veg?.[0].properties?._color).not.toBe(
        firstCall.layers.veg?.[1].properties?._color,
      );
      expect(firstCall.summary.vegetacionPredio).toContain('SELVA MEDIANA CADUCIFOLIA');

      // Climas (excluye País extranjero)
      expect(firstCall.layers.climate).toHaveLength(1);
      expect(firstCall.summary.climasPredio).toEqual(['Aw2 - Cálido subhúmedo']);

      // Edafología
      expect(firstCall.summary.edafologiaPredio[0]).toMatchObject({
        grupo: 'LEPTOSOL',
        claveWrb: 'LP/1',
        textura: 'Media',
      });

      // Hidrología 1:50k
      expect(firstCall.summary.hidrologiaPredio.subcuenca).toBe('San Pedro Pochutla');
      expect(firstCall.summary.hidrologiaPredio.cuenca).toBe('R. COPALITA Y OTROS');
      expect(firstCall.summary.hidrologiaPredio.ordenStrahlerMaximo).toBe(3);

      const callsAfterFirst = querySpy.mock.calls.length;

      // Segunda llamada idéntica debe servirse desde caché
      const secondCall = await service.getSpatialContext({
        geometry: predioPolygon,
        filterMode: 'buffer10km',
        planos: [3, 4, 5, 6],
        vegSerie: 'serie_7',
      });

      expect(secondCall.cached).toBe(true);
      expect(querySpy.mock.calls.length).toBe(callsAfterFirst);
    });
  });
});