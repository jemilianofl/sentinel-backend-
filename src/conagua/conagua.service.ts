import { Injectable, HttpException, HttpStatus, Logger, NotFoundException } from '@nestjs/common';
import axios, { AxiosInstance } from 'axios';
import * as cheerio from 'cheerio';
import * as https from 'node:https';

export interface EstacionCandidata {
  clave: string;
  nombre: string;
  municipio: string;
  urlNormales: string;
  periodo: string;
}

export interface ClimogramaPunto {
  mes: string;
  tMax: number;
  tMin: number;
  tMed: number;
  precipitacion: number;
}

interface NormalParseada {
  lat: number | null;
  lng: number | null;
  datos: ClimogramaPunto[];
}

const MESES_ETIQUETAS = ['Ene', 'Feb', 'Mar', 'Abr', 'May', 'Jun', 'Jul', 'Ago', 'Sep', 'Oct', 'Nov', 'Dic'];

const MAPA_ESTADOS: Record<string, string> = {
  AGUASCALIENTES: 'ags',
  'BAJA CALIFORNIA': 'bc',
  'BAJA CALIFORNIA SUR': 'bcs',
  CAMPECHE: 'camp',
  COAHUILA: 'coah',
  COLIMA: 'col',
  CHIAPAS: 'chis',
  CHIHUAHUA: 'chih',
  'CIUDAD DE MEXICO': 'df',
  'DISTRITO FEDERAL': 'df',
  DURANGO: 'dgo',
  GUANAJUATO: 'gto',
  GUERRERO: 'gro',
  HIDALGO: 'hgo',
  JALISCO: 'jal',
  'ESTADO DE MEXICO': 'mex',
  MEXICO: 'mex',
  MICHOACAN: 'mich',
  MORELOS: 'mor',
  NAYARIT: 'nay',
  'NUEVO LEON': 'nl',
  OAXACA: 'oax',
  PUEBLA: 'pue',
  QUERETARO: 'qro',
  'QUINTANA ROO': 'qroo',
  'SAN LUIS POTOSI': 'slp',
  SINALOA: 'sin',
  SONORA: 'son',
  TABASCO: 'tab',
  TAMAULIPAS: 'tams',
  TLAXCALA: 'tlax',
  VERACRUZ: 'ver',
  YUCATAN: 'yuc',
  ZACATECAS: 'zac',
};

@Injectable()
export class ConaguaService {
  private readonly logger = new Logger(ConaguaService.name);
  private readonly axiosClient: AxiosInstance;

  constructor() {
    this.axiosClient = axios.create({
      timeout: 30000,
      headers: {
        'User-Agent':
          'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
      },
      httpsAgent: new https.Agent({ rejectUnauthorized: false }),
    });
  }

  private normalizarTexto(texto: string): string {
    if (!texto) return '';
    return texto
      .normalize('NFD')
      .replaceAll(/[\u0300-\u036f]/g, '')
      .toUpperCase()
      .trim();
  }

  private calcularDistancia(lat1: number, lng1: number, lat2: number, lng2: number): number {
    const R = 6371;
    const dLat = (lat2 - lat1) * (Math.PI / 180);
    const dLng = (lng2 - lng1) * (Math.PI / 180);
    const a =
      Math.sin(dLat / 2) * Math.sin(dLat / 2) +
      Math.cos(lat1 * (Math.PI / 180)) *
        Math.cos(lat2 * (Math.PI / 180)) *
        Math.sin(dLng / 2) *
        Math.sin(dLng / 2);
    return R * (2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a)));
  }

  async buscarEstacionesPorMunicipio(
    estadoCodigo: string,
    municipioTarget: string,
  ): Promise<EstacionCandidata[]> {
    const baseUrl = 'https://smn.conagua.gob.mx/tools/RESOURCES/Normales_Climatologicas/';
    const urlCatalogo = `${baseUrl}catalogo/cat_${estadoCodigo.toLowerCase()}.html`;
    const municipioNormalizado = this.normalizarTexto(municipioTarget);

    try {
      const response = await this.axiosClient.get<string>(urlCatalogo);
      const $ = cheerio.load(response.data);
      const estaciones: EstacionCandidata[] = [];

      $('table tr').each((_i, row) => {
        const celdas = $(row).find('td');
        if (celdas.length < 8) return;

        const municipioFila = this.normalizarTexto($(celdas[2]).text());
        const situacion = this.normalizarTexto($(celdas[3]).text());

        if (
          municipioFila !== municipioNormalizado ||
          !situacion.includes('OPERANDO') ||
          situacion.includes('SUSPENDIDA')
        ) {
          return;
        }

        // Busca el enlace exacto de 1981-2010 por texto o por ruta (/1981-2010/ o /8110/), con respaldo a 1991-2020
        let hrefSeleccionado = '';
        let periodoSeleccionado = '1981-2010';

        celdas.each((_idx, td) => {
          const anchor = $(td).find('a');
          const textoLink = anchor.text().trim();
          const href = anchor.attr('href') ?? '';

          if (textoLink.includes('1981-2010') || href.includes('1981-2010') || href.includes('8110')) {
            hrefSeleccionado = href;
            periodoSeleccionado = '1981-2010';
          } else if (
            !hrefSeleccionado &&
            (textoLink.includes('1991-2020') || href.includes('1991-2020') || href.includes('9120'))
          ) {
            hrefSeleccionado = href;
            periodoSeleccionado = '1991-2020';
          }
        });

        if (hrefSeleccionado) {
          estaciones.push({
            clave: $(celdas[0]).text().trim(),
            nombre: $(celdas[1]).text().trim(),
            municipio: $(celdas[2]).text().trim(),
            urlNormales: new URL(hrefSeleccionado.replace(/^\.\.\//, ''), baseUrl).href,
            periodo: periodoSeleccionado,
          });
        }
      });

      this.logger.log(
        `Estaciones operando en ${municipioTarget} (${estadoCodigo}): ${estaciones.length}`,
      );
      return estaciones;
    } catch (error) {
      this.logger.error(`Error procesando catálogo del estado ${estadoCodigo}:`, error);
      throw new HttpException('Error al conectar con CONAGUA', HttpStatus.BAD_GATEWAY);
    }
  }

  private extraerCoordenadasDeLineas(lineas: string[]): { lat: number | null; lng: number | null } {
    let lat: number | null = null;
    let lng: number | null = null;

    for (const linea of lineas.slice(0, 35)) {
      const latMatch = /LATITUD\s*:\s*([+-]?\d+(?:\.\d+)?)/i.exec(linea);
      if (latMatch) lat = Number.parseFloat(latMatch[1]);

      const lngMatch = /LONGITUD\s*:\s*([+-]?\d+(?:\.\d+)?)/i.exec(linea);
      if (lngMatch) lng = Number.parseFloat(lngMatch[1]);
    }

    return { lat, lng };
  }

  private extraerValoresMensualesDeLinea(linea: string): number[] {
    const tokens = linea.trim().split(/\s+/);
    const numeros: number[] = [];

    for (const token of tokens) {
      if (/^[+-]?\d+(?:\.\d+)?$/.test(token)) {
        numeros.push(Number.parseFloat(token));
      }
    }

    // Las filas de normales tienen 12 meses + 1 columna ANUAL (13 números); tomamos los primeros 12
    return numeros.length >= 12 ? numeros.slice(0, 12) : [];
  }

  async descargarYParsearNormal(urlArchivoTxt: string): Promise<NormalParseada> {
    try {
      const response = await this.axiosClient.get<string>(urlArchivoTxt, { responseType: 'text' });
      const contentType = response.headers['content-type'];
      if (typeof contentType === 'string' && contentType.toLowerCase().includes('text/html')) {
        throw new Error('Falso 404 (HTML devuelto en lugar de TXT)');
      }

      const lineas = response.data.split(/\r?\n/);
      const { lat, lng } = this.extraerCoordenadasDeLineas(lineas);

      const tMaxMeses = new Array<number>(12).fill(Number.NaN);
      const tMinMeses = new Array<number>(12).fill(Number.NaN);
      const tMedMeses = new Array<number>(12).fill(Number.NaN);
      const precipMeses = new Array<number>(12).fill(Number.NaN);

      let seccionActual: 'TMAX' | 'TMIN' | 'TMED' | 'PRECIP' | null = null;

      for (const lineaRaw of lineas) {
        const lineaNorm = this.normalizarTexto(lineaRaw);
        if (!lineaNorm) continue;

        // Detección de bloque de variable en el TXT de Normales OMM
        if (lineaNorm.includes('TEMPERATURA MAXIMA')) {
          seccionActual = 'TMAX';
        } else if (lineaNorm.includes('TEMPERATURA MINIMA')) {
          seccionActual = 'TMIN';
        } else if (lineaNorm.includes('TEMPERATURA MEDIA')) {
          seccionActual = 'TMED';
        } else if (lineaNorm.includes('PRECIPITACION')) {
          seccionActual = 'PRECIP';
        }

        // En archivos de Normales OMM, la fila con los 12 valores mensuales empieza con NORMAL
        if (seccionActual && lineaNorm.startsWith('NORMAL')) {
          const vals = this.extraerValoresMensualesDeLinea(lineaRaw);
          if (vals.length === 12) {
            if (seccionActual === 'TMAX') vals.forEach((v, idx) => (tMaxMeses[idx] = v));
            if (seccionActual === 'TMIN') vals.forEach((v, idx) => (tMinMeses[idx] = v));
            if (seccionActual === 'TMED') vals.forEach((v, idx) => (tMedMeses[idx] = v));
            if (seccionActual === 'PRECIP') vals.forEach((v, idx) => (precipMeses[idx] = v));
            seccionActual = null;
          }
        }
      }

      const datos: ClimogramaPunto[] = [];
      for (let i = 0; i < 12; i++) {
        const tMax = tMaxMeses[i];
        const tMin = tMinMeses[i];
        const tMed = Number.isFinite(tMedMeses[i])
          ? tMedMeses[i]
          : Number(((tMax + tMin) / 2).toFixed(2));
        const precipitacion = precipMeses[i];

        if (Number.isFinite(tMax) && Number.isFinite(tMin) && Number.isFinite(precipitacion)) {
          datos.push({
            mes: MESES_ETIQUETAS[i],
            tMax,
            tMin,
            tMed,
            precipitacion,
          });
        }
      }

      return { lat, lng, datos };
    } catch (error) {
      this.logger.error(`Error descargando TXT de ${urlArchivoTxt}:`, error);
      throw new HttpException('Error procesando el archivo TXT de CONAGUA', HttpStatus.BAD_GATEWAY);
    }
  }

  async procesarClimograma(
    estado: string,
    municipio: string,
    latPoligono: number,
    lngPoligono: number,
  ) {
    const estadoNorm = this.normalizarTexto(estado);
    const codigoEstado = MAPA_ESTADOS[estadoNorm] || estadoNorm.slice(0, 3).toLowerCase();

    const estaciones = await this.buscarEstacionesPorMunicipio(codigoEstado, municipio);
    if (estaciones.length === 0) {
      throw new NotFoundException(
        `No se encontraron estaciones operativas con normales climatológicas en ${municipio}, ${estado}.`,
      );
    }

    // Descargamos los TXT de las estaciones operativas del municipio para leer sus coordenadas exactas
    const evaluadas = await Promise.all(
      estaciones.map(async (est) => {
        try {
          const parsed = await this.descargarYParsearNormal(est.urlNormales);
          const distanciaKm =
            parsed.lat !== null && parsed.lng !== null
              ? this.calcularDistancia(latPoligono, lngPoligono, parsed.lat, parsed.lng)
              : Infinity;

          return { est, parsed, distanciaKm };
        } catch {
          return null;
        }
      }),
    );

    const validas = evaluadas.filter(
      (item): item is NonNullable<typeof item> => item !== null && item.parsed.datos.length === 12,
    );

    if (validas.length === 0) {
      throw new NotFoundException(
        `Las estaciones operativas de ${municipio}, ${estado} no contienen series mensuales completas.`,
      );
    }

    // Ordenamos por menor distancia real al centroide del polígono
    validas.sort((a, b) => a.distanciaKm - b.distanciaKm);
    const ganadora = validas[0];

    return {
      estacion: ganadora.est.nombre,
      municipio: ganadora.est.municipio,
      clave: ganadora.est.clave,
      estado,
      periodo: ganadora.est.periodo,
      coordenadas: [ganadora.parsed.lat ?? latPoligono, ganadora.parsed.lng ?? lngPoligono],
      distanciaKm: Number.isFinite(ganadora.distanciaKm)
        ? Number(ganadora.distanciaKm.toFixed(2))
        : null,
      datos: ganadora.parsed.datos,
    };
  }
}