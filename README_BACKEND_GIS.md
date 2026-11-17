# Contexto de Arquitectura SIG y Migración al Backend (NestJS)

Este documento registra el estado actual de los insumos geoespaciales alojados en Cloudflare R2, sus esquemas de atributos y los procesos que deben migrarse del frontend (React + Leaflet) al backend (NestJS) para optimizar el rendimiento.

---

## 1. Inventario de Capas FlatGeobuf (`.fgb`) en Cloudflare R2

- **Bucket:** `profepa-capas-sig` (acceso público vía `VITE_R2_PUBLIC_URL`)
- **Proyección unificada:** `EPSG:4326` (WGS84) con índice espacial **Hilbert R-Tree** (`SPATIAL_INDEX=YES`).
- **Uso total de almacenamiento:** `7.586 GB` / `10.000 GB` gratuitos (`2.414 GB` libres).

| Plano | Capa | Archivo en R2 | Tamaño | Geometrías | Campos clave de atributos |
| :--- | :--- | :--- | :---: | :---: | :--- |
| **Plano 2** | Áreas Destinadas Voluntariamente a la Conservación | `advc.fgb` | 3.10 MB | Polígonos | `NOMBRE` |
| **Plano 2** | Áreas de Importancia para la Conservación de las Aves | `aicas.fgb` | 1.39 MB | Polígonos | `NOM_AICA`, `NOMBRE` |
| **Plano 2** | ANP Estatales | `anp_estatal.fgb` | 3.32 MB | Polígonos | `NOMBRE` |
| **Plano 2** | ANP Federales | `anp_federal.fgb` | 7.64 MB | Polígonos | `NOMBRE` |
| **Plano 2** | Sitios Ramsar | `ramsar.fgb` | 2.63 MB | Polígonos | `SITIO`, `NOMBRE` |
| **Plano 2** | Regiones Hidrológicas Prioritarias | `rhp.fgb` | 2.93 MB | Polígonos | `NOMBRE` |
| **Plano 2** | Regiones Terrestres Prioritarias | `rtp.fgb` | 2.69 MB | Polígonos | `NOMBRE` |
| **Plano 3** | Uso de Suelo y Vegetación (Series I a VII) | `usv_serie_1.fgb` .. `usv_serie_7.fgb` | 276–432 MB c/u | Polígonos | `DESCRIPCIO`, `TIPO_VEG`, `CLAVE` |
| **Plano 4** | Unidades Climáticas (CONABIO / García 1998) | `climas.fgb` | 6.49 MB | Polígonos | `CLAVE` (ej. `Aw2`), `TIPO_C` (ej. `Cálido subhúmedo`) |
| **Plano 5** | Edafología Serie II (INEGI 1:250,000) | `edafologia.fgb` | 251.47 MB | Polígonos | `CLAVE_WRB`, `N_G1`, `N_G2`, `N_G3`, `TEXTURA`, `CLASE_TEX`, `F_SUPERF`, `FRUDICA`, `N_CP_G1`, `N_CS_G1` |
| **Plano 6** | Subcuencas Hidrográficas 1:50,000 (SIATL) | `subcuencas_50k.fgb` | 84.42 MB | 976 | `CVE_SUBCUE`, `SUBCUENCA`, `CVE_CUE`, `CUENCA`, `CVE_RH`, `RH`, `AREA_KM2`, `TIPO`, `DRENAJE1` |
| **Plano 6** | Cuerpos de Agua 1:50,000 (SIATL) | `cuerpos_agua_50k.fgb` | 246.10 MB | 198,644 | `IDBD`, `FC`, `CONDICION` |
| **Plano 6** | Red Hidrográfica 1:50,000 (SIATL - Strahler) | `red_hidrografica_50k.fgb` | 4,014.80 MB | 6,202,027 | `CVE_SUBC`, `ENTIDAD`, `CONDICION`, `ORDER_1` (1–6+), `LEVEL_1`, `LENGTHM`, `ARBSUM_1`, `PATHL_1` |
| **Respaldo** | Cuencas y Subcuencas macro (CNA / CONABIO) | `cuencas_cna.fgb`, `subcuencas_conabio.fgb`, `cuencas_2007.fgb`, `cuencas_ig.fgb` | 0.3–11.3 MB | Polígonos | Referencia hidrológica macro |

---

## 2. Procesos a Migrar del Frontend al Backend (NestJS)

Actualmente el navegador descarga los fragmentos vía *HTTP Range Requests* directamente desde R2 y realiza operaciones espaciales con `@turf/turf`. Migrar estos procesos a un módulo `GisModule` (`GisController` + `GisService`) en NestJS reducirá el peso del bundle y evitará bloqueos en el hilo principal del navegador:

| Proceso actual en Frontend | Problema de rendimiento en cliente | Endpoint propuesto en Backend (NestJS) | Responsabilidad del servidor |
| :--- | :--- | :--- | :--- |
| **Consultas directas a R2 desde hooks** (`useEcoLayers`, `useVegetationLayers`, `useClimateLayers`, `useEdafologiaLayers`, `useHidrologiaLayers`) | Múltiples peticiones HTTP Range simultáneas desde el navegador; exposición directa de la estructura de archivos del bucket. | `POST /gis/context` | Recibir el GeoJSON del predio (y el plano o lista de capas solicitadas), consultar los `.fgb` en R2 usando `flatgeobuf` en Node.js y cachear respuestas por BBOX/hash de geometría. |
| **Intersección y recorte espacial en navegador** (`turf.booleanIntersects` sobre miles de vértices, especialmente en `red_hidrografica_50k.fgb` con 6.2M tramos) | Bloquea el hilo principal de React al procesar polígonos complejos o redes densas de corrientes dentro del buffer de 10 km. | `POST /gis/context` (procesamiento interno) | Ejecutar `deserialize` con `{ rect }` + `turf.booleanIntersects` y `turf.bboxClip` en el servidor para recortar geometrías exactamente al buffer de estudio antes de enviarlas al cliente. |
| **Parseo y validación de archivos espaciales** (`shpjs`, `@tmcw/togeojson`, `turf.truncate`, `turf.area` en `GeoViewer.tsx`) | Incrementa el tamaño del bundle JS y falla si el usuario sube un Shapefile proyectado en UTM (ej. Zona 13N/14N) en lugar de `EPSG:4326`. | `POST /gis/parse-polygon` | Recibir `.zip` (SHP), `.kml` o `.geojson` vía `multipart/form-data`, reproyectar automáticamente a `EPSG:4326` si viene en coordenadas UTM, asignar `polyId` (`A, B, C...`) y calcular superficies exactas en m² y ha. |
| **Cálculo de estadísticas y resumen del dictamen** (tipos de suelo, profundidad inferida, climas, vegetación y orden Strahler dominante) | Obliga a recalcular métricas dentro de componentes visuales (`MapLegends.tsx`) y dificulta exportar reportes tabulares o PDF/DOCX. | `POST /gis/context` (campo `summary`) | Devolver junto con el GeoJSON recortado un objeto `summary` con intersecciones exactas contra el predio inspeccionado (ej. cuenca/subcuenca SIATL, orden Strahler máximo, grupo WRB, textura, profundidad estimada y vegetación dominante). |
| **Construcción de `.fgb` locales** (`scripts/scrape-siatl.mjs`, `scripts/sync-r2.mjs`) | Scripts manuales ejecutados localmente por el desarrollador. | Mantener en `scripts/` (CLI) | Conservar en `scripts/` fuera del despliegue productivo para actualizaciones periódicas de cartografía nacional INEGI/CONABIO. |