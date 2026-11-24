import {
  Injectable,
  BadRequestException,
  InternalServerErrorException,
  Logger,
} from '@nestjs/common';
import * as turf from '@turf/turf';
import { geojson as fgbGeojson } from 'flatgeobuf';
import shp from 'shpjs';
import { kml } from '@tmcw/togeojson';
import { DOMParser } from '@xmldom/xmldom';
import type {
  Feature,
  FeatureCollection,
  GeoJsonObject,
  Polygon,
  MultiPolygon,
  BBox,
} from 'geojson';
import {
  ECO_LAYERS_CONFIG,
  VALID_VEG_SERIES,
  getColorForVegetation,
  getColorForClimate,
  getColorForEdafologia,
  getEcoSiteName,
  getStrahlerOrderNumber,
  getStrahlerStyle,
  inferirProfundidadEdafica,
} from './gis.constants.js';
import type {
  DictamenSpatialSummary,
  GisContextRequestDto,
  GisContextResponseDto,
  GisLayerFeatureProperties,
  GisTypedFeature,
  LayerFilterMode,
  ParsedPolygonSummary,
  ParsePolygonResponseDto,
  ParseTableResponseDto,
} from './dto/gis-context.dto.js';
import {
  buildFromTemplate,
  detectTemplate,
  readCsvTable,
  readXlsxTable,
  type TabularTable,
} from './tabular-coordinates.js';
import { DATUMS, type DatumId } from './geodesy.js';

export interface ParseTableOptions {
  datum?: string;
  utmZone?: string | number;
  hemisphere?: string;
}

interface CacheEntry {
  expiresAt: number;
  data: GisContextResponseDto;
}

interface QueryRect {
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
}

@Injectable()
export class GisService {
  private readonly logger = new Logger(GisService.name);
  private readonly cache = new Map<string, CacheEntry>();
  private readonly CACHE_TTL_MS = 15 * 60 * 1000;
  private readonly MAX_CACHE_ENTRIES = 100;

  private getR2BaseUrl(): string {
    const raw = process.env.R2_PUBLIC_URL ?? process.env.VITE_R2_PUBLIC_URL ?? '';
    return raw.replace(/\/$/, '');
  }

  private asPrimitiveString(value: unknown): string {
    if (typeof value === 'string') return value.trim();
    if (typeof value === 'number' && Number.isFinite(value)) return String(value);
    return '';
  }

  private async queryFgbLayer(fileName: string, bbox: QueryRect): Promise<Feature[]> {
    const baseUrl = this.getR2BaseUrl();
    if (!baseUrl) {
      throw new InternalServerErrorException(
        'Falta configurar la variable de entorno R2_PUBLIC_URL en el backend',
      );
    }

    const url = `${baseUrl}/${fileName}`;
    const features: Feature[] = [];

    try {
      const iterator = fgbGeojson.deserialize(url, { rect: bbox });
      for await (const feature of iterator) {
        features.push(feature);
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.logger.warn(`Error al consultar ${fileName} en R2: ${message}`);
    }

    return features;
  }

  private normalizeToPolygon(
    input: GisContextRequestDto['geometry'],
  ): Feature<Polygon | MultiPolygon> {
    if (!input || typeof input !== 'object' || !('type' in input)) {
      throw new BadRequestException('Geometría GeoJSON inválida o vacía');
    }

    let fc: FeatureCollection;
    if (input.type === 'FeatureCollection') {
      fc = input;
    } else if (input.type === 'Feature') {
      fc = { type: 'FeatureCollection', features: [input] };
    } else {
      fc = {
        type: 'FeatureCollection',
        features: [{ type: 'Feature', properties: {}, geometry: input }],
      };
    }

    const polys = fc.features.filter(
      (f): f is Feature<Polygon | MultiPolygon> =>
        f.geometry?.type === 'Polygon' || f.geometry?.type === 'MultiPolygon',
    );

    if (polys.length === 1) return polys[0];
    if (polys.length > 1) {
      const coords = polys.flatMap((feat) =>
        feat.geometry.type === 'Polygon'
          ? [feat.geometry.coordinates]
          : feat.geometry.coordinates,
      );
      return turf.multiPolygon(coords);
    }

    const tinyBuffer = turf.buffer(fc, 0.001, { units: 'kilometers' });
    const bufferedFeature = tinyBuffer?.features[0];
    if (!bufferedFeature) {
      throw new BadRequestException('No se pudo construir un polígono válido');
    }
    return bufferedFeature;
  }

  private clipFeatureToBbox(
    feature: GisTypedFeature,
    bbox: BBox,
    clipToBbox = true,
  ): GisTypedFeature {
    if (!feature.geometry) return feature;

    const geomType = feature.geometry.type;
    if (
      !clipToBbox ||
      (geomType !== 'LineString' &&
        geomType !== 'MultiLineString' &&
        geomType !== 'Polygon' &&
        geomType !== 'MultiPolygon')
    ) {
      return turf.truncate(feature, {
        precision: 5,
        coordinates: 2,
      }) as GisTypedFeature;
    }

    try {
      const clipped = turf.bboxClip(
        feature as Parameters<typeof turf.bboxClip>[0],
        bbox,
      );
      if (
        !clipped?.geometry ||
        ('coordinates' in clipped.geometry &&
          Array.isArray(clipped.geometry.coordinates) &&
          clipped.geometry.coordinates.length === 0)
      ) {
        return turf.truncate(feature, {
          precision: 5,
          coordinates: 2,
        }) as GisTypedFeature;
      }

      return turf.truncate(
        { ...feature, geometry: clipped.geometry },
        { precision: 5, coordinates: 2 },
      ) as GisTypedFeature;
    } catch {
      return turf.truncate(feature, {
        precision: 5,
        coordinates: 2,
      }) as GisTypedFeature;
    }
  }

  private safeIntersects(a: Feature, b: Feature): boolean {
    if (!a.geometry || !b.geometry) return false;
    try {
      return turf.booleanIntersects(a, b);
    } catch {
      return false;
    }
  }

  private buildCacheKey(
    bbox: BBox,
    filterMode: LayerFilterMode,
    planos: number[],
    vegSerie: string,
    clipToBbox: boolean,
  ): string {
    const roundedBbox = bbox.map((n) => n.toFixed(5)).join(',');
    const sortedPlanos = [...planos].sort((a, b) => a - b).join('-');
    return `${roundedBbox}|${filterMode}|${sortedPlanos}|${vegSerie}|${clipToBbox ? '1' : '0'}`;
  }

  private getFromCache(key: string): GisContextResponseDto | null {
    const entry = this.cache.get(key);
    if (!entry) return null;
    if (Date.now() > entry.expiresAt) {
      this.cache.delete(key);
      return null;
    }
    return entry.data;
  }

  private setInCache(key: string, data: GisContextResponseDto): void {
    if (this.cache.size >= this.MAX_CACHE_ENTRIES) {
      const oldestKey = this.cache.keys().next().value;
      if (oldestKey) this.cache.delete(oldestKey);
    }
    this.cache.set(key, {
      expiresAt: Date.now() + this.CACHE_TTL_MS,
      data,
    });
  }

  private async loadEcoPlano(
    rect: QueryRect,
    filterGeometry: Feature<Polygon | MultiPolygon>,
    predioGeom: Feature<Polygon | MultiPolygon>,
    clipBbox: BBox,
    clipToBbox: boolean,
    summary: DictamenSpatialSummary,
  ): Promise<GisTypedFeature[]> {
    const ecoResults = await Promise.all(
      ECO_LAYERS_CONFIG.map(async (layer): Promise<GisTypedFeature[]> => {
        const raw = await this.queryFgbLayer(layer.file, rect);
        return raw
          .filter((f) => this.safeIntersects(f, filterGeometry))
          .map((f): GisTypedFeature => {
            const props = (f.properties ?? {}) as GisLayerFeatureProperties;
            const siteName = getEcoSiteName(props) ?? 'Área Protegida';

            if (this.safeIntersects(f, predioGeom)) {
              summary.ecologiaPredio.push({
                layerId: layer.id,
                title: layer.title,
                siteName,
              });
            }

            const enriched: GisTypedFeature = {
              ...f,
              properties: {
                ...props,
                _color: layer.color,
                _title: layer.title,
                _layerId: layer.id,
                _siteName: siteName,
              },
            };
            return this.clipFeatureToBbox(enriched, clipBbox, clipToBbox);
          });
      }),
    );

    return ecoResults.flat();
  }

  private async loadVegPlano(
    vegSerie: string,
    rect: QueryRect,
    filterGeometry: Feature<Polygon | MultiPolygon>,
    predioGeom: Feature<Polygon | MultiPolygon>,
    clipBbox: BBox,
    clipToBbox: boolean,
    summary: DictamenSpatialSummary,
  ): Promise<GisTypedFeature[]> {
    const raw = await this.queryFgbLayer(`usv_${vegSerie}.fgb`, rect);
    const vegSet = new Set<string>();

    const features = raw
      .filter((f) => this.safeIntersects(f, filterGeometry))
      .map((f): GisTypedFeature => {
        const props = (f.properties ?? {}) as GisLayerFeatureProperties;
        const rawType = props.DESCRIPCIO ?? props.descripcio ?? props.TIPO_VEG;
        const typeVeg =
          typeof rawType === 'string' && rawType.trim().length > 0
            ? rawType.trim()
            : 'Vegetación Indeterminada';

        if (this.safeIntersects(f, predioGeom)) {
          vegSet.add(typeVeg);
        }

        const enriched: GisTypedFeature = {
          ...f,
          properties: {
            ...props,
            _type: typeVeg,
            _color: getColorForVegetation(typeVeg),
          },
        };
        return this.clipFeatureToBbox(enriched, clipBbox, clipToBbox);
      });

    summary.vegetacionPredio = Array.from(vegSet);
    return features;
  }

  private async loadClimatePlano(
    rect: QueryRect,
    filterGeometry: Feature<Polygon | MultiPolygon>,
    predioGeom: Feature<Polygon | MultiPolygon>,
    clipBbox: BBox,
    clipToBbox: boolean,
    summary: DictamenSpatialSummary,
  ): Promise<GisTypedFeature[]> {
    const raw = await this.queryFgbLayer('climas.fgb', rect);
    const climaSet = new Set<string>();

    const features = raw
      .filter((f) => {
        const props = (f.properties ?? {}) as GisLayerFeatureProperties;
        if (props.TIPO_C === 'País extranjero' || props.CLAVE === 'P/E') return false;
        return this.safeIntersects(f, filterGeometry);
      })
      .map((f): GisTypedFeature => {
        const props = (f.properties ?? {}) as GisLayerFeatureProperties;
        const clave = this.asPrimitiveString(props.CLAVE);
        const tipoC = this.asPrimitiveString(props.TIPO_C);

        let label = 'Unidad Climática';
        if (clave && tipoC) {
          label = `${clave} - ${tipoC}`;
        } else if (tipoC) {
          label = tipoC;
        } else if (clave) {
          label = clave;
        }

        if (this.safeIntersects(f, predioGeom)) {
          climaSet.add(label);
        }

        const enriched: GisTypedFeature = {
          ...f,
          properties: {
            ...props,
            _type: label,
            _color: getColorForClimate(clave, tipoC),
          },
        };
        return this.clipFeatureToBbox(enriched, clipBbox, clipToBbox);
      });

    summary.climasPredio = Array.from(climaSet);
    return features;
  }

  private resolveSoilLabel(props: GisLayerFeatureProperties): string {
    const grupo1 = this.asPrimitiveString(props.N_G1);
    if (grupo1 && grupo1 !== 'N') return grupo1;

    const tipInfo = this.asPrimitiveString(props.TIP_INFO);
    if (tipInfo && tipInfo !== 'UNIDAD EDAFOLOGICA') return tipInfo;

    const claveWrb = this.asPrimitiveString(props.CLAVE_WRB);
    return claveWrb || 'Unidad Edafológica';
  }

  private buildEdafologiaSubtitle(
    props: GisLayerFeatureProperties,
    claveWrb: string,
    textura: string,
    profundidadEst: string,
  ): string {
    const detalles: string[] = [];
    if (claveWrb) {
      detalles.push(`<strong>Clave WRB:</strong> ${claveWrb}`);
    }

    const secundarios = [props.N_G2, props.N_G3]
      .map((g) => this.asPrimitiveString(g))
      .filter((g) => g.length > 0 && g !== 'N');
    if (secundarios.length > 0) {
      detalles.push(`<strong>Suelos asociados:</strong> ${secundarios.join(', ')}`);
    }

    if (textura) {
      const claseTexStr = this.asPrimitiveString(props.CLASE_TEX);
      const codTex = claseTexStr && claseTexStr !== 'N' ? ` (Clase ${claseTexStr})` : '';
      detalles.push(`<strong>Clase textural:</strong> ${textura}${codTex}`);
    }

    detalles.push(`<strong>Profundidad est.:</strong> ${profundidadEst}`);

    const califs = [props.N_CP_G1, props.N_CS_G1]
      .map((c) => this.asPrimitiveString(c))
      .filter((c) => c.length > 0 && c !== 'N');
    if (califs.length > 0) {
      detalles.push(`<strong>Calificadores:</strong> ${califs.join(', ')}`);
    }

    const frudica = this.asPrimitiveString(props.FRUDICA);
    if (frudica && frudica !== 'N') {
      detalles.push(`<strong>Fase rúdica:</strong> ${frudica}`);
    }

    return detalles.join('<br/>');
  }

  private async loadEdafologiaPlano(
    rect: QueryRect,
    filterGeometry: Feature<Polygon | MultiPolygon>,
    predioGeom: Feature<Polygon | MultiPolygon>,
    clipBbox: BBox,
    clipToBbox: boolean,
    summary: DictamenSpatialSummary,
  ): Promise<GisTypedFeature[]> {
    const raw = await this.queryFgbLayer('edafologia.fgb', rect);

    return raw
      .filter((f) => this.safeIntersects(f, filterGeometry))
      .map((f): GisTypedFeature => {
        const props = (f.properties ?? {}) as GisLayerFeatureProperties;
        const soilLabel = this.resolveSoilLabel(props);
        const claveWrb = this.asPrimitiveString(props.CLAVE_WRB);
        const rawTextura = this.asPrimitiveString(props.TEXTURA);
        const textura = rawTextura && rawTextura !== 'N' ? rawTextura : '';
        const profundidadEst = inferirProfundidadEdafica(props);

        if (this.safeIntersects(f, predioGeom)) {
          summary.edafologiaPredio.push({
            grupo: soilLabel,
            claveWrb: claveWrb || undefined,
            textura: textura || undefined,
            profundidadEstimada: profundidadEst,
          });
        }

        const enriched: GisTypedFeature = {
          ...f,
          properties: {
            ...props,
            _type: soilLabel,
            _subtitle: this.buildEdafologiaSubtitle(props, claveWrb, textura, profundidadEst),
            _color: getColorForEdafologia(soilLabel),
          },
        };
        return this.clipFeatureToBbox(enriched, clipBbox, clipToBbox);
      });
  }

  private async loadHidrologiaPlano(
    rect: QueryRect,
    filterGeometry: Feature<Polygon | MultiPolygon>,
    predioGeom: Feature<Polygon | MultiPolygon>,
    clipBbox: BBox,
    clipToBbox: boolean,
    summary: DictamenSpatialSummary,
  ): Promise<{
    cuencas: GisTypedFeature[];
    subcuencas: GisTypedFeature[];
    cuerposAgua: GisTypedFeature[];
    corrientes: GisTypedFeature[];
  }> {
    const [rawCuencas, rawSubcuencas, rawCuerposAgua, rawCorrientes] = await Promise.all([
      this.queryFgbLayer('cuencas_cna.fgb', rect),
      this.queryFgbLayer('subcuencas_50k.fgb', rect),
      this.queryFgbLayer('cuerpos_agua_50k.fgb', rect),
      this.queryFgbLayer('red_hidrografica_50k.fgb', rect),
    ]);

    const cuencas = rawCuencas
      .filter((f) => this.safeIntersects(f, filterGeometry))
      .map((f): GisTypedFeature => {
        const props = (f.properties ?? {}) as GisLayerFeatureProperties;
        const rawName = props.NOM_CUENCA ?? props.CUENCA ?? props.NOMBRE ?? props.NOM_CUE;
        const nombreCuenca = this.asPrimitiveString(rawName) || 'Cuenca Hidrográfica';

        if (this.safeIntersects(f, predioGeom) && !summary.hidrologiaPredio.cuenca) {
          summary.hidrologiaPredio.cuenca = nombreCuenca;
        }

        const enriched: GisTypedFeature = {
          ...f,
          properties: {
            ...props,
            _type: nombreCuenca,
            _color: '#6d28d9',
          },
        };
        return this.clipFeatureToBbox(enriched, clipBbox, clipToBbox);
      });

    const subcuencas = rawSubcuencas
      .filter((f) => this.safeIntersects(f, filterGeometry))
      .map((f): GisTypedFeature => {
        const props = (f.properties ?? {}) as GisLayerFeatureProperties;
        const nombreSubc = this.asPrimitiveString(props.SUBCUENCA) || 'Subcuenca';

        if (this.safeIntersects(f, predioGeom)) {
          summary.hidrologiaPredio.subcuenca = nombreSubc;
          const cveSubc = this.asPrimitiveString(props.CVE_SUBCUE);
          const cuencaName = this.asPrimitiveString(props.CUENCA);
          const rhName = this.asPrimitiveString(props.RH);
          if (cveSubc) summary.hidrologiaPredio.claveSubcuenca = cveSubc;
          if (cuencaName) summary.hidrologiaPredio.cuenca = cuencaName;
          if (rhName) summary.hidrologiaPredio.regionHidrologica = rhName;
        }

        const enriched: GisTypedFeature = {
          ...f,
          properties: {
            ...props,
            _type: nombreSubc,
            _color: '#78350f',
          },
        };
        return this.clipFeatureToBbox(enriched, clipBbox, clipToBbox);
      });

    const cuerposAgua = rawCuerposAgua
      .filter((f) => this.safeIntersects(f, filterGeometry))
      .map((f): GisTypedFeature => {
        const props = (f.properties ?? {}) as GisLayerFeatureProperties;
        const cond = this.asPrimitiveString(props.CONDICION) || 'Cuerpo de agua';
        const enriched: GisTypedFeature = {
          ...f,
          properties: {
            ...props,
            _type: cond,
            _color: '#0284c7',
          },
        };
        return this.clipFeatureToBbox(enriched, clipBbox, clipToBbox);
      });

    let maxOrder: number | null = null;
    const corrientes = rawCorrientes
      .filter((f) => this.safeIntersects(f, filterGeometry))
      .map((f): GisTypedFeature => {
        const props = (f.properties ?? {}) as GisLayerFeatureProperties;
        const orderNum = getStrahlerOrderNumber(props.ORDER_1);
        const style = getStrahlerStyle(orderNum);

        if (maxOrder === null || orderNum > maxOrder) {
          maxOrder = orderNum;
        }

        const enriched: GisTypedFeature = {
          ...f,
          properties: {
            ...props,
            _type: `Orden ${style.label}`,
            _color: style.color,
            _weight: style.weight,
            _opacity: style.opacity,
          },
        };
        return this.clipFeatureToBbox(enriched, clipBbox, clipToBbox);
      });

    summary.hidrologiaPredio.ordenStrahlerMaximo = maxOrder;
    summary.hidrologiaPredio.corrientesCercanasCount = corrientes.length;
    summary.hidrologiaPredio.cuerposAguaCount = cuerposAgua.length;

    return { cuencas, subcuencas, cuerposAgua, corrientes };
  }

  async getSpatialContext(dto: GisContextRequestDto): Promise<GisContextResponseDto> {
    const predioGeom = this.normalizeToPolygon(dto.geometry);
    const filterMode: LayerFilterMode =
      dto.filterMode === 'intersect' ? 'intersect' : 'buffer10km';
    const vegSerie =
      dto.vegSerie && VALID_VEG_SERIES.has(dto.vegSerie) ? dto.vegSerie : 'serie_7';
    const clipToBbox = dto.clipToBbox !== false;

    const requestedPlanos =
      Array.isArray(dto.planos) && dto.planos.length > 0
        ? dto.planos.filter((p) => [2, 3, 4, 5, 6].includes(p))
        : [2, 3, 4, 5, 6];

    const filterGeometry =
      filterMode === 'buffer10km'
        ? (turf.buffer(predioGeom, 10, { units: 'kilometers' }) ?? predioGeom)
        : predioGeom;

    const [minX, minY, maxX, maxY] = turf.bbox(filterGeometry);
    const rect: QueryRect = { minX, minY, maxX, maxY };

    const padX = Math.max((maxX - minX) * 0.08, 0.01);
    const padY = Math.max((maxY - minY) * 0.08, 0.01);
    const clipBbox: BBox = [minX - padX, minY - padY, maxX + padX, maxY + padY];

    const cacheKey = this.buildCacheKey(
      [minX, minY, maxX, maxY],
      filterMode,
      requestedPlanos,
      vegSerie,
      clipToBbox,
    );

    const cached = this.getFromCache(cacheKey);
    if (cached) {
      return { ...cached, cached: true };
    }

    const areaTotalM2 = Number(turf.area(predioGeom).toFixed(2));
    const areaTotalHa = Number((areaTotalM2 / 10000).toFixed(4));

    const summary: DictamenSpatialSummary = {
      areaTotalM2,
      areaTotalHa,
      ecologiaPredio: [],
      vegetacionPredio: [],
      climasPredio: [],
      edafologiaPredio: [],
      hidrologiaPredio: {
        ordenStrahlerMaximo: null,
        corrientesCercanasCount: 0,
        cuerposAguaCount: 0,
      },
    };

    const layers: GisContextResponseDto['layers'] = {};
    const tasks: Promise<void>[] = [];

    if (requestedPlanos.includes(2)) {
      tasks.push(
        this.loadEcoPlano(rect, filterGeometry, predioGeom, clipBbox, clipToBbox, summary).then(
          (res) => {
            layers.eco = res;
          },
        ),
      );
    }

    if (requestedPlanos.includes(3)) {
      tasks.push(
        this.loadVegPlano(
          vegSerie,
          rect,
          filterGeometry,
          predioGeom,
          clipBbox,
          clipToBbox,
          summary,
        ).then((res) => {
          layers.veg = res;
        }),
      );
    }

    if (requestedPlanos.includes(4)) {
      tasks.push(
        this.loadClimatePlano(rect, filterGeometry, predioGeom, clipBbox, clipToBbox, summary).then(
          (res) => {
            layers.climate = res;
          },
        ),
      );
    }

    if (requestedPlanos.includes(5)) {
      tasks.push(
        this.loadEdafologiaPlano(
          rect,
          filterGeometry,
          predioGeom,
          clipBbox,
          clipToBbox,
          summary,
        ).then((res) => {
          layers.edafologia = res;
        }),
      );
    }

    if (requestedPlanos.includes(6)) {
      tasks.push(
        this.loadHidrologiaPlano(
          rect,
          filterGeometry,
          predioGeom,
          clipBbox,
          clipToBbox,
          summary,
        ).then((res) => {
          layers.hidrologia = res;
        }),
      );
    }

    await Promise.all(tasks);

    const response: GisContextResponseDto = {
      success: true,
      cached: false,
      filterMode,
      layers,
      summary,
    };

    this.setInCache(cacheKey, response);
    return response;
  }

  /** 0 → A, 25 → Z, 26 → AA… (antes pasaba de "Z" a "[" con más de 26 polígonos). */
  private letterLabel(index: number): string {
    let n = index;
    let label = '';
    do {
      label = String.fromCodePoint(65 + (n % 26)) + label;
      n = Math.floor(n / 26) - 1;
    } while (n >= 0);
    return label;
  }

  /**
   * Coordenadas desde Excel (.xlsx) o CSV. Con plantilla oficial devuelve los polígonos y
   * vértices ya formados (en WGS84); con una tabla libre devuelve las filas para que el
   * usuario elija las columnas en el frontend.
   */
  parseTableUpload(fileBuffer: Buffer, originalName: string, options: ParseTableOptions = {}): ParseTableResponseDto {
    const lowerName = originalName.toLowerCase();
    const datum: DatumId = options.datum && options.datum in DATUMS ? (options.datum as DatumId) : 'WGS84';
    const zone = Number(options.utmZone);
    const defaultZone = Number.isInteger(zone) && zone >= 1 && zone <= 60 ? zone : 15;
    const defaultHemisphere = String(options.hemisphere ?? 'N').toUpperCase().startsWith('S') ? 'S' : 'N';

    let table: TabularTable;
    try {
      if (lowerName.endsWith('.xlsx') || lowerName.endsWith('.xlsm')) table = readXlsxTable(fileBuffer);
      else if (lowerName.endsWith('.csv') || lowerName.endsWith('.txt')) table = readCsvTable(fileBuffer);
      else if (lowerName.endsWith('.xls')) {
        throw new BadRequestException(
          'El formato .xls (Excel 97-2003) no es compatible. Guárdalo como .xlsx o como CSV UTF-8.',
        );
      } else throw new BadRequestException('Formato no soportado. Sube un archivo .xlsx o .csv');
    } catch (error) {
      if (error instanceof BadRequestException) throw error;
      const msg = error instanceof Error ? error.message : String(error);
      throw new BadRequestException(`No se pudo leer la tabla: ${msg}`);
    }

    if (table.headers.length === 0 || table.rows.length === 0) {
      throw new BadRequestException('La tabla está vacía: se necesita una fila de encabezados y al menos una fila de datos.');
    }

    const base = {
      success: true,
      fileName: originalName,
      sheetName: table.sheetName,
      headers: table.headers,
      rowCount: table.rows.length,
      datum,
    };

    const template = detectTemplate(table.headers);
    if (!template) {
      return { ...base, template: null, rows: table.rows, rowNumbers: table.rowNumbers, errors: [], warnings: [] };
    }

    const built = buildFromTemplate(table, template, { datum, defaultZone, defaultHemisphere });
    if (template.kind === 'utm' && !template.zona) {
      built.warnings.unshift(`La tabla no trae columna ZONA: se usó la zona ${defaultZone}${defaultHemisphere} para todos los vértices.`);
    }
    this.logger.log(
      `Tabla ${originalName}: plantilla ${template.kind}, ${built.polygonCount} polígono(s), ${built.vertexCount} vértice(s), ${built.errors.length} error(es).`,
    );
    return {
      ...base,
      template: template.kind,
      featureCollection: built.featureCollection,
      polygonCount: built.polygonCount,
      vertexCount: built.vertexCount,
      errors: built.errors,
      warnings: built.warnings,
    };
  }

  private async parseRawSpatialBuffer(fileBuffer: Buffer, lowerName: string): Promise<unknown> {
    if (lowerName.endsWith('.zip')) {
      const arrayBuf = fileBuffer.buffer.slice(
        fileBuffer.byteOffset,
        fileBuffer.byteOffset + fileBuffer.byteLength,
      );
      const parsedShp = await shp(arrayBuf);
      return Array.isArray(parsedShp) ? parsedShp[0] : parsedShp;
    }

    if (lowerName.endsWith('.kml')) {
      const xmlDoc = new DOMParser().parseFromString(fileBuffer.toString('utf-8'), 'text/xml');
      return kml(xmlDoc);
    }

    if (lowerName.endsWith('.geojson') || lowerName.endsWith('.json')) {
      return JSON.parse(fileBuffer.toString('utf-8'));
    }

    throw new BadRequestException(
      'Formato no soportado. Sube un archivo .zip (Shapefile), .kml o .geojson',
    );
  }

  async parseSpatialUpload(
    fileBuffer: Buffer,
    originalName: string,
  ): Promise<ParsePolygonResponseDto> {
    const lowerName = originalName.toLowerCase();
    let parsed: unknown = null;

    try {
      parsed = await this.parseRawSpatialBuffer(fileBuffer, lowerName);
    } catch (error) {
      if (error instanceof BadRequestException) throw error;
      const msg = error instanceof Error ? error.message : String(error);
      throw new BadRequestException(`Error al procesar el archivo espacial: ${msg}`);
    }

    let collection: FeatureCollection;
    if ((parsed as GeoJsonObject)?.type === 'FeatureCollection') {
      collection = parsed as FeatureCollection;
    } else if ((parsed as GeoJsonObject)?.type === 'Feature') {
      collection = { type: 'FeatureCollection', features: [parsed as Feature] };
    } else {
      throw new BadRequestException('El archivo no contiene geometrías GeoJSON válidas');
    }

    let polyIndex = 0;
    let totalAreaM2 = 0;
    const polygonsSummary: ParsedPolygonSummary[] = [];

    const cleanFeatures = collection.features
      .filter((f) => Boolean(f?.geometry))
      .map((f) => {
        const truncated = turf.truncate(f, { precision: 6, coordinates: 2 });
        if (
          truncated.geometry.type === 'Polygon' ||
          truncated.geometry.type === 'MultiPolygon'
        ) {
          const polyId = this.letterLabel(polyIndex);
          polyIndex++;
          truncated.properties = {
            ...truncated.properties,
            polyId,
          };

          const areaM2 = Number(turf.area(truncated).toFixed(2));
          const areaHa = Number((areaM2 / 10000).toFixed(4));
          totalAreaM2 += areaM2;

          polygonsSummary.push({
            polyId,
            name: `Polígono ${polyId}`,
            areaM2,
            areaHa,
          });
        }
        return truncated;
      });

    if (cleanFeatures.length === 0) {
      throw new BadRequestException('El archivo espacial no contiene entidades válidas');
    }

    return {
      success: true,
      featureCollection: {
        type: 'FeatureCollection',
        features: cleanFeatures,
      },
      polygons: polygonsSummary,
      totalAreaM2: Number(totalAreaM2.toFixed(2)),
      totalAreaHa: Number((totalAreaM2 / 10000).toFixed(4)),
    };
  }
}