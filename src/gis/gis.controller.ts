import {
  Controller,
  Post,
  Body,
  UploadedFile,
  UseInterceptors,
  BadRequestException,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { GisService } from './gis.service.js';
import type { GisContextRequestDto } from './dto/gis-context.dto.js';

interface UploadedSpatialFile {
  buffer: Buffer;
  originalname: string;
}

@Controller('gis')
export class GisController {
  constructor(private readonly gisService: GisService) {}

  @Post('context')
  async getContext(@Body() body: GisContextRequestDto) {
    if (!body?.geometry) {
      throw new BadRequestException('Se requiere el campo "geometry" con el polígono GeoJSON');
    }
    return await this.gisService.getSpatialContext(body);
  }

  @Post('parse-polygon')
  @UseInterceptors(
    FileInterceptor('file', {
      limits: { fileSize: 25 * 1024 * 1024 }, // Máximo 25 MB
    }),
  )
  async parsePolygon(@UploadedFile() file?: UploadedSpatialFile) {
    if (!file) {
      throw new BadRequestException('Debes adjuntar un archivo en el campo "file"');
    }
    return await this.gisService.parseSpatialUpload(file.buffer, file.originalname);
  }
}