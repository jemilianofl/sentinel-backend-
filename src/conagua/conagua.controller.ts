import { Controller, Get, Query } from '@nestjs/common';
import { ConaguaService } from './conagua.service.js';

@Controller('conagua')
export class ConaguaController {
  constructor(private readonly conaguaService: ConaguaService) {}

  @Get('climograma')
  async getClimograma(
    @Query('estado') estado: string,
    @Query('municipio') municipio: string,
    @Query('lat') lat: number,
    @Query('lng') lng: number
  ) {
    return this.conaguaService.procesarClimograma(estado, municipio, Number(lat), Number(lng));
  }
}