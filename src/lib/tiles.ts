import geojsonvt from "geojson-vt";
import vtpbf from "vt-pbf";
import type { Feature, FeatureCollection as GJFeatureCollection, Geometry } from "geojson";

export type GeoJSONFeature = Feature<Geometry, Record<string, unknown>>;

export type FeatureCollection = GJFeatureCollection<Geometry, Record<string, unknown>>;

export function featuresToTilePBF(
  features: GeoJSONFeature[],
  z: number,
  x: number,
  y: number
): Uint8Array {
  const fc: FeatureCollection = { type: "FeatureCollection", features };
  const tileIndex = geojsonvt(fc, {
    maxZoom: 20,
    indexMaxZoom: 14,
    indexMaxPoints: 0,
  });
  const tile = tileIndex.getTile(z, x, y);
  type VTFeature = { type: number; geometry: unknown; tags: unknown };
  const layers: Record<string, { features: VTFeature[] }> = {
    points: { features: [] },
  };
  if (tile) {
    layers.points.features = (tile.features as Array<{ geometry: unknown; tags?: unknown }>).map((f) => ({
      type: 1,
      geometry: f.geometry,
      tags: f.tags ?? {},
    }));
  }
  // Emit Vector Tile Spec v2 to avoid Mapbox warnings and rendering quirks
  const buf = vtpbf.fromGeojsonVt(layers, { version: 2 });
  return buf instanceof Uint8Array ? buf : new Uint8Array(buf);
}


