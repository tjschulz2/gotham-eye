declare module "*.geojson" {
  import type { FeatureCollection, Geometry, GeoJsonProperties } from "geojson";
  const value: FeatureCollection<Geometry, GeoJsonProperties>;
  export default value;
}


