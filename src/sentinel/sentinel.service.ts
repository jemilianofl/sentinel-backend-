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
      limit: 10, // Pedimos las primeras 10 para ordenarlas localmente
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

    // La petición a AWS fue exitosa, validamos los resultados
    const data = response.data;

    if (!data.features || data.features.length === 0) {
      this.logger.warn(`No hay imágenes para ${timeRange}. Las imágenes L2A de Sentinel-2 suelen estar disponibles post-2017.`);
      throw new HttpException(
        'No hay imágenes satelitales despejadas en esta fecha. (Sugerencia: prueba con un año más reciente, ej. 2023)', 
        HttpStatus.NOT_FOUND
      );
    }

    // Ordenamos en JavaScript por porcentaje de nubosidad (la más limpia primero)
    const sortedFeatures = data.features.sort((a: any, b: any) => {
       return (a.properties['eo:cloud_cover'] || 100) - (b.properties['eo:cloud_cover'] || 100);
    });

    const bestItem = sortedFeatures[0];
    const selfLink = bestItem.links.find((l: any) => l.rel === 'self').href;

    const tileUrl = `https://titiler.xyz/stac/tiles/WebMercatorQuad/{z}/{x}/{y}?url=${encodeURIComponent(selfLink)}&assets=visual&color_formula=gamma+r+1.2+g+1.2+b+1.2`;

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