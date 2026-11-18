import { Controller, Get, Query, BadRequestException } from '@nestjs/common';
import {
  SentinelService,
  type SpectralPreset,
  type SatelliteCollectionOption,
} from './sentinel.service.js';

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

  @Get('historical')
  async getHistoricalImagery(
    @Query('lat') lat: string,
    @Query('lng') lng: string,
    @Query('date') date: string,
    @Query('windowDays') windowDays?: string,
    @Query('maxCloud') maxCloud?: string,
    @Query('collection') collection?: SatelliteCollectionOption,
    @Query('preset') preset?: SpectralPreset,
  ) {
    if (!lat || !lng || !date) {
      throw new BadRequestException('Faltan parámetros requeridos: lat, lng, date');
    }

    const latitude = Number.parseFloat(lat);
    const longitude = Number.parseFloat(lng);

    if (Number.isNaN(latitude) || Number.isNaN(longitude)) {
      throw new BadRequestException('Coordenadas inválidas');
    }

    const parsedWindow = windowDays ? Math.min(Math.max(Number.parseInt(windowDays, 10) || 60, 5), 365) : 60;
    const parsedCloud = maxCloud ? Math.min(Math.max(Number.parseInt(maxCloud, 10) || 40, 5), 100) : 40;
    const validCollection: SatelliteCollectionOption =
      collection === 'sentinel-2-l2a' || collection === 'landsat-c2-l2' || collection === 'all'
        ? collection
        : 'sentinel-2-l2a';
    const validPreset: SpectralPreset =
      preset === 'rgb' || preset === 'nir' || preset === 'swir' ? preset : 'rgb';

    return await this.sentinelService.searchHistoricalScenes({
      lat: latitude,
      lng: longitude,
      targetDate: date,
      windowDays: parsedWindow,
      maxCloud: parsedCloud,
      collection: validCollection,
      preset: validPreset,
    });
  }
}