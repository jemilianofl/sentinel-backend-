import { Controller, Get, Query, BadRequestException } from '@nestjs/common';
import {
  SentinelService,
  type BBox,
  type SpectralPreset,
  type SatelliteCollectionOption,
} from './sentinel.service.js';

/** Extensión máxima permitida del AOI (grados) para evitar consultas desproporcionadas a GEE. */
const MAX_BBOX_SPAN_DEG = 1;

function parseBBox(raw?: string): BBox | null {
  if (!raw) return null;
  const parts = raw.split(',').map((v) => Number.parseFloat(v));
  if (parts.length !== 4 || parts.some((v) => !Number.isFinite(v))) {
    throw new BadRequestException('bbox inválido. Formato: minLng,minLat,maxLng,maxLat');
  }
  const [minX, minY, maxX, maxY] = parts;
  if (
    minX >= maxX ||
    minY >= maxY ||
    minX < -180 ||
    maxX > 180 ||
    minY < -90 ||
    maxY > 90 ||
    maxX - minX > MAX_BBOX_SPAN_DEG ||
    maxY - minY > MAX_BBOX_SPAN_DEG
  ) {
    throw new BadRequestException('bbox fuera de rango o demasiado extenso (máx. 1° por lado)');
  }
  return [minX, minY, maxX, maxY];
}

@Controller('sentinel')
export class SentinelController {
  constructor(private readonly sentinelService: SentinelService) {}

  @Get('tiles')
  async getTiles(
    @Query('lat') lat: string,
    @Query('lng') lng: string,
    @Query('date') date: string,
  ) {
    if (!lat || !lng || !date) {
      throw new BadRequestException('Faltan parámetros requeridos: lat, lng, date');
    }

    const latitude = Number.parseFloat(lat);
    const longitude = Number.parseFloat(lng);

    if (Number.isNaN(latitude) || Number.isNaN(longitude)) {
      throw new BadRequestException('Coordenadas inválidas');
    }

    return await this.sentinelService.getBestImagery(latitude, longitude, date);
  }

  /**
   * Mejor escena del año.
   * Con `bbox` (polígono + buffer) la escena se elige por despeje sobre el AOI y se devuelve `thumbUrl`;
   * es lo que usa la galería multitemporal del Plano 7 (una petición por año).
   */
  @Get('annual')
  async getAnnualImagery(
    @Query('lat') lat: string,
    @Query('lng') lng: string,
    @Query('year') year: string,
    @Query('collection') collection?: SatelliteCollectionOption,
    @Query('preset') preset?: SpectralPreset,
    @Query('bbox') bbox?: string,
  ) {
    if (!lat || !lng || !year) {
      throw new BadRequestException('Faltan parámetros requeridos: lat, lng, year');
    }

    const latitude = Number.parseFloat(lat);
    const longitude = Number.parseFloat(lng);
    const targetYear = Number.parseInt(year, 10);
    const currentYear = new Date().getUTCFullYear();

    if (
      Number.isNaN(latitude) ||
      Number.isNaN(longitude) ||
      Number.isNaN(targetYear) ||
      targetYear < 1984 ||
      targetYear > currentYear
    ) {
      throw new BadRequestException('Coordenadas o año inválidos');
    }

    const validCollection: SatelliteCollectionOption =
      collection === 'landsat-c2-l2' ? 'landsat-c2-l2' : 'sentinel-2-l2a';

    const validPreset: SpectralPreset =
      preset === 'nir' || preset === 'swir' || preset === 'ndvi' ? preset : 'rgb';

    return await this.sentinelService.getBestAnnualScene({
      lat: latitude,
      lng: longitude,
      year: targetYear,
      collection: validCollection,
      preset: validPreset,
      bbox: parseBBox(bbox),
    });
  }
}