import { existsSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { resolve } from 'node:path';
import { Injectable, HttpException, HttpStatus, Logger, OnModuleInit } from '@nestjs/common';
import { HttpService } from '@nestjs/axios';
import { firstValueFrom } from 'rxjs';

const require = createRequire(import.meta.url);

export type SpectralPreset = 'rgb' | 'nir' | 'swir' | 'ndvi';
export type SatelliteCollectionOption = 'sentinel-2-l2a' | 'landsat-c2-l2';

export interface AnnualSearchParams {
  lat: number;
  lng: number;
  year: number;
  collection: SatelliteCollectionOption;
  preset: SpectralPreset;
}

export interface TemporalSceneItem {
  id: string;
  year: number;
  date: string;
  cloudCover: number;
  platform: string;
  collection: SatelliteCollectionOption;
  tileUrl: string;
}

interface EeMapIdResult {
  mapid: string;
  urlFormat?: string;
}

interface EeImageInfo {
  properties?: Record<string, unknown>;
}

interface EeImage {
  normalizedDifference: (bands: [string, string]) => EeImage;
  evaluate: (cb: (info: EeImageInfo | null, err?: string) => void) => void;
  getMapId: (
    visParams: Record<string, unknown>,
    cb: (mapId: EeMapIdResult | null, err?: string) => void,
  ) => void;
}

interface EeImageCollection {
  select: (oldNames: string[], newNames: string[]) => EeImageCollection;
  merge: (other: EeImageCollection) => EeImageCollection;
  filterBounds: (geom: unknown) => EeImageCollection;
  filterDate: (start: string, end: string) => EeImageCollection;
  filter: (filter: unknown) => EeImageCollection;
  sort: (prop: string) => EeImageCollection;
  size: () => { gt: (n: number) => unknown };
  first: () => EeImage;
}

interface EeClient {
  data: {
    authenticateViaPrivateKey: (
      privateKey: Record<string, unknown>,
      onSuccess: () => void,
      onError: (err: string) => void,
    ) => void;
  };
  initialize: (
    baseurl: string | null,
    tileurl: string | null,
    onSuccess: () => void,
    onError: (err: string) => void,
    opt_xsrfToken: string | null,
    project: string,
  ) => void;
  Geometry: {
    Point: (coords: [number, number]) => unknown;
  };
  Filter: {
    lt: (name: string, value: number) => unknown;
  };
  Algorithms: {
    If: (condition: unknown, trueCase: unknown, falseCase: unknown) => unknown;
  };
  ImageCollection: (id: string) => EeImageCollection;
  Image: (img: unknown) => EeImage;
}

interface StacFeature {
  id: string;
  properties: {
    datetime: string;
    'eo:cloud_cover'?: number;
    platform?: string;
  };
}

@Injectable()
export class SentinelService implements OnModuleInit {
  private readonly logger = new Logger(SentinelService.name);
  private readonly ee = require('@google/earthengine') as EeClient;
  private readonly projectId = process.env.GEE_PROJECT_ID ?? 'flash-physics-471715-s8';
  private geeReady = false;
  private geeInitPromise: Promise<boolean> | null = null;

  constructor(private readonly httpService: HttpService) {}

  async onModuleInit(): Promise<void> {
    await this.ensureGeeInitialized();
  }

  private loadServiceAccountKey(): Record<string, unknown> | null {
    const envJson = process.env.GEE_SERVICE_ACCOUNT_JSON?.trim();
    if (envJson) {
      return JSON.parse(envJson) as Record<string, unknown>;
    }

    const keyFilePath = resolve(process.cwd(), process.env.GEE_KEY_FILE ?? 'gee-key.json');
    if (existsSync(keyFilePath)) {
      return JSON.parse(readFileSync(keyFilePath, 'utf-8')) as Record<string, unknown>;
    }

    return null;
  }

  private ensureGeeInitialized(): Promise<boolean> {
    if (this.geeReady) return Promise.resolve(true);
    if (this.geeInitPromise) return this.geeInitPromise;

    this.geeInitPromise = new Promise<boolean>((resolveInit) => {
      let privateKey: Record<string, unknown> | null = null;
      try {
        privateKey = this.loadServiceAccountKey();
      } catch (err) {
        this.logger.error(`JSON de Cuenta de Servicio GEE inválido: ${String(err)}`);
        this.geeInitPromise = null;
        resolveInit(false);
        return;
      }

      if (!privateKey) {
        this.logger.warn(
          'No se encontró GEE_SERVICE_ACCOUNT_JSON ni gee-key.json; se usará Planetary Computer.',
        );
        this.geeInitPromise = null;
        resolveInit(false);
        return;
      }

      this.ee.data.authenticateViaPrivateKey(
        privateKey,
        () => {
          this.ee.initialize(
            null,
            null,
            () => {
              this.geeReady = true;
              this.logger.log(`Google Earth Engine inicializado en proyecto ${this.projectId}`);
              resolveInit(true);
            },
            (initErr) => {
              this.logger.error(`Error al inicializar GEE: ${initErr}`);
              this.geeInitPromise = null;
              resolveInit(false);
            },
            null,
            this.projectId,
          );
        },
        (authErr) => {
          this.logger.error(`Error de autenticación GEE con Cuenta de Servicio: ${authErr}`);
          this.geeInitPromise = null;
          resolveInit(false);
        },
      );
    });

    return this.geeInitPromise;
  }

  private buildGeeSelection(
    lat: number,
    lng: number,
    startDate: string,
    endDate: string,
    collection: SatelliteCollectionOption,
  ): EeImage {
    const point = this.ee.Geometry.Point([lng, lat]);

    if (collection === 'sentinel-2-l2a') {
      const col = this.ee
        .ImageCollection('COPERNICUS/S2_SR_HARMONIZED')
        .filterBounds(point)
        .filterDate(startDate, endDate);
      const clearCol = col.filter(this.ee.Filter.lt('CLOUDY_PIXEL_PERCENTAGE', 45));
      return this.ee.Image(
        this.ee.Algorithms.If(
          clearCol.size().gt(0),
          clearCol.sort('CLOUDY_PIXEL_PERCENTAGE').first(),
          col.sort('CLOUDY_PIXEL_PERCENTAGE').first(),
        ),
      );
    }

    const l9 = this.ee
      .ImageCollection('LANDSAT/LC09/C02/T1_L2')
      .select(['SR_B4', 'SR_B3', 'SR_B2', 'SR_B5', 'SR_B6'], ['RED', 'GREEN', 'BLUE', 'NIR', 'SWIR']);
    const l8 = this.ee
      .ImageCollection('LANDSAT/LC08/C02/T1_L2')
      .select(['SR_B4', 'SR_B3', 'SR_B2', 'SR_B5', 'SR_B6'], ['RED', 'GREEN', 'BLUE', 'NIR', 'SWIR']);
    const l7 = this.ee
      .ImageCollection('LANDSAT/LE07/C02/T1_L2')
      .select(['SR_B3', 'SR_B2', 'SR_B1', 'SR_B4', 'SR_B5'], ['RED', 'GREEN', 'BLUE', 'NIR', 'SWIR']);
    const l5 = this.ee
      .ImageCollection('LANDSAT/LT05/C02/T1_L2')
      .select(['SR_B3', 'SR_B2', 'SR_B1', 'SR_B4', 'SR_B5'], ['RED', 'GREEN', 'BLUE', 'NIR', 'SWIR']);

    const merged = l9.merge(l8).merge(l7).merge(l5).filterBounds(point).filterDate(startDate, endDate);
    const clearCol = merged.filter(this.ee.Filter.lt('CLOUD_COVER', 45));

    return this.ee.Image(
      this.ee.Algorithms.If(
        clearCol.size().gt(0),
        clearCol.sort('CLOUD_COVER').first(),
        merged.sort('CLOUD_COVER').first(),
      ),
    );
  }

  private getVisualization(
    image: EeImage,
    collection: SatelliteCollectionOption,
    preset: SpectralPreset,
  ): { visImage: EeImage; visParams: Record<string, unknown> } {
    const isSentinel = collection === 'sentinel-2-l2a';

    if (preset === 'ndvi') {
      const ndvi = isSentinel
        ? image.normalizedDifference(['B8', 'B4'])
        : image.normalizedDifference(['NIR', 'RED']);
      return {
        visImage: ndvi,
        visParams: {
          min: 0.0,
          max: 0.85,
          palette: ['#d73027', '#fee08b', '#d9ef8b', '#66bd63', '#1a9850'],
        },
      };
    }

    if (isSentinel) {
      const bandsByPreset: Record<Exclude<SpectralPreset, 'ndvi'>, string[]> = {
        rgb: ['B4', 'B3', 'B2'],
        nir: ['B8', 'B4', 'B3'],
        swir: ['B11', 'B8', 'B4'],
      };
      return {
        visImage: image,
        visParams: {
          bands: bandsByPreset[preset],
          min: 0,
          max: preset === 'rgb' ? 3000 : 3800,
          gamma: 1.2,
        },
      };
    }

    const landsatBands: Record<Exclude<SpectralPreset, 'ndvi'>, string[]> = {
      rgb: ['RED', 'GREEN', 'BLUE'],
      nir: ['NIR', 'RED', 'GREEN'],
      swir: ['SWIR', 'NIR', 'RED'],
    };
    return {
      visImage: image,
      visParams: {
        bands: landsatBands[preset],
        min: 7300,
        max: 18200,
        gamma: 1.2,
      },
    };
  }

  private async queryGeeScene(
    lat: number,
    lng: number,
    year: number,
    startDate: string,
    endDate: string,
    collection: SatelliteCollectionOption,
    preset: SpectralPreset,
  ): Promise<TemporalSceneItem | null> {
    const ready = await this.ensureGeeInitialized();
    if (!ready) return null;

    const bestImage = this.buildGeeSelection(lat, lng, startDate, endDate, collection);

    const info = await new Promise<EeImageInfo | null>((resolveEval, rejectEval) => {
      bestImage.evaluate((res, err) => {
        if (err) rejectEval(new Error(err));
        else resolveEval(res);
      });
    });

    if (!info?.properties) return null;

    const { visImage, visParams } = this.getVisualization(bestImage, collection, preset);
    const mapId = await new Promise<EeMapIdResult>((resolveMap, rejectMap) => {
      visImage.getMapId(visParams, (res, err) => {
        if (err || !res) rejectMap(new Error(err ?? 'No se pudo generar el mapa en GEE'));
        else resolveMap(res);
      });
    });

    const props = info.properties;
    const rawTime = Number(props['system:time_start']);
    const isoDate = Number.isFinite(rawTime)
      ? new Date(rawTime).toISOString()
      : `${year}-06-15T12:00:00Z`;

    const rawCloud = Number(props.CLOUDY_PIXEL_PERCENTAGE ?? props.CLOUD_COVER ?? 0);
    const platform = String(props.SPACECRAFT_NAME ?? props.SPACECRAFT_ID ?? collection);
    const tileUrl =
      mapId.urlFormat ?? `https://earthengine.googleapis.com/v1/${mapId.mapid}/tiles/{z}/{x}/{y}`;

    return {
      id: String(props['system:index'] ?? `${collection}_${year}`),
      year,
      date: isoDate,
      cloudCover: Number((Number.isFinite(rawCloud) ? rawCloud : 0).toFixed(1)),
      platform,
      collection,
      tileUrl,
    };
  }

  // Respaldo automático con Microsoft Planetary Computer si GEE no está configurado o falla
  private async queryPlanetaryComputerFallback(
    lat: number,
    lng: number,
    year: number,
    startDate: string,
    endDate: string,
    collection: SatelliteCollectionOption,
    preset: SpectralPreset,
  ): Promise<TemporalSceneItem | null> {
    const stacUrl = 'https://planetarycomputer.microsoft.com/api/stac/v1/search';
    const tileBase =
      'https://planetarycomputer.microsoft.com/api/data/v1/item/tiles/WebMercatorQuad/{z}/{x}/{y}@1x';

    const response = await firstValueFrom(
      this.httpService.post<{ features?: StacFeature[] }>(
        stacUrl,
        {
          collections: [collection],
          intersects: { type: 'Point', coordinates: [lng, lat] },
          datetime: `${startDate}T00:00:00Z/${endDate}T23:59:59Z`,
          limit: 50,
        },
        { headers: { 'Content-Type': 'application/json' } },
      ),
    );

    const features = response.data?.features ?? [];
    if (features.length === 0) return null;

    const sorted = [...features].sort(
      (a, b) => (a.properties['eo:cloud_cover'] ?? 100) - (b.properties['eo:cloud_cover'] ?? 100),
    );
    const best = sorted[0];

    let bandQuery = 'assets=B04&assets=B03&assets=B02&rescale=0,3000';
    if (collection === 'sentinel-2-l2a') {
      if (preset === 'nir') bandQuery = 'assets=B08&assets=B04&assets=B03&rescale=0,3800';
      if (preset === 'swir') bandQuery = 'assets=B11&assets=B08&assets=B04&rescale=0,3800';
      if (preset === 'ndvi')
        bandQuery = 'expression=(B08-B04)/(B08+B04)&asset_as_band=true&rescale=-0.1,0.85&colormap_name=rdylgn';
    } else {
      bandQuery = 'assets=red&assets=green&assets=blue&rescale=7300,18200';
      if (preset === 'nir') bandQuery = 'assets=nir08&assets=red&assets=green&rescale=7300,18200';
      if (preset === 'swir') bandQuery = 'assets=swir16&assets=nir08&assets=red&rescale=7300,18200';
      if (preset === 'ndvi')
        bandQuery = 'expression=(nir08-red)/(nir08+red)&asset_as_band=true&rescale=-0.1,0.85&colormap_name=rdylgn';
    }

    return {
      id: best.id,
      year,
      date: best.properties.datetime,
      cloudCover: Number((best.properties['eo:cloud_cover'] ?? 0).toFixed(1)),
      platform: best.properties.platform ?? collection,
      collection,
      tileUrl: `${tileBase}?collection=${collection}&item=${encodeURIComponent(best.id)}&${bandQuery}&resampling=bilinear`,
    };
  }

  async getBestImagery(lat: number, lng: number, targetDate: string) {
    const baseDate = new Date(targetDate);
    const start = new Date(baseDate.getTime() - 20 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
    const end = new Date(baseDate.getTime() + 20 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
    const year = baseDate.getUTCFullYear();

    let scene: TemporalSceneItem | null = null;
    try {
      scene = await this.queryGeeScene(lat, lng, year, start, end, 'sentinel-2-l2a', 'rgb');
    } catch (err) {
      this.logger.warn(`Fallo GEE en Plano 1, usando respaldo: ${String(err)}`);
    }

    scene ??= await this.queryPlanetaryComputerFallback(
      lat,
      lng,
      year,
      start,
      end,
      'sentinel-2-l2a',
      'rgb',
    );

    if (!scene) {
      throw new HttpException(
        'No hay imágenes satelitales despejadas en esta fecha.',
        HttpStatus.NOT_FOUND,
      );
    }

    return {
      success: true,
      tileUrl: scene.tileUrl,
      metadata: {
        id: scene.id,
        date: scene.date,
        cloudCover: scene.cloudCover,
        platform: scene.platform,
      },
    };
  }

  async getBestAnnualScene(params: AnnualSearchParams) {
    const { lat, lng, year, collection, preset } = params;

    if (collection === 'sentinel-2-l2a' && year < 2017) {
      throw new HttpException(
        'Copernicus Sentinel-2 SR en GEE inicia en 2017. Selecciona Landsat Histórico para años anteriores.',
        HttpStatus.BAD_REQUEST,
      );
    }

    const startDate = `${year}-01-01`;
    const endDate = `${year}-12-31`;

    let scene: TemporalSceneItem | null = null;
    try {
      scene = await this.queryGeeScene(lat, lng, year, startDate, endDate, collection, preset);
    } catch (err) {
      this.logger.warn(`Fallo GEE (${year}), usando respaldo Planetary Computer: ${String(err)}`);
    }

    scene ??= await this.queryPlanetaryComputerFallback(
      lat,
      lng,
      year,
      startDate,
      endDate,
      collection,
      preset,
    );

    if (!scene) {
      throw new HttpException(
        `No se encontraron escenas disponibles para el año ${year}.`,
        HttpStatus.NOT_FOUND,
      );
    }

    return {
      success: true,
      scene,
    };
  }
}