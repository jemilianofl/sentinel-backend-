import { describe, it, expect, beforeEach, vi } from 'vitest';
import { Test, TestingModule } from '@nestjs/testing';
import { BadRequestException } from '@nestjs/common';
import { GisController } from './gis.controller.js';
import { GisService } from './gis.service.js';
import type { GisContextRequestDto } from './dto/gis-context.dto.js';

describe('GisController', () => {
  let controller: GisController;
  let gisService: {
    getSpatialContext: ReturnType<typeof vi.fn>;
    parseSpatialUpload: ReturnType<typeof vi.fn>;
  };

  beforeEach(async () => {
    gisService = {
      getSpatialContext: vi.fn(),
      parseSpatialUpload: vi.fn(),
    };

    const module: TestingModule = await Test.createTestingModule({
      controllers: [GisController],
      providers: [
        {
          provide: GisService,
          useValue: gisService,
        },
      ],
    }).compile();

    controller = module.get<GisController>(GisController);
  });

  describe('POST /gis/context', () => {
    it('debe lanzar BadRequestException si no se envía geometry', async () => {
      await expect(
        controller.getContext({} as GisContextRequestDto),
      ).rejects.toThrow(BadRequestException);
    });

    it('debe delegar el análisis espacial a GisService.getSpatialContext', async () => {
      const payload: GisContextRequestDto = {
        filterMode: 'intersect',
        planos: [2, 3],
        geometry: {
          type: 'Polygon',
          coordinates: [
            [
              [-96.132, 15.752],
              [-96.13, 15.752],
              [-96.13, 15.754],
              [-96.132, 15.754],
              [-96.132, 15.752],
            ],
          ],
        },
      };

      const expectedResponse = { success: true, cached: false, layers: {}, summary: {} };
      gisService.getSpatialContext.mockResolvedValue(expectedResponse);

      const result = await controller.getContext(payload);

      expect(gisService.getSpatialContext).toHaveBeenCalledWith(payload);
      expect(result).toEqual(expectedResponse);
    });
  });

  describe('POST /gis/parse-polygon', () => {
    it('debe lanzar BadRequestException si no se adjunta archivo', async () => {
      await expect(controller.parsePolygon(undefined)).rejects.toThrow(BadRequestException);
    });

    it('debe delegar el parseo del archivo a GisService.parseSpatialUpload', async () => {
      const mockFile = {
        buffer: Buffer.from('{"type":"FeatureCollection","features":[]}'),
        originalname: 'predio.geojson',
      };
      const expectedParsed = { success: true, totalAreaM2: 500 };
      gisService.parseSpatialUpload.mockResolvedValue(expectedParsed);

      const result = await controller.parsePolygon(mockFile);

      expect(gisService.parseSpatialUpload).toHaveBeenCalledWith(
        mockFile.buffer,
        mockFile.originalname,
      );
      expect(result).toEqual(expectedParsed);
    });
  });
});