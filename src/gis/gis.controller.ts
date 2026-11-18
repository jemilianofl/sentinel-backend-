import {
  Controller,
  Post,
  Body,
  Res,
  UploadedFile,
  UseInterceptors,
  BadRequestException,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import type { Response } from 'express';
import { GisService } from './gis.service.js';
import type { GisContextRequestDto } from './dto/gis-context.dto.js';

@Controller('gis')
export class GisController {
  constructor(private readonly gisService: GisService) {}

  @Post('context')
  async getContext(
    @Body() body: GisContextRequestDto,
    @Res({ passthrough: true }) res?: Response,
  ) {
    if (!body?.geometry) {
      throw new BadRequestException(
        'Se requiere el campo "geometry" con el polígono GeoJSON a analizar',
      );
    }
    const t0 = performance.now();
    const result = await this.gisService.getSpatialContext(body);
    const dur = (performance.now() - t0).toFixed(1);
    res?.setHeader(
      'Server-Timing',
      `total;dur=${dur}, cached;desc="${result.cached ? 'HIT' : 'MISS'}"`,
    );
    return result;
  }

  @Post('parse-polygon')
  @UseInterceptors(
    FileInterceptor('file', {
      limits: { fileSize: 25 * 1024 * 1024 },
    }),
  )
  async parsePolygon(
    @UploadedFile()
    file?: { buffer: Buffer; originalname: string },
  ) {
    if (!file) {
      throw new BadRequestException(
        'Debes adjuntar un archivo espacial (.geojson, .kml o .zip)',
      );
    }
    return this.gisService.parseSpatialUpload(file.buffer, file.originalname);
  }
}