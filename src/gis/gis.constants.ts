export interface EcoLayerConfigItem {
  id: string;
  file: string;
  title: string;
  color: string;
  dashArray?: string;
}

export const ECO_LAYERS_CONFIG: EcoLayerConfigItem[] = [
  {
    id: 'aicas',
    file: 'aicas.fgb',
    title: 'Área de Importancia para la Conservación de las Aves (AICA)',
    color: '#e11d48',
    dashArray: '6, 3',
  },
  {
    id: 'ramsar',
    file: 'ramsar.fgb',
    title: 'Sitio Ramsar',
    color: '#0284c7',
    dashArray: '10, 4, 2, 4',
  },
  {
    id: 'anp_federal',
    file: 'anp_federal.fgb',
    title: 'Área Natural Protegida federal',
    color: '#00b050',
  },
  {
    id: 'anp_estatal',
    file: 'anp_estatal.fgb',
    title: 'Área Natural Protegida estatal o municipal',
    color: '#9333ea',
  },
  {
    id: 'advc',
    file: 'advc.fgb',
    title: 'Área Destinada Voluntariamente a la Conservación (ADVC)',
    color: '#0d9488',
    dashArray: '4, 3',
  },
  {
    id: 'rtp',
    file: 'rtp.fgb',
    title: 'Región Terrestre Prioritaria',
    color: '#f97316',
    dashArray: '8, 4',
  },
  {
    id: 'rhp',
    file: 'rhp.fgb',
    title: 'Región Hídrica Prioritaria',
    color: '#06b6d4',
    dashArray: '8, 4',
  },
];

export const VALID_VEG_SERIES = new Set([
  'serie_1',
  'serie_2',
  'serie_3',
  'serie_4',
  'serie_5',
  'serie_6',
  'serie_7',
]);

export interface StrahlerOrderStyle {
  order: number;
  label: string;
  color: string;
  weight: number;
  opacity: number;
}

export const STRAHLER_ORDER_CONFIG: StrahlerOrderStyle[] = [
  { order: 1, label: '1', color: '#0284c7', weight: 2.8, opacity: 1.0 },
  { order: 2, label: '2', color: '#0369a1', weight: 3.5, opacity: 1.0 },
  { order: 3, label: '3', color: '#1d4ed8', weight: 4.3, opacity: 1.0 },
  { order: 4, label: '4', color: '#1e40af', weight: 5.1, opacity: 1.0 },
  { order: 5, label: '5', color: '#1e3a8a', weight: 6.0, opacity: 1.0 },
  { order: 6, label: '6+', color: '#172554', weight: 6.8, opacity: 1.0 },
];

export const getStrahlerOrderNumber = (rawOrder: unknown): number => {
  const parsed = Number(rawOrder);
  if (!Number.isFinite(parsed) || parsed < 1) return 1;
  return Math.min(Math.floor(parsed), 6);
};

export const getStrahlerStyle = (rawOrder: unknown): StrahlerOrderStyle => {
  const orderNum = getStrahlerOrderNumber(rawOrder);
  return STRAHLER_ORDER_CONFIG[orderNum - 1] ?? STRAHLER_ORDER_CONFIG[0];
};

const getHashColor = (str: string): string => {
  const colors = [
    '#65a30d', '#16a34a', '#d97706', '#dc2626', '#2563eb', '#9333ea',
    '#db2777', '#ea580c', '#0284c7', '#059669', '#7c3aed', '#e11d48',
    '#15803d', '#ca8a04', '#0d9488', '#be123c', '#6d28d9', '#c026d3',
  ];
  let hash = 0;
  for (let i = 0; i < str.length; i++) {
    hash = (str.codePointAt(i) ?? 0) + ((hash << 5) - hash);
  }
  return colors[Math.abs(hash) % colors.length];
};

export const getColorForVegetation = (str: string): string => {
  const typeVeg = str.toUpperCase();
  const isSecundaria = typeVeg.includes('SECUNDARIA') || typeVeg.startsWith('V.S.');

  if (isSecundaria) {
    const isArbustivaOHerbacea =
      typeVeg.includes('ARBUSTIVA') ||
      typeVeg.includes('HERBÁCEA') ||
      typeVeg.includes('HERBACEA');

    if (typeVeg.includes('SELVA')) {
      return isArbustivaOHerbacea ? '#e879f9' : '#c084fc';
    }
    if (typeVeg.includes('BOSQUE')) {
      return isArbustivaOHerbacea ? '#86efac' : '#4ade80';
    }
    if (typeVeg.includes('MATORRAL')) return '#fdba74';
    if (typeVeg.includes('MANGLAR')) return '#a78bfa';
    return '#fb7185';
  }

  if (typeVeg.includes('AGRICULTURA')) return '#facc15';
  if (typeVeg.includes('BOSQUE')) return '#15803d';
  if (typeVeg.includes('SELVA')) return '#7e22ce';
  if (typeVeg.includes('MANGLAR')) return '#4c1d95';
  if (typeVeg.includes('PASTIZAL')) return '#84cc16';
  if (typeVeg.includes('MATORRAL')) return '#ea580c';
  if (typeVeg.includes('URBANA') || typeVeg.includes('ASENTAMIENTOS')) return '#64748b';
  if (typeVeg.includes('AGUA') || typeVeg.includes('ACUÍCOLA')) return '#2563eb';
  if (typeVeg.includes('DESPROVISTO')) return '#f472b6';

  return getHashColor(str);
};

export const getColorForClimate = (clave: string, tipoC: string): string => {
  const tipo = tipoC.toUpperCase();
  const c = clave.toUpperCase();

  if (tipo.includes('MUY SECO') || c.startsWith('BW')) return '#dc2626';
  if (tipo.includes('SEMISECO') || tipo.includes('SECO') || c.startsWith('BS')) return '#ea580c';
  if (tipo.includes('CÁLIDO HÚMEDO') || c.startsWith('AF') || c.startsWith('AM')) return '#15803d';
  if (tipo.includes('CÁLIDO SUBHÚMEDO') || c.startsWith('AW')) return '#65a30d';
  if (tipo.includes('SEMICÁLIDO') || c.startsWith('(A)C')) return '#eab308';
  if (tipo.includes('TEMPLADO HÚMEDO') || c.startsWith('CF') || c.startsWith('CM')) return '#0d9488';
  if (tipo.includes('TEMPLADO SUBHÚMEDO') || c.startsWith('CW')) return '#16a34a';
  if (tipo.includes('SEMIFRÍO') || c.includes('C(E)')) return '#2563eb';
  if (tipo.includes('FRÍO') || c.startsWith('E')) return '#4f46e5';

  return getHashColor(`${clave}-${tipoC}`);
};

export const getColorForEdafologia = (grupo: string): string => {
  const g = grupo.toUpperCase();

  if (g.includes('REGOSOL')) return '#eab308';
  if (g.includes('LEPTOSOL')) return '#78716c';
  if (g.includes('VERTISOL')) return '#44403c';
  if (g.includes('PHAEOZEM') || g.includes('FEOZEM')) return '#78350f';
  if (g.includes('CAMBISOL')) return '#d97706';
  if (g.includes('LUVISOL')) return '#dc2626';
  if (g.includes('CALCISOL')) return '#facc15';
  if (g.includes('ANDOSOL')) return '#7c3aed';
  if (g.includes('SOLONCHAK')) return '#db2777';
  if (g.includes('GLEYSOL')) return '#0284c7';
  if (g.includes('ARENOSOL')) return '#fb923c';
  if (g.includes('FLUVISOL')) return '#0ea5e9';
  if (g.includes('KASTANOZEM')) return '#92400e';
  if (g.includes('ACRISOL')) return '#ea580c';
  if (g.includes('PLANOSOL')) return '#64748b';
  if (g.includes('NITISOL')) return '#b91c1c';
  if (g.includes('HISTOSOL')) return '#3f6212';
  if (g.includes('AGUA')) return '#2563eb';
  if (g.includes('URBANA')) return '#64748b';

  return getHashColor(grupo);
};

const EXCLUDED_ECO_KEYS = new Set([
  'ESTADO',
  'ESTADOS',
  'MUNICIPIO',
  'MUNICIPIOS',
  'REGION',
  'CATEGORIA',
  'CAT_MANEJO',
  'TIPO',
  'CLAVE',
  'FECHA',
  'FECHA_INGR',
  'NUM_RAMSAR',
  'NUMERO',
]);

export const getEcoSiteName = (props?: Record<string, unknown> | null): string | null => {
  if (!props) return null;

  const priorityKeys = [
    'NOMBRE',
    'RAMSAR',
    'NOM_AICA',
    'NOM_RTP',
    'NOM_RHP',
    'NOM_ANP',
    'NOM_PREDIO',
    'SITIO',
    'NOM',
    'nombre',
    'Name',
    'NAME',
  ];

  for (const key of priorityKeys) {
    const val = props[key];
    if (typeof val === 'string' && val.trim().length > 0) {
      return val.replace(/\s+/g, ' ').trim();
    }
  }

  for (const [key, val] of Object.entries(props)) {
    if (key.startsWith('_')) continue;
    const upperKey = key.toUpperCase();
    if (EXCLUDED_ECO_KEYS.has(upperKey)) continue;
    if (
      /^(NOM|RAMSAR|AICA|RTP|RHP|ADVC|ANP|SITIO)/.test(upperKey) &&
      typeof val === 'string' &&
      val.trim().length > 0
    ) {
      return val.replace(/\s+/g, ' ').trim();
    }
  }

  return null;
};

const FASES_SUPERFICIALES: Record<string, string> = {
  L: 'Somero (< 50 cm, fase lítica - roca continua)',
  PL: 'Somero (< 50 cm, fase paralítica - roca blanda)',
  PD: 'Somero (< 50 cm, fase petrodúrica - tepetate)',
  PC: 'Somero (< 50 cm, fase petrocálcica - caliche)',
  PG: 'Somero (< 50 cm, fase petrogypsica - yeso)',
};

export const inferirProfundidadEdafica = (props: Record<string, unknown>): string => {
  const grupo = typeof props.N_G1 === 'string' ? props.N_G1.toUpperCase() : '';
  if (grupo.includes('LEPTOSOL') || props.GRUPO1 === 'LP') {
    return 'Muy somero (≤ 25 cm, por grupo Leptosol)';
  }

  const fase = typeof props.F_SUPERF === 'string' ? props.F_SUPERF.trim().toUpperCase() : 'N';
  if (fase && fase !== 'N') {
    return FASES_SUPERFICIALES[fase] ?? `Limitada (< 50 cm, fase ${fase})`;
  }

  const calificadores = `${String(props.N_CP_G1 ?? '')} ${String(props.N_CS_G1 ?? '')}`.toLowerCase();
  if (calificadores.includes('epiléptic') || calificadores.includes('epileptic')) {
    return '25 a 50 cm (calificador Epiléptico)';
  }
  if (calificadores.includes('endoléptic') || calificadores.includes('endoleptic')) {
    return '50 a 100 cm (calificador Endoléptico)';
  }
  if (calificadores.includes('léptic') || calificadores.includes('leptic')) {
    return '25 a 100 cm (calificador Léptico)';
  }

  return 'Sin limitante superficial (> 50 cm)';
};