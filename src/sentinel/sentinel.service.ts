import { Injectable, HttpException, HttpStatus } from '@nestjs/common';
import { HttpService } from '@nestjs/axios';
import { firstValueFrom } from 'rxjs';

@Injectable()
export class SentinelService {
  constructor(private readonly httpService: HttpService) {}

  async getBestImagery(lat: number, lng: number, targetDate: string) {
    // 1. Calcular el rango de fechas (± 15 días)
    const baseDate = new Date(targetDate);
    const startDate = new Date(baseDate.getTime() - 15 * 24 * 60 * 60 * 1000);
    const endDate = new Date(baseDate.getTime() + 15 * 24 * 60 * 60 * 1000);
    const timeRange = `${startDate.toISOString()}/${endDate.toISOString()}`;

    // 2. STAC API de Earth Search (AWS) para Sentinel-2 L2A
    const stacApiUrl = 'https://earth-search.aws.element84.com/v1/search';
    
    const queryBody = {
      collections: ['sentinel-2-l2a'],
      intersects: {
        type: 'Point',
        coordinates: [lng, lat], // En GeoJSON el orden es [Longitud, Latitud]
      },
      datetime: timeRange,
      query: {
        'eo:cloud_cover': { lt: 30 }, // Menos de 30% de nubosidad
      },
      sortby: [{ field: 'eo:cloud_cover', direction: 'asc' }], // Traer la más despejada primero
      limit: 1,
    };

    try {
      const response = await firstValueFrom(
        this.httpService.post(stacApiUrl, queryBody, {
          headers: { 'Content-Type': 'application/json' },
        }),
      );

      const data = response.data;

      if (!data.features || data.features.length === 0) {
        throw new HttpException('No se encontraron imágenes satelitales despejadas en este rango de fechas.', HttpStatus.NOT_FOUND);
      }

      const bestItem = data.features[0];
      const selfLink = bestItem.links.find((l: any) => l.rel === 'self').href;

      // 3. Generar la URL XYZ para Leaflet usando el motor dinámico Titiler
      const tileUrl = `https://titiler.xyz/stac/tiles/WebMercatorQuad/{z}/{x}/{y}?url=${encodeURIComponent(selfLink)}&assets=visual&color_formula=gamma+r+1.2+g+1.2+b+1.2`;

      return {
        success: true,
        tileUrl,
        metadata: {
          id: bestItem.id,
          date: bestItem.properties.datetime,
          cloudCover: bestItem.properties['eo:cloud_cover'],
          platform: bestItem.properties.platform
        }
      };
    } catch (error) {
      if (error instanceof HttpException) throw error;
      throw new HttpException('Error al conectar con el servidor satelital.', HttpStatus.INTERNAL_SERVER_ERROR);
    }
  }
}