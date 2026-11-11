import { Injectable, HttpException, HttpStatus, Logger } from '@nestjs/common';
import { HttpService } from '@nestjs/axios';
import { firstValueFrom } from 'rxjs';

@Injectable()
export class SentinelService {
  private readonly logger = new Logger(SentinelService.name);

  constructor(private readonly httpService: HttpService) {}

  async getBestImagery(lat: number, lng: number, targetDate: string) {
    const baseDate = new Date(targetDate);
    const startDate = new Date(baseDate.getTime() - 15 * 24 * 60 * 60 * 1000);
    const endDate = new Date(baseDate.getTime() + 15 * 24 * 60 * 60 * 1000);
    const timeRange = `${startDate.toISOString()}/${endDate.toISOString()}`;

    const stacApiUrl = 'https://earth-search.aws.element84.com/v1/search';
    
    const queryBody = {
      collections: ['sentinel-2-l2a'],
      intersects: {
        type: 'Point',
        coordinates: [lng, lat],
      },
      datetime: timeRange,
      query: {
        'eo:cloud_cover': { lt: 30 },
      },
      limit: 10,
    };

    let response;
    try {
      this.logger.log(`Buscando en STAC API: ${timeRange}`);
      response = await firstValueFrom(
        this.httpService.post(stacApiUrl, queryBody, {
          headers: { 'Content-Type': 'application/json' },
        }),
      );
    } catch (error: any) {
      const apiError = error.response?.data ? JSON.stringify(error.response.data) : error.message;
      this.logger.error(`Error de red/API STAC: ${apiError}`);
      throw new HttpException(`Error AWS STAC: ${apiError}`, HttpStatus.BAD_GATEWAY);
    }

    const data = response.data;

    if (!data.features || data.features.length === 0) {
      this.logger.warn(`No hay imágenes para ${timeRange}.`);
      throw new HttpException(
        'No hay imágenes satelitales despejadas en esta fecha. (Sugerencia: prueba con un año más reciente, ej. 2023)', 
        HttpStatus.NOT_FOUND
      );
    }

    const sortedFeatures = data.features.sort((a: any, b: any) => {
       return (a.properties['eo:cloud_cover'] || 100) - (b.properties['eo:cloud_cover'] || 100);
    });

    const bestItem = sortedFeatures[0];
    const selfLink = bestItem.links.find((l: any) => l.rel === 'self').href;

    // Agregamos resampling=bilinear para suavizar la pixelación en acercamientos profundos
    const tileUrl = `https://titiler.xyz/stac/tiles/WebMercatorQuad/{z}/{x}/{y}?url=${encodeURIComponent(selfLink)}&assets=red&assets=green&assets=blue&rescale=0,3000&resampling=bilinear`;

    this.logger.log(`¡Éxito! Imagen seleccionada: ${bestItem.id} con ${bestItem.properties['eo:cloud_cover']}% de nubes.`);

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
  }
}