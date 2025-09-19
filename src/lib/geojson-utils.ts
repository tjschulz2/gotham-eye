import type { 
  NeighborhoodCollection, 
  NeighborhoodFeature, 
  NeighborhoodProperties,
  LabelCollection,
  LabelFeature 
} from '@/types/geojson';

/**
 * Determines the best label field to use for a neighborhood feature
 */
export function guessLabelField(properties: NeighborhoodProperties | null | undefined): string {
  if (!properties || typeof properties !== "object") return "name";
  
  const candidates = [
    "ntaname", "nta_name", "name", "neighborhood", "label", 
    "ntaname2020", "ntaname_2020", "analysis_neighborhood", 
    "district", "nta", "nta_name_2025", "nta2025"
  ];
  
  for (const candidate of candidates) {
    const hit = Object.keys(properties).find(k => k.toLowerCase() === candidate);
    if (hit) return hit;
  }
  
  return "name";
}

/**
 * Calculates the centroid of a polygon ring using the shoelace formula
 */
function centroidOfRing(ring: number[][]): [number, number] {
  if (!Array.isArray(ring) || ring.length < 3) return [0, 0];
  
  let area = 0;
  let cx = 0;
  let cy = 0;
  
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [x1, y1] = ring[j];
    const [x2, y2] = ring[i];
    const crossProduct = (x1 * y2 - x2 * y1);
    area += crossProduct;
    cx += (x1 + x2) * crossProduct;
    cy += (y1 + y2) * crossProduct;
  }
  
  if (area === 0) {
    // Fallback to simple average
    let sumX = 0;
    let sumY = 0;
    for (const [x, y] of ring) {
      sumX += x;
      sumY += y;
    }
    return [sumX / ring.length, sumY / ring.length];
  }
  
  area *= 0.5;
  cx /= (6 * area);
  cy /= (6 * area);
  
  return [cx, cy];
}

/**
 * Chooses the largest polygon from a MultiPolygon for centroid calculation
 */
function chooseLargestPolygon(coordinates: number[][][][]): number[][] | null {
  let bestRing = null;
  let maxArea = -Infinity;
  
  for (const polygon of coordinates) {
    const ring = polygon?.[0]; // Exterior ring
    if (!ring) continue;
    
    // Calculate approximate area using shoelace formula
    let area = 0;
    for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
      const [x1, y1] = ring[j];
      const [x2, y2] = ring[i];
      area += (x1 * y2 - x2 * y1);
    }
    area = Math.abs(area) * 0.5;
    
    if (area > maxArea) {
      maxArea = area;
      bestRing = ring;
    }
  }
  
  return bestRing;
}

/**
 * Generates point features at polygon centroids for label placement
 */
export function generateCentroids(
  collection: NeighborhoodCollection, 
  labelField: string
): LabelCollection {
  const features: LabelFeature[] = [];
  
  for (const feature of collection.features) {
    const geometry = feature.geometry;
    if (!geometry) continue;
    
    let centroid: [number, number] | null = null;
    
    if (geometry.type === 'Polygon') {
      const ring = geometry.coordinates[0];
      if (ring) {
        centroid = centroidOfRing(ring);
      }
    } else if (geometry.type === 'MultiPolygon') {
      const largestRing = chooseLargestPolygon(geometry.coordinates);
      if (largestRing) {
        centroid = centroidOfRing(largestRing);
      }
    }
    
    if (centroid) {
      const label = String(feature.properties?.[labelField] || '');
      features.push({
        type: 'Feature',
        properties: { label },
        geometry: {
          type: 'Point',
          coordinates: centroid
        }
      });
    }
  }
  
  return {
    type: 'FeatureCollection',
    features
  };
}

/**
 * Converts polygon features to line features for outline rendering
 */
export function convertToLineFeatures(
  collection: NeighborhoodCollection,
  labelField: string
): LabelCollection {
  const features: any[] = [];
  
  const pushRing = (ring: number[][], properties: NeighborhoodProperties) => {
    if (Array.isArray(ring) && ring.length >= 2 && typeof ring[0]?.[0] === 'number') {
      const lineProps: any = {};
      lineProps[labelField] = String(properties?.[labelField] || "");
      
      features.push({
        type: "Feature",
        properties: lineProps,
        geometry: {
          type: "LineString",
          coordinates: ring
        }
      });
    }
  };
  
  for (const feature of collection.features) {
    const geometry = feature.geometry;
    const properties = feature.properties || {};
    
    if (!geometry) continue;
    
    if (geometry.type === 'Polygon') {
      for (const ring of geometry.coordinates) {
        pushRing(ring, properties);
      }
    } else if (geometry.type === 'MultiPolygon') {
      for (const polygon of geometry.coordinates) {
        for (const ring of polygon) {
          pushRing(ring, properties);
        }
      }
    }
  }
  
  return {
    type: 'FeatureCollection',
    features
  };
}

/**
 * Adds shimmer band indices to features for wave animation
 */
export function addShimmerBands(collection: NeighborhoodCollection): NeighborhoodCollection {
  return {
    ...collection,
    features: collection.features.map((feature, index) => ({
      ...feature,
      properties: {
        ...feature.properties,
        __band: index % 3
      }
    }))
  };
}

/**
 * Loads and parses a GeoJSON file from the public directory
 */
export async function loadNeighborhoodGeoJSON(path: string): Promise<NeighborhoodCollection> {
  const response = await fetch(path, { cache: "force-cache" });
  
  if (!response.ok) {
    throw new Error(`Failed to load GeoJSON: ${response.status}`);
  }
  
  const data = await response.json();
  
  // Basic validation
  if (!data || data.type !== 'FeatureCollection' || !Array.isArray(data.features)) {
    throw new Error('Invalid GeoJSON format');
  }
  
  return data as NeighborhoodCollection;
}
