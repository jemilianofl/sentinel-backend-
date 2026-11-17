declare module 'shpjs' {
  const shp: (buffer: ArrayBuffer | SharedArrayBuffer) => Promise<unknown>;
  export default shp;
}