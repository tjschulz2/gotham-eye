declare module 'vt-pbf' {
  export function fromGeojsonVt(
    layers: Record<string, { features: Array<{ type: number; geometry: unknown; tags: unknown }> }>,
    options?: { version?: number }
  ): Uint8Array;

  const _default: {
    fromGeojsonVt: typeof fromGeojsonVt;
  };
  export default _default;
}


