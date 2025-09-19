// Spatial service for neighborhood indexing using H3
// Loads GeoJSON files and creates H3-based spatial index for fast point-in-polygon lookups

import { readFileSync } from 'fs';
import { join } from 'path';
import { polygonToCells, latLngToCell } from 'h3-js';
import type { FeatureCollection } from 'geojson';
import type { CityId } from '@/lib/city-config';
// import { getRegionIdFromFeature } from '@/lib/choropleth-colors';
import type {
  NeighborhoodFeature,
  NeighborhoodMeta,
  H3ToRegionMap,
  CityIndex,
  SpatialRegistry,
  SpatialConfig,
  PointLookupResult,
  BatchPointLookup,
  BatchLookupResult,
  SpatialIndexStats
} from '@/types/spatial';

// Configuration for spatial indexing
const SPATIAL_CONFIG: SpatialConfig = {
  h3Resolution: 9, // Good balance of accuracy vs performance
  geojsonFiles: {
    nyc: {
      path: 'public/nyc_nta_2020.geojson',
      regionIdField: 'NTA2020', // Use NTA code as region ID
      regionNameField: 'NTAName', // Use NTA name as display name
    },
    sf: {
      path: 'public/sf_nta_2025.geojson', 
      regionIdField: 'name', // Use neighborhood name as region ID for SF
      regionNameField: 'name', // Same field for display name
    },
  },
};

// Global spatial registry - loaded once at server start
let spatialRegistry: SpatialRegistry = {};
let isInitialized = false;

/**
 * Load and parse GeoJSON file
 */
function loadGeoJSON(filePath: string): FeatureCollection {
  try {
    const fullPath = join(process.cwd(), filePath);
    const data = readFileSync(fullPath, 'utf-8');
    return JSON.parse(data) as FeatureCollection;
  } catch (error) {
    console.error(`Failed to load GeoJSON file: ${filePath}`, error);
    throw new Error(`Could not load spatial data from ${filePath}`);
  }
}

/**
 * Extract region ID and name from feature properties
 */
function extractRegionInfo(
  feature: NeighborhoodFeature, 
  config: { regionIdField: string; regionNameField: string }
): { regionId: string; regionName: string } {
  const props = feature.properties || {};
  
  const regionId = props[config.regionIdField] || 
                   props.id || 
                   props.name || 
                   `unknown_${Math.random().toString(36).substr(2, 9)}`;
                   
  const regionName = props[config.regionNameField] || 
                     props.name || 
                     regionId;

  return {
    regionId: String(regionId).trim(),
    regionName: String(regionName).trim(),
  };
}

/**
 * Fill polygon with H3 cells at specified resolution
 */
function fillPolygonWithH3(feature: NeighborhoodFeature, resolution: number): string[] {
  try {
    const geometry = feature.geometry;
    
    if (geometry.type === 'Polygon') {
      // Single polygon - convert GeoJSON coordinates [lon, lat] to H3 format [lat, lon]
      const coordinates = geometry.coordinates[0]; // Outer ring only
      const h3Coordinates = coordinates.map(([lon, lat]) => [lat, lon]);
      return polygonToCells(h3Coordinates, resolution);
    } else if (geometry.type === 'MultiPolygon') {
      // Multiple polygons - combine all H3 cells
      const allCells: string[] = [];
      for (const polygon of geometry.coordinates) {
        const coordinates = polygon[0]; // Outer ring only
        const h3Coordinates = coordinates.map(([lon, lat]) => [lat, lon]);
        const cells = polygonToCells(h3Coordinates, resolution);
        allCells.push(...cells);
      }
      // Remove duplicates
      return [...new Set(allCells)];
    } else {
      console.warn(`Unsupported geometry type: ${(geometry as GeoJSON.Geometry).type}`);
      return [];
    }
  } catch (error) {
    console.error('Error filling polygon with H3:', error);
    return [];
  }
}

/**
 * Build spatial index for a single city
 */
function buildCityIndex(cityId: CityId): CityIndex {
  const config = SPATIAL_CONFIG.geojsonFiles[cityId];
  if (!config) {
    throw new Error(`No spatial configuration found for city: ${cityId}`);
  }

  console.log(`Loading spatial data for ${cityId}...`);
  
  // Load GeoJSON
  const geojson = loadGeoJSON(config.path);
  const features = geojson.features as NeighborhoodFeature[];
  
  console.log(`Loaded ${features.length} neighborhoods for ${cityId}`);

  // Build H3 index
  const h3ToRegionMap: H3ToRegionMap = {};
  const regionMeta = new Map<string, NeighborhoodMeta>();
  let totalH3Cells = 0;

  for (const feature of features) {
    const { regionId, regionName } = extractRegionInfo(feature, config);
    
    // Store region metadata
    regionMeta.set(regionId, {
      regionId,
      regionName,
      city: cityId,
      properties: feature.properties || {},
    });

    // Fill polygon with H3 cells
    const h3Cells = fillPolygonWithH3(feature, SPATIAL_CONFIG.h3Resolution);
    totalH3Cells += h3Cells.length;

    // Map each H3 cell to this region
    for (const h3Index of h3Cells) {
      h3ToRegionMap[h3Index] = regionId;
    }
  }

  console.log(`Built H3 index for ${cityId}: ${features.length} regions, ${totalH3Cells} H3 cells`);

  return {
    city: cityId,
    h3ToRegionMap,
    regionMeta,
    totalRegions: features.length,
    h3Resolution: SPATIAL_CONFIG.h3Resolution,
  };
}

/**
 * Reset spatial index (for development/testing)
 */
export function resetSpatialIndex(): void {
  spatialRegistry = {};
  isInitialized = false;
  console.log('Spatial index reset');
}

/**
 * Initialize spatial registry - call this at server startup
 */
export function initializeSpatialIndex(): void {
  if (isInitialized) {
    console.log('Spatial index already initialized');
    return;
  }

  console.log('Initializing spatial index...');
  const startTime = Date.now();

  try {
    // Build index for each city
    for (const cityId of Object.keys(SPATIAL_CONFIG.geojsonFiles) as CityId[]) {
      spatialRegistry[cityId] = buildCityIndex(cityId);
    }

    isInitialized = true;
    const duration = Date.now() - startTime;
    console.log(`Spatial index initialized in ${duration}ms`);
    
    // Log stats
    const stats = getSpatialIndexStats();
    console.log('Spatial index stats:', stats);
    
  } catch (error) {
    console.error('Failed to initialize spatial index:', error);
    throw error;
  }
}

/**
 * Lookup point in spatial index
 */
export function lookupPoint(cityId: CityId, lat: number, lon: number): PointLookupResult {
  if (!isInitialized) {
    console.log('Spatial index not initialized, initializing now...');
    initializeSpatialIndex();
  }

  const cityIndex = spatialRegistry[cityId];
  if (!cityIndex) {
    return { regionId: null, regionName: null, regionMeta: null };
  }

  try {
    // Validate coordinates
    if (!isFinite(lat) || !isFinite(lon) || lat < -90 || lat > 90 || lon < -180 || lon > 180) {
      console.warn(`Invalid coordinates: lat=${lat}, lon=${lon}`);
      return { regionId: null, regionName: null, regionMeta: null };
    }

    // Convert lat/lon to H3 index
    // H3 expects lat, lon order
    const h3Index = latLngToCell(lat, lon, cityIndex.h3Resolution);
    
    // Lookup region
    const regionId = cityIndex.h3ToRegionMap[h3Index];
    if (!regionId) {
      return { regionId: null, regionName: null, regionMeta: null };
    }

    const regionMeta = cityIndex.regionMeta.get(regionId);
    return {
      regionId,
      regionName: regionMeta?.regionName || regionId,
      regionMeta: regionMeta || null,
    };
  } catch (error) {
    console.warn(`Error in point lookup for (${lat}, ${lon}):`, error instanceof Error ? error.message : String(error));
    return { regionId: null, regionName: null, regionMeta: null };
  }
}

/**
 * Batch lookup for multiple points
 */
export function batchLookupPoints(cityId: CityId, points: BatchPointLookup[]): BatchLookupResult[] {
  return points.map(point => {
    const result = lookupPoint(cityId, point.lat, point.lon);
    return {
      id: point.id,
      lat: point.lat,
      lon: point.lon,
      regionId: result.regionId,
      regionName: result.regionName,
    };
  });
}

/**
 * Get all regions for a city
 */
export function getCityRegions(cityId: CityId): NeighborhoodMeta[] {
  if (!isInitialized) {
    console.log('Spatial index not initialized, initializing now...');
    initializeSpatialIndex();
  }

  const cityIndex = spatialRegistry[cityId];
  if (!cityIndex) {
    return [];
  }

  return Array.from(cityIndex.regionMeta.values());
}

/**
 * Get spatial index statistics
 */
export function getSpatialIndexStats(): SpatialIndexStats {
  const totalCities = Object.keys(spatialRegistry).length;
  const citiesLoaded = Object.keys(spatialRegistry);
  
  let totalRegions = 0;
  let totalH3Cells = 0;
  
  for (const cityIndex of Object.values(spatialRegistry)) {
    totalRegions += cityIndex.totalRegions;
    totalH3Cells += Object.keys(cityIndex.h3ToRegionMap).length;
  }

  // Rough memory estimate
  const avgBytesPerH3Cell = 50; // Rough estimate for string key + value
  const memoryBytes = totalH3Cells * avgBytesPerH3Cell;
  const memoryMB = (memoryBytes / 1024 / 1024).toFixed(2);

  return {
    totalCities,
    citiesLoaded,
    totalRegions,
    totalH3Cells,
    h3Resolution: SPATIAL_CONFIG.h3Resolution,
    memoryUsageEstimate: `${memoryMB} MB`,
  };
}

/**
 * Check if spatial index is ready
 */
export function isSpatialIndexReady(): boolean {
  return isInitialized;
}

/**
 * Get city index (for debugging)
 */
export function getCityIndex(cityId: CityId): CityIndex | null {
  return spatialRegistry[cityId] || null;
}


/**
 * Get bounding box for a neighborhood feature
 */
export function getNeighborhoodBoundsFromFeature(feature: GeoJSON.Feature): { minLat: number; maxLat: number; minLon: number; maxLon: number } | null {
  if (!feature || !feature.geometry) {
    return null;
  }

  let minLat = Infinity;
  let maxLat = -Infinity;
  let minLon = Infinity;
  let maxLon = -Infinity;

  const processCoordinates = (coords: number[] | number[][]) => {
    if (typeof coords[0] === 'number') {
      // Single coordinate pair [lon, lat]
      const [lon, lat] = coords as number[];
      minLon = Math.min(minLon, lon);
      maxLon = Math.max(maxLon, lon);
      minLat = Math.min(minLat, lat);
      maxLat = Math.max(maxLat, lat);
    } else {
      // Array of coordinates
      (coords as number[][]).forEach(processCoordinates);
    }
  };

  try {
    if (feature.geometry.type === 'Polygon') {
      feature.geometry.coordinates.forEach(processCoordinates);
    } else if (feature.geometry.type === 'MultiPolygon') {
      feature.geometry.coordinates.forEach((polygon) => {
        polygon.forEach(processCoordinates);
      });
    }

    if (minLat === Infinity || maxLat === -Infinity || minLon === Infinity || maxLon === -Infinity) {
      return null;
    }

    return { minLat, maxLat, minLon, maxLon };
  } catch (error) {
    console.error('Error calculating bounds:', error);
    return null;
  }
}
