import { Controller, Get, Query, BadRequestException } from '@nestjs/common';
import { SentinelService } from './sentinel.service.js';

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
}