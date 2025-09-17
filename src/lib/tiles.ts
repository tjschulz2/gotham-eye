import geojsonvt from "geojson-vt";
import vtpbf from "vt-pbf";

export type GeoJSONFeature = {
  type: "Feature";
  geometry: { type: string; coordinates: any };
  properties: Record<string, any>;
};

export type FeatureCollection = {
  type: "FeatureCollection";
  features: GeoJSONFeature[];
};

export function featuresToTilePBF(
  features: GeoJSONFeature[],
  z: number,
  x: number,
  y: number
): Buffer {
  const fc: FeatureCollection = { type: "FeatureCollection", features };
  const tileIndex = geojsonvt(fc as any, {
    maxZoom: 20,
    indexMaxZoom: 14,
    indexMaxPoints: 0,
  });
  const tile = tileIndex.getTile(z, x, y);
  const layers: Record<string, any> = { points: { features: [] as any[] } };
  if (tile) {
    layers.points.features = tile.features.map((f: any) => ({
      type: 1,
      geometry: f.geometry,
      tags: f.tags,
    }));
  }
  // Emit Vector Tile Spec v2 to avoid Mapbox warnings and rendering quirks
  return Buffer.from(vtpbf.fromGeojsonVt(layers, { version: 2 } as any));
}


