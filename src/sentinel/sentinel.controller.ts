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

  @Get('annual')
  async getAnnualImagery(
    @Query('lat') lat: string,
    @Query('lng') lng: string,
    @Query('year') year: string,
    @Query('collection') collection?: SatelliteCollectionOption,
    @Query('preset') preset?: SpectralPreset,
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
    });
  }
}