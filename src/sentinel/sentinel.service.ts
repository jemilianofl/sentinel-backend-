import { existsSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { resolve } from 'node:path';
import { Injectable, HttpException, HttpStatus, Logger, OnModuleInit } from '@nestjs/common';
import { HttpService } from '@nestjs/axios';
import { firstValueFrom } from 'rxjs';

const require = createRequire(import.meta.url);

export type SpectralPreset = 'rgb' | 'nir' | 'swir' | 'ndvi';
export type SatelliteCollectionOption = 'sentinel-2-l2a' | 'landsat-c2-l2';
/** [minLng, minLat, maxLng, maxLat] en EPSG:4326 */
export type BBox = [number, number, number, number];

export interface AnnualSearchParams {
  lat: number;
  lng: number;
  year: number;
  collection: SatelliteCollectionOption;
  preset: SpectralPreset;
  /** Área de interés (polígono + buffer). Si viene, la escena se elige por despeje sobre el AOI y se genera miniatura. */
  bbox?: BBox | null;
}

export interface TemporalSceneItem {
  id: string;
  year: number;
  date: string;
  cloudCover: number;
  platform: string;
  collection: SatelliteCollectionOption;
  tileUrl: string;
  /** Miniatura PNG del AOI (EPSG:4326) para la galería multitemporal. */
  thumbUrl?: string | null;
  bbox?: BBox | null;
  /** % del AOI cubierto y libre de nubes/sombras (Cloud Score+), solo Sentinel-2 con bbox. */
  aoiClearPct?: number | null;
  /** L2A (reflectancia de superficie), L1C (TOA, 2015-2018) o L2 (Landsat). */
  processingLevel?: string | null;
  /** Origen de la escena: 'gee' (selección por AOI) o 'aws-stac' (respaldo). */
  source?: 'gee' | 'aws-stac';
}

interface EeMapIdResult {
  mapid: string;
  urlFormat?: string;
}

interface EeImageInfo {
  id?: string;
  properties?: Record<string, unknown>;
}

interface EeComputedNumber {
  gt: (n: number) => unknown;
  gte: (n: number) => unknown;
  multiply: (n: number) => EeComputedNumber;
  subtract: (n: unknown) => EeComputedNumber;
}

interface EeImage {
  select: (bands: string | string[]) => EeImage;
  gte: (value: number) => EeImage;
  unmask: (value: number, sameFootprint?: boolean) => EeImage;
  set: (key: string, value: unknown) => EeImage;
  get: (key: string) => unknown;
  bandNames: () => { contains: (name: string) => unknown };
  reduceRegion: (args: Record<string, unknown>) => { get: (key: string) => unknown };
  normalizedDifference: (bands: [string, string]) => EeImage;
  evaluate: (cb: (info: EeImageInfo | null, err?: string) => void) => void;
  getMapId: (
    visParams: Record<string, unknown>,
    cb: (mapId: EeMapIdResult | null, err?: string) => void,
  ) => void;
  getThumbURL: (params: Record<string, unknown>, cb: (url: string | null, err?: string) => void) => void;
}

interface EeImageCollection {
  select: (oldNames: string[], newNames: string[]) => EeImageCollection;
  merge: (other: EeImageCollection) => EeImageCollection;
  filterBounds: (geom: unknown) => EeImageCollection;
  filterDate: (start: string, end: string) => EeImageCollection;
  filter: (filter: unknown) => EeImageCollection;
  sort: (prop: string, ascending?: boolean) => EeImageCollection;
  size: () => EeComputedNumber;
  first: () => EeImage;
  map: (fn: (img: EeImage) => EeImage) => EeImageCollection;
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
    Rectangle: (coords: number[], proj?: string | null, geodesic?: boolean) => unknown;
  };
  Filter: {
    lt: (name: string, value: number) => unknown;
    equals: (args: { leftField: string; rightField: string }) => unknown;
  };
  Join: {
    saveFirst: (matchKey: string) => { apply: (primary: unknown, secondary: unknown, condition: unknown) => unknown };
  };
  Reducer: {
    mean: () => unknown;
  };
  Algorithms: {
    If: (condition: unknown, trueCase: unknown, falseCase: unknown) => unknown;
  };
  Number: (value: unknown) => EeComputedNumber;
  ImageCollection: (id: unknown) => EeImageCollection;
  Image: (img: unknown) => EeImage;
}

interface AwsStacGeometry {
  type: string;
  coordinates: unknown;
}

interface AwsStacFeature {
  id: string;
  geometry?: AwsStacGeometry | null;
  links?: { rel: string; href: string }[];
  properties: {
    datetime: string;
    'eo:cloud_cover'?: number;
    platform?: string;
  };
}

/** Umbral de píxel limpio de Cloud Score+ (el script forense usa 0.65; 0.60 es un poco más tolerante en selva). */
const CS_CLEAR_THRESHOLD = 0.6;
/** Lado máximo (px) de las miniaturas de la galería. */
const THUMB_MAX_SIDE = 384;
/** S2_SR_HARMONIZED tiene cobertura irregular en México antes de dic-2018: si hay pocas escenas L2A se usa L1C. */
const MIN_SR_SCENES = 6;

@Injectable()
export class SentinelService implements OnModuleInit {
  private readonly logger = new Logger(SentinelService.name);
  private readonly ee = require('@google/earthengine') as EeClient;
  private readonly projectId = process.env.GEE_PROJECT_ID ?? 'flash-physics-471715-s8';
  private readonly sceneCache = new Map<string, { expiresAt: number; scene: TemporalSceneItem }>();
  private readonly CACHE_TTL_MS = 30 * 60 * 1000;
  private geeReady = false;
  private geeInitPromise: Promise<boolean> | null = null;

  constructor(private readonly httpService: HttpService) {}

  async onModuleInit(): Promise<void> {
    await this.ensureGeeInitialized();
  }

  private getCachedScene(key: string): TemporalSceneItem | null {
    const entry = this.sceneCache.get(key);
    if (!entry) return null;
    if (Date.now() > entry.expiresAt) {
      this.sceneCache.delete(key);
      return null;
    }
    return entry.scene;
  }

  private setCachedScene(key: string, scene: TemporalSceneItem): void {
    // Una serie Landsat completa son ~43 años por polígono: margen holgado
    if (this.sceneCache.size >= 400) {
      const oldest = this.sceneCache.keys().next().value;
      if (oldest) this.sceneCache.delete(oldest);
    }
    this.sceneCache.set(key, { expiresAt: Date.now() + this.CACHE_TTL_MS, scene });
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
          'Variable GEE_SERVICE_ACCOUNT_JSON no configurada; se usará AWS Earth Search STAC.',
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

  private bboxToGeoJson(bbox: BBox) {
    const [minX, minY, maxX, maxY] = bbox;
    return {
      type: 'Polygon',
      coordinates: [
        [
          [minX, minY],
          [maxX, minY],
          [maxX, maxY],
          [minX, maxY],
          [minX, minY],
        ],
      ],
    };
  }

  private thumbDimensions(bbox: BBox): string {
    const w = bbox[2] - bbox[0];
    const h = bbox[3] - bbox[1];
    if (w >= h) {
      return `${THUMB_MAX_SIDE}x${Math.max(32, Math.round((THUMB_MAX_SIDE * h) / w))}`;
    }
    return `${Math.max(32, Math.round((THUMB_MAX_SIDE * w) / h))}x${THUMB_MAX_SIDE}`;
  }

  /**
   * Colección Sentinel-2 del periodo: L2A si hay suficientes escenas, si no L1C.
   * (S2_SR_HARMONIZED no existe antes de 2017 y es escasa en México hasta finales de 2018.)
   */
  private buildSentinelCollection(region: unknown, startDate: string, endDate: string): EeImageCollection {
    const l1c = this.ee
      .ImageCollection('COPERNICUS/S2_HARMONIZED')
      .filterBounds(region)
      .filterDate(startDate, endDate);

    if (endDate < '2017-04-01') return l1c;

    const sr = this.ee
      .ImageCollection('COPERNICUS/S2_SR_HARMONIZED')
      .filterBounds(region)
      .filterDate(startDate, endDate);

    return this.ee.ImageCollection(this.ee.Algorithms.If(sr.size().gte(MIN_SR_SCENES), sr, l1c));
  }

  /**
   * Selección por AOI (misma lógica que evidencia_forense_sentinel.py):
   * Cloud Score+ por píxel, fracción del AOI cubierta y despejada, se elige la escena más limpia.
   */
  private selectSentinelByAoi(bbox: BBox, startDate: string, endDate: string): EeImage {
    const region = this.ee.Geometry.Rectangle([...bbox], null, false);
    const base = this.buildSentinelCollection(region, startDate, endDate);
    const candidates = base.filter(this.ee.Filter.lt('CLOUDY_PIXEL_PERCENTAGE', 80));

    const cs = this.ee
      .ImageCollection('GOOGLE/CLOUD_SCORE_PLUS/V1/S2_HARMONIZED')
      .filterBounds(region)
      .filterDate(startDate, endDate);

    // Join por system:index (equivale a linkCollection, pero funciona con cualquier versión
    // del paquete @google/earthengine; linkCollection no existe en versiones antiguas).
    const joined = this.ee.ImageCollection(
      this.ee.Join.saveFirst('CS_MATCH').apply(
        candidates,
        cs,
        this.ee.Filter.equals({ leftField: 'system:index', rightField: 'system:index' }),
      ),
    );

    const scored = joined.map((img) => {
      // unmask(0, false): sameFootprint=false para que lo que queda FUERA de la huella de la
      // escena cuente como NO despejado. Con el valor por defecto (true) una escena que solo
      // toca el borde del AOI saldría 100 % despejada.
      const clearFraction = this.ee.Algorithms.If(
        img.get('CS_MATCH'),
        this.ee
          .Image(img.get('CS_MATCH'))
          .select('cs_cdf')
          .gte(CS_CLEAR_THRESHOLD)
          .unmask(0, false)
          .reduceRegion({
            reducer: this.ee.Reducer.mean(),
            geometry: region,
            scale: 20,
            maxPixels: 1e8,
          })
          .get('cs_cdf'),
        0,
      );
      const clear = this.ee.Number(this.ee.Algorithms.If(clearFraction, clearFraction, 0));
      // Desempate: menor nubosidad de escena
      const score = clear
        .multiply(100)
        .subtract(this.ee.Number(img.get('CLOUDY_PIXEL_PERCENTAGE')).multiply(0.01));
      return img.set('AOI_CLEAR', clear).set('AOI_SCORE', score);
    });

    return this.ee.Image(
      this.ee.Algorithms.If(
        candidates.size().gt(0),
        scored.sort('AOI_SCORE', false).first(),
        base.sort('CLOUDY_PIXEL_PERCENTAGE').first(),
      ),
    );
  }

  private buildGeeSelection(
    lat: number,
    lng: number,
    startDate: string,
    endDate: string,
    collection: SatelliteCollectionOption,
    bbox?: BBox | null,
  ): EeImage {
    const region = bbox ? this.ee.Geometry.Rectangle([...bbox], null, false) : this.ee.Geometry.Point([lng, lat]);

    if (collection === 'sentinel-2-l2a') {
      if (bbox) return this.selectSentinelByAoi(bbox, startDate, endDate);

      const col = this.buildSentinelCollection(region, startDate, endDate);
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

    const merged = l9.merge(l8).merge(l7).merge(l5).filterBounds(region).filterDate(startDate, endDate);
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

  private generateGeeThumb(
    visImage: EeImage,
    visParams: Record<string, unknown>,
    bbox: BBox,
  ): Promise<string | null> {
    return new Promise((resolveThumb) => {
      try {
        visImage.getThumbURL(
          {
            ...visParams,
            region: this.bboxToGeoJson(bbox),
            dimensions: this.thumbDimensions(bbox),
            crs: 'EPSG:4326',
            format: 'png',
          },
          (url, err) => {
            if (err || !url) {
              this.logger.warn(`No se pudo generar miniatura GEE: ${err ?? 'sin URL'}`);
              resolveThumb(null);
            } else {
              resolveThumb(url);
            }
          },
        );
      } catch (err) {
        this.logger.warn(`Error generando miniatura GEE: ${String(err)}`);
        resolveThumb(null);
      }
    });
  }

  private resolveProcessingLevel(info: EeImageInfo, collection: SatelliteCollectionOption): string {
    if (collection === 'landsat-c2-l2') return 'L2';
    const id = info.id ?? '';
    if (id.includes('S2_SR')) return 'L2A';
    if (id.includes('S2_HARMONIZED')) return 'L1C';
    return 'L2A';
  }

  private async queryGeeScene(
    lat: number,
    lng: number,
    year: number,
    startDate: string,
    endDate: string,
    collection: SatelliteCollectionOption,
    preset: SpectralPreset,
    bbox?: BBox | null,
  ): Promise<TemporalSceneItem | null> {
    const ready = await this.ensureGeeInitialized();
    if (!ready) return null;

    const bestImage = this.buildGeeSelection(lat, lng, startDate, endDate, collection, bbox);

    const info = await new Promise<EeImageInfo | null>((resolveEval, rejectEval) => {
      bestImage.evaluate((res, err) => {
        if (err) rejectEval(new Error(err));
        else resolveEval(res);
      });
    });

    if (!info?.properties) return null;

    const { visImage, visParams } = this.getVisualization(bestImage, collection, preset);
    const [mapId, thumbUrl] = await Promise.all([
      new Promise<EeMapIdResult>((resolveMap, rejectMap) => {
        visImage.getMapId(visParams, (res, err) => {
          if (err || !res) rejectMap(new Error(err ?? 'No se pudo generar el mapa en GEE'));
          else resolveMap(res);
        });
      }),
      bbox ? this.generateGeeThumb(visImage, visParams, bbox) : Promise.resolve(null),
    ]);

    const props = info.properties;
    const rawTime = Number(props['system:time_start']);
    const isoDate = Number.isFinite(rawTime)
      ? new Date(rawTime).toISOString()
      : `${year}-06-15T12:00:00Z`;

    const rawCloud = Number(props.CLOUDY_PIXEL_PERCENTAGE ?? props.CLOUD_COVER ?? 0);
    const platform = String(props.SPACECRAFT_NAME ?? props.SPACECRAFT_ID ?? collection);
    const tileUrl =
      mapId.urlFormat ?? `https://earthengine.googleapis.com/v1/${mapId.mapid}/tiles/{z}/{x}/{y}`;
    const rawAoiClear = Number(props.AOI_CLEAR);

    return {
      id: String(props['system:index'] ?? `${collection}_${year}`),
      year,
      date: isoDate,
      cloudCover: Number((Number.isFinite(rawCloud) ? rawCloud : 0).toFixed(1)),
      platform,
      collection,
      tileUrl,
      thumbUrl,
      bbox: bbox ?? null,
      aoiClearPct: Number.isFinite(rawAoiClear) ? Number((rawAoiClear * 100).toFixed(1)) : null,
      processingLevel: this.resolveProcessingLevel(info, collection),
      source: 'gee',
    };
  }

  /**
   * Fracción del bbox cubierta por la huella real de la escena STAC (malla de 7×7 puntos).
   * Earth Search publica en `geometry` la zona con datos válidos, no el cuadro de la tesela MGRS.
   */
  private stacCoverage(geometry: AwsStacGeometry | null | undefined, bbox: BBox): number {
    if (!geometry) return 0;
    let polygons: number[][][][] = [];
    if (geometry.type === 'Polygon') polygons = [geometry.coordinates as number[][][]];
    else if (geometry.type === 'MultiPolygon') polygons = geometry.coordinates as number[][][][];
    else return 0;

    const inRing = (x: number, y: number, ring: number[][]): boolean => {
      let inside = false;
      for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
        const [xi, yi] = ring[i];
        const [xj, yj] = ring[j];
        if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
      }
      return inside;
    };
    const inGeometry = (x: number, y: number) =>
      polygons.some(
        (poly) => poly.length > 0 && inRing(x, y, poly[0]) && !poly.slice(1).some((hole) => inRing(x, y, hole)),
      );

    const steps = 7;
    let inside = 0;
    for (let i = 0; i < steps; i++) {
      for (let j = 0; j < steps; j++) {
        const x = bbox[0] + ((bbox[2] - bbox[0]) * i) / (steps - 1);
        const y = bbox[1] + ((bbox[3] - bbox[1]) * j) / (steps - 1);
        if (inGeometry(x, y)) inside++;
      }
    }
    return inside / (steps * steps);
  }

  // Respaldo con AWS Earth Search STAC (no bloquea IPs de Render como Planetary Computer)
  private async queryAwsStacFallback(
    lat: number,
    lng: number,
    year: number,
    startDate: string,
    endDate: string,
    collection: SatelliteCollectionOption,
    preset: SpectralPreset,
    bbox?: BBox | null,
  ): Promise<TemporalSceneItem | null> {
    const stacUrl = 'https://earth-search.aws.element84.com/v1/search';

    try {
      const response = await firstValueFrom(
        this.httpService.post<{ features?: AwsStacFeature[] }>(
          stacUrl,
          {
            collections: [collection],
            intersects: bbox ? this.bboxToGeoJson(bbox) : { type: 'Point', coordinates: [lng, lat] },
            datetime: `${startDate}T00:00:00Z/${endDate}T23:59:59Z`,
            query: { 'eo:cloud_cover': { lt: 60 } },
            sortby: [{ field: 'properties.eo:cloud_cover', direction: 'asc' }],
            limit: 100,
          },
          { headers: { 'Content-Type': 'application/json' }, timeout: 15000 },
        ),
      );

      const features = response.data?.features ?? [];
      if (features.length === 0) return null;

      const cloud = (f: AwsStacFeature) => f.properties['eo:cloud_cover'] ?? 100;
      let best: AwsStacFeature;

      if (bbox) {
        // 1º cobertura del AOI (las teselas de borde de órbita quedan al final), 2º nubosidad
        const ranked = features
          .map((f) => ({ f, cov: this.stacCoverage(f.geometry, bbox) }))
          .sort((a, b) => (Math.abs(b.cov - a.cov) > 0.01 ? b.cov - a.cov : cloud(a.f) - cloud(b.f)));
        best = ranked[0].f;
        const coverage = ranked[0].cov;
        if (coverage < 0.95) {
          this.logger.warn(
            `AWS STAC ${year}: ninguna escena cubre completo el AOI (mejor cobertura ${(coverage * 100).toFixed(0)}%).`,
          );
        }
      } else {
        best = [...features].sort((a, b) => cloud(a) - cloud(b))[0];
      }
      const selfLink = best.links?.find((l) => l.rel === 'self')?.href;
      if (!selfLink) return null;

      const isLandsat = collection === 'landsat-c2-l2';
      const rescale = isLandsat ? '7300,18200' : preset === 'rgb' ? '0,3000' : '0,3800';
      const nirAsset = isLandsat ? 'nir08' : 'nir';

      let assetsQuery = 'assets=red&assets=green&assets=blue';
      if (preset === 'nir') assetsQuery = `assets=${nirAsset}&assets=red&assets=green`;
      if (preset === 'swir') assetsQuery = `assets=swir16&assets=${nirAsset}&assets=red`;

      const commonQuery = `url=${encodeURIComponent(selfLink)}&${assetsQuery}&rescale=${rescale}&resampling=bilinear`;
      const tileUrl = `https://titiler.xyz/stac/tiles/WebMercatorQuad/{z}/{x}/{y}?${commonQuery}`;
      const thumbUrl = bbox
        ? `https://titiler.xyz/stac/bbox/${bbox.join(',')}/${this.thumbDimensions(bbox)}.png?${commonQuery}`
        : null;

      return {
        id: best.id,
        year,
        date: best.properties.datetime,
        cloudCover: Number((best.properties['eo:cloud_cover'] ?? 0).toFixed(1)),
        platform: best.properties.platform ?? collection,
        collection,
        tileUrl,
        thumbUrl,
        bbox: bbox ?? null,
        aoiClearPct: null,
        processingLevel: isLandsat ? 'L2' : 'L2A',
        source: 'aws-stac',
      };
    } catch (error: unknown) {
      const msg = error instanceof Error ? error.message : String(error);
      this.logger.warn(`Respaldo AWS STAC sin resultados (${year}): ${msg}`);
      return null;
    }
  }

  async getBestImagery(lat: number, lng: number, targetDate: string) {
    const cacheKey = `tiles|${lat.toFixed(4)}|${lng.toFixed(4)}|${targetDate}`;
    const cached = this.getCachedScene(cacheKey);
    if (cached) {
      return {
        success: true,
        tileUrl: cached.tileUrl,
        metadata: {
          id: cached.id,
          date: cached.date,
          cloudCover: cached.cloudCover,
          platform: cached.platform,
        },
      };
    }

    const baseDate = new Date(targetDate);
    const start = new Date(baseDate.getTime() - 25 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
    const end = new Date(baseDate.getTime() + 25 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
    const year = baseDate.getUTCFullYear();

    let scene: TemporalSceneItem | null = null;
    try {
      scene = await this.queryGeeScene(lat, lng, year, start, end, 'sentinel-2-l2a', 'rgb');
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      this.logger.warn(`Fallo GEE en Plano 1 (${targetDate}): ${msg}`);
    }

    scene ??= await this.queryAwsStacFallback(
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

    this.setCachedScene(cacheKey, scene);
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
    const { lat, lng, year, collection, preset, bbox } = params;

    if (collection === 'sentinel-2-l2a' && year < 2015) {
      throw new HttpException(
        'Copernicus Sentinel-2 inicia en 2015. Selecciona Landsat Histórico para años anteriores.',
        HttpStatus.BAD_REQUEST,
      );
    }

    const bboxKey = bbox ? bbox.map((v) => v.toFixed(5)).join(',') : 'pt';
    const cacheKey = `annual|${lat.toFixed(4)}|${lng.toFixed(4)}|${year}|${collection}|${preset}|${bboxKey}`;
    const cached = this.getCachedScene(cacheKey);
    if (cached) {
      return { success: true, scene: cached };
    }

    const startDate = `${year}-01-01`;
    // Año en curso: no consultar fechas futuras
    const today = new Date().toISOString().slice(0, 10);
    const endDate = `${year}-12-31` > today ? today : `${year}-12-31`;

    let scene: TemporalSceneItem | null = null;
    try {
      scene = await this.queryGeeScene(lat, lng, year, startDate, endDate, collection, preset, bbox);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      this.logger.warn(`Fallo GEE (${year} - ${collection}); se usará AWS STAC: ${msg}`);
    }

    scene ??= await this.queryAwsStacFallback(
      lat,
      lng,
      year,
      startDate,
      endDate,
      collection,
      preset,
      bbox,
    );

    if (!scene) {
      throw new HttpException(
        `No se encontraron escenas disponibles para el año ${year}.`,
        HttpStatus.NOT_FOUND,
      );
    }

    this.setCachedScene(cacheKey, scene);
    return {
      success: true,
      scene,
    };
  }
}