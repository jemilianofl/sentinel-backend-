import type {
  Feature,
  FeatureCollection,
  Geometry,
  Polygon,
  MultiPolygon,
} from 'geojson';

export type LayerFilterMode = 'intersect' | 'buffer10km';

export interface GisContextRequestDto {
  geometry:
    | FeatureCollection
    | Feature<Polygon | MultiPolygon>
    | Polygon
    | MultiPolygon;
  filterMode?: LayerFilterMode;
  planos?: number[];
  vegSerie?: string;
  clipToBbox?: boolean;
}

export interface GisLayerFeatureProperties {
  _color?: string;
  _title?: string;
  _layerId?: string;
  _siteName?: string;
  _type?: string;
  _subtitle?: string;
  _weight?: number;
  _opacity?: number;
  [key: string]: unknown;
}

export type GisTypedFeature = Feature<Geometry, GisLayerFeatureProperties>;

export interface DictamenSpatialSummary {
  areaTotalM2: number;
  areaTotalHa: number;
  ecologiaPredio: {
    layerId: string;
    title: string;
    siteName: string;
  }[];
  vegetacionPredio: string[];
  climasPredio: string[];
  edafologiaPredio: {
    grupo: string;
    claveWrb?: string;
    textura?: string;
    profundidadEstimada: string;
  }[];
  hidrologiaPredio: {
    regionHidrologica?: string;
    cuenca?: string;
    subcuenca?: string;
    claveSubcuenca?: string;
    ordenStrahlerMaximo: number | null;
    corrientesCercanasCount: number;
    cuerposAguaCount: number;
  };
}

export interface GisTimingsMs {
  totalMs: number;
  r2FetchByFileMs: Record<string, number>;
  spatialProcessByPlanoMs: Record<string, number>;
  payloadBytes?: number;
}

export interface GisContextResponseDto {
  success: boolean;
  cached: boolean;
  filterMode: LayerFilterMode;
  layers: {
    eco?: GisTypedFeature[];
    veg?: GisTypedFeature[];
    climate?: GisTypedFeature[];
    edafologia?: GisTypedFeature[];
    hidrologia?: {
      cuencas: GisTypedFeature[];
      subcuencas: GisTypedFeature[];
      cuerposAgua: GisTypedFeature[];
      corrientes: GisTypedFeature[];
    };
  };
  summary: DictamenSpatialSummary;
  timingsMs?: GisTimingsMs;
}

export interface ParsedPolygonSummary {
  polyId: string;
  name: string;
  areaM2: number;
  areaHa: number;
}

export interface ParsePolygonResponseDto {
  success: boolean;
  featureCollection: FeatureCollection;
  polygons: ParsedPolygonSummary[];
  totalAreaM2: number;
  totalAreaHa: number;
}
/* ---------------- Carga de coordenadas desde Excel / CSV ---------------- */

export type CoordinateTemplateKind = 'geo' | 'utm';

export interface TableIssueDto {
  /** Fila como la ve el usuario en Excel (null = error del polígono completo). */
  row: number | null;
  message: string;
}

export interface ParseTableResponseDto {
  success: boolean;
  fileName: string;
  sheetName?: string;
  headers: string[];
  rowCount: number;
  /** Plantilla oficial reconocida; null = tabla libre (el usuario elige columnas en el frontend). */
  template: CoordinateTemplateKind | null;
  datum: string;
  /** Solo si se reconoció la plantilla: polígonos + vértices en WGS84. */
  featureCollection?: FeatureCollection;
  polygonCount?: number;
  vertexCount?: number;
  /** Solo para tablas libres: filas para el paso de selección de columnas. */
  rows?: Record<string, string>[];
  rowNumbers?: number[];
  errors: TableIssueDto[];
  warnings: string[];
}
