import { Injectable, HttpException, HttpStatus, Logger } from '@nestjs/common';
import { HttpService } from '@nestjs/axios';
import { firstValueFrom } from 'rxjs';

export type SpectralPreset = 'rgb' | 'nir' | 'swir';
export type SatelliteCollectionOption = 'sentinel-2-l2a' | 'landsat-c2-l2' | 'all';

export interface HistoricalSearchParams {
  lat: number;
  lng: number;
  targetDate: string;
  windowDays: number;
  maxCloud: number;
  collection: SatelliteCollectionOption;
  preset: SpectralPreset;
}

export interface TemporalSceneItem {
  id: string;
  date: string;
  cloudCover: number;
  platform: string;
  collection: string;
  tileUrl: string;
}

@Injectable()
export class SentinelService {
  private readonly logger = new Logger(SentinelService.name);
  private readonly stacApiUrl = 'https://earth-search.aws.element84.com/v1/search';

  constructor(private readonly httpService: HttpService) {}

private getRescaleRange(isLandsat: boolean, preset: SpectralPreset): string {
    if (isLandsat) return '7200,18500';
    return preset === 'rgb' ? '0,3000' : '0,3800';
  }
  private buildTileUrl(
    selfLink: string,
    collection: string,
    preset: SpectralPreset,
  ): string {
    const isLandsat = collection.includes('landsat');
    // Landsat C2 L2 usa enteros uint16 escalados (~7200 a 18500 para reflectancia 0 - 0.3)
    const rescale = this.getRescaleRange(isLandsat, preset);

    const nirAsset = isLandsat ? 'nir08' : 'nir';

    let assetsQuery = 'assets=red&assets=green&assets=blue';
    if (preset === 'nir') {
      assetsQuery = `assets=${nirAsset}&assets=red&assets=green`;
    } else if (preset === 'swir') {
      assetsQuery = `assets=swir16&assets=${nirAsset}&assets=red`;
    }

    return `https://titiler.xyz/stac/tiles/WebMercatorQuad/{z}/{x}/{y}?url=${encodeURIComponent(selfLink)}&${assetsQuery}&rescale=${rescale}&resampling=bilinear`;
  }

  async getBestImagery(lat: number, lng: number, targetDate: string) {
    const result = await this.searchHistoricalScenes({
      lat,
      lng,
      targetDate,
      windowDays: 15,
      maxCloud: 30,
      collection: 'sentinel-2-l2a',
      preset: 'rgb',
    });

    const best = result.scenes[0];
    return {
      success: true,
      tileUrl: best.tileUrl,
      metadata: {
        id: best.id,
        date: best.date,
        cloudCover: best.cloudCover,
        platform: best.platform,
      },
    };
  }

  async searchHistoricalScenes(params: HistoricalSearchParams) {
    const { lat, lng, targetDate, windowDays, maxCloud, collection, preset } = params;
    const baseDate = new Date(`${targetDate}T12:00:00Z`);

    if (Number.isNaN(baseDate.getTime())) {
      throw new HttpException('Fecha inválida', HttpStatus.BAD_REQUEST);
    }

    const msWindow = windowDays * 24 * 60 * 60 * 1000;
    const startDate = new Date(baseDate.getTime() - msWindow);
    const endDate = new Date(baseDate.getTime() + msWindow);
    const timeRange = `${startDate.toISOString()}/${endDate.toISOString()}`;

    const collections =
      collection === 'all'
        ? ['sentinel-2-l2a', 'landsat-c2-l2']
        : [collection];

    const queryBody = {
      collections,
      intersects: {
        type: 'Point',
        coordinates: [lng, lat],
      },
      datetime: timeRange,
      query: {
        'eo:cloud_cover': { lt: maxCloud },
      },
      limit: 25,
    };

    let response;
    try {
      this.logger.log(`Buscando escenas históricas STAC (${collections.join(', ')}): ${timeRange}`);
      response = await firstValueFrom(
        this.httpService.post(this.stacApiUrl, queryBody, {
          headers: { 'Content-Type': 'application/json' },
        }),
      );
    } catch (error: any) {
      const apiError = error.response?.data ? JSON.stringify(error.response.data) : error.message;
      this.logger.error(`Error de red/API STAC: ${apiError}`);
      throw new HttpException(`Error AWS STAC: ${apiError}`, HttpStatus.BAD_GATEWAY);
    }

    const features = response.data?.features ?? [];
    if (features.length === 0) {
      throw new HttpException(
        `No se encontraron escenas despejadas (<${maxCloud}% nubes) en ±${windowDays} días alrededor de ${targetDate}. Amplía la ventana de días o cambia a Landsat para años anteriores a 2016.`,
        HttpStatus.NOT_FOUND,
      );
    }

    // Ordenar primero por menor nubosidad y luego por cercanía a la fecha solicitada
    const sorted = [...features].sort((a: any, b: any) => {
      const cloudDiff = (a.properties['eo:cloud_cover'] ?? 100) - (b.properties['eo:cloud_cover'] ?? 100);
      if (Math.abs(cloudDiff) > 5) return cloudDiff;
      const distA = Math.abs(new Date(a.properties.datetime).getTime() - baseDate.getTime());
      const distB = Math.abs(new Date(b.properties.datetime).getTime() - baseDate.getTime());
      return distA - distB;
    });

    const scenes: TemporalSceneItem[] = sorted
      .map((item: any): TemporalSceneItem | null => {
        const selfLink = item.links?.find((l: any) => l.rel === 'self')?.href;
        if (!selfLink) return null;
        const itemCollection: string = item.collection ?? collections[0];
        return {
          id: item.id,
          date: item.properties.datetime,
          cloudCover: Number((item.properties['eo:cloud_cover'] ?? 0).toFixed(1)),
          platform: item.properties.platform ?? itemCollection,
          collection: itemCollection,
          tileUrl: this.buildTileUrl(selfLink, itemCollection, preset),
        };
      })
      .filter((s): s is TemporalSceneItem => s !== null);

    return {
      success: true,
      total: scenes.length,
      scenes,
    };
  }
}