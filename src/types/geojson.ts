export interface NeighborhoodProperties {
  // Common properties that both NYC and SF might have
  [key: string]: unknown;
  
  // Specific fields we'll look for
  name?: string;
  label?: string;
  
  // NYC specific
  ntaname?: string;
  ntaname2020?: string;
  
  // SF specific
  analysis_neighborhood?: string;
  district?: string;
  nta?: string;
  nta_name?: string;
  nta2025?: string;
  
  // For internal use (shimmer effect)
  __band?: number;
}

export interface NeighborhoodFeature {
  type: 'Feature';
  properties: NeighborhoodProperties;
  geometry: {
    type: 'Polygon';
    coordinates: number[][][];
  } | {
    type: 'MultiPolygon';
    coordinates: number[][][][];
  };
}

export interface NeighborhoodCollection {
  type: 'FeatureCollection';
  features: NeighborhoodFeature[];
}

export interface LabelFeature {
  type: 'Feature';
  properties: {
    label: string;
  };
  geometry: {
    type: 'Point';
    coordinates: [number, number];
  };
}

export interface LabelCollection {
  type: 'FeatureCollection';
  features: LabelFeature[];
}

export interface ChoroplethData {
  neighborhoods: Array<{
    regionId: string;
    count: number;
  }>;
  scale: {
    min: number;
    max: number;
    p50: number;
    p90: number;
    p99: number;
  };
}

export interface NeighborhoodLayerConfig {
  city: 'nyc' | 'sf';
  geojsonPath: string;
  labelField: string;
  choroplethData?: ChoroplethData | null;
  onNeighborhoodClick?: (name: string, feature: NeighborhoodFeature) => void;
  onNeighborhoodClear?: () => void;
}
