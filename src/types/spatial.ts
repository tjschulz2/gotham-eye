// Types for spatial indexing and neighborhood data

import type { Feature, Polygon, MultiPolygon } from 'geojson';
import type { CityId } from '@/lib/city-config';

// Neighborhood feature from GeoJSON
export interface NeighborhoodFeature extends Feature<Polygon | MultiPolygon> {
  properties: {
    [key: string]: unknown;
    // Common properties we expect
    name?: string;
    id?: string;
    ntacode?: string;
    ntaname?: string;
    // SF specific
    nhood?: string;
    // NYC specific  
    boro_name?: string;
  };
}

// Processed neighborhood metadata
export interface NeighborhoodMeta {
  regionId: string;
  regionName: string;
  city: CityId;
  properties: Record<string, unknown>;
}

// H3 index mapping
export interface H3ToRegionMap {
  [h3Index: string]: string; // h3Index -> regionId
}

// Spatial index for a city
export interface CityIndex {
  city: CityId;
  h3ToRegionMap: H3ToRegionMap;
  regionMeta: Map<string, NeighborhoodMeta>;
  totalRegions: number;
  h3Resolution: number;
}

// Global spatial registry
export interface SpatialRegistry {
  [city: string]: CityIndex;
}

// Configuration for spatial indexing
export interface SpatialConfig {
  h3Resolution: number;
  geojsonFiles: {
    [city: string]: {
      path: string;
      regionIdField: string; // field to use as regionId
      regionNameField: string; // field to use as regionName
    };
  };
}

// Point-in-polygon lookup result
export interface PointLookupResult {
  regionId: string | null;
  regionName: string | null;
  regionMeta: NeighborhoodMeta | null;
}

// Batch lookup for multiple points
export interface BatchPointLookup {
  lat: number;
  lon: number;
  id?: string; // optional identifier for the point
}

export interface BatchLookupResult {
  id?: string;
  lat: number;
  lon: number;
  regionId: string | null;
  regionName: string | null;
}

// Statistics about the spatial index
export interface SpatialIndexStats {
  totalCities: number;
  citiesLoaded: string[];
  totalRegions: number;
  totalH3Cells: number;
  h3Resolution: number;
  memoryUsageEstimate: string;
}
