import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { Test, TestingModule } from '@nestjs/testing';
import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import type { Feature, Polygon } from 'geojson';
import { GisModule } from '../src/gis/gis.module.js';
import { GisService } from '../src/gis/gis.service.js';
import type {
  GisContextResponseDto,
  ParsePolygonResponseDto,
} from '../src/gis/dto/gis-context.dto.js';

describe('GisController (e2e)', () => {
  let app: INestApplication;
  let gisService: GisService;

  const samplePolygon: Polygon = {
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

  beforeAll(async () => {
    process.env.R2_PUBLIC_URL = 'https://r2-e2e.profepa.gob.mx';

    const moduleFixture: TestingModule = await Test.createTestingModule({
      imports: [GisModule],
    }).compile();

    app = moduleFixture.createNestApplication();
    gisService = moduleFixture.get<GisService>(GisService);

    vi.spyOn(
      gisService as unknown as {
        queryFgbLayer: (file: string) => Promise<Feature[]>;
      },
      'queryFgbLayer',
    ).mockImplementation(async (fileName: string) => {
      if (fileName === 'anp_federal.fgb') {
        return [
          {
            type: 'Feature',
            properties: { NOMBRE: 'Huatulco II' },
            geometry: samplePolygon,
          },
        ];
      }
      return [];
    });

    await app.init();
  });

  afterAll(async () => {
    await app.close();
  });

  it('POST /gis/parse-polygon debe procesar un archivo GeoJSON adjunto y devolver áreas', async () => {
    const geojsonContent = JSON.stringify({
      type: 'FeatureCollection',
      features: [
        {
          type: 'Feature',
          properties: { NOMBRE: 'Predio E2E' },
          geometry: samplePolygon,
        },
      ],
    });

    const res = await request(app.getHttpServer())
      .post('/gis/parse-polygon')
      .attach('file', Buffer.from(geojsonContent, 'utf-8'), 'predio_e2e.geojson')
      .expect(201);

    const body = res.body as ParsePolygonResponseDto;
    expect(body.success).toBe(true);
    expect(body.polygons).toHaveLength(1);
    expect(body.polygons[0].polyId).toBe('A');
    expect(body.totalAreaM2).toBeGreaterThan(40000);
  });

  it('POST /gis/parse-polygon debe responder 400 cuando no se envía archivo', async () => {
    await request(app.getHttpServer()).post('/gis/parse-polygon').expect(400);
  });

  it('POST /gis/context debe responder 400 cuando falta geometry', async () => {
    await request(app.getHttpServer())
      .post('/gis/context')
      .send({ filterMode: 'intersect' })
      .expect(400);
  });

  it('POST /gis/context debe devolver capas, resumen y activar caché en la segunda petición', async () => {
    const payload = {
      filterMode: 'intersect',
      planos: [2],
      geometry: samplePolygon,
    };

    const firstRes = await request(app.getHttpServer())
      .post('/gis/context')
      .send(payload)
      .expect(201);

    const firstBody = firstRes.body as GisContextResponseDto;
    expect(firstBody.success).toBe(true);
    expect(firstBody.cached).toBe(false);
    expect(firstBody.layers.eco).toHaveLength(1);
    expect(firstBody.summary.ecologiaPredio[0].siteName).toBe('Huatulco II');

    const secondRes = await request(app.getHttpServer())
      .post('/gis/context')
      .send(payload)
      .expect(201);

    const secondBody = secondRes.body as GisContextResponseDto;
    expect(secondBody.cached).toBe(true);
  });
});