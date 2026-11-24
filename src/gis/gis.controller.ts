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
import { GisService, type ParseTableOptions } from './gis.service.js';
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

  /**
   * Coordenadas en Excel (.xlsx) o CSV. Campos opcionales del formulario:
   * datum (WGS84 | ITRF2008 | NAD83 | NAD27), utmZone y hemisphere (zona por defecto
   * cuando la plantilla UTM no trae columna ZONA).
   */
  @Post('parse-table')
  @UseInterceptors(
    FileInterceptor('file', {
      limits: { fileSize: 10 * 1024 * 1024 },
    }),
  )
  parseTable(
    @UploadedFile()
    file?: { buffer: Buffer; originalname: string },
    @Body() body?: ParseTableOptions,
  ) {
    if (!file) {
      throw new BadRequestException('Debes adjuntar una tabla de coordenadas (.xlsx o .csv)');
    }
    return this.gisService.parseTableUpload(file.buffer, file.originalname, body ?? {});
  }
}