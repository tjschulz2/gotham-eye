import { useMemo, useCallback } from 'react';
import type { Map as MapLibreMap } from 'maplibre-gl';
import NeighborhoodLayer from './NeighborhoodLayer';
import type { NeighborhoodLayerConfig, NeighborhoodFeature, ChoroplethData } from '@/types/geojson';
import type { CityId } from '@/lib/city-config';

interface NeighborhoodsManagerProps {
  map: MapLibreMap | null;
  activeCity: CityId;
  choroplethData?: ChoroplethData | null;
  onNeighborhoodSelect?: (name: string | null, feature: NeighborhoodFeature | null, city: CityId) => void;
}

export default function NeighborhoodsManager({ 
  map, 
  activeCity, 
  choroplethData,
  onNeighborhoodSelect 
}: NeighborhoodsManagerProps) {
  
  // Stable callback functions to prevent config recreation
  const handleNycClick = useCallback((name: string, feature: NeighborhoodFeature) => {
    onNeighborhoodSelect?.(name, feature, 'nyc');
  }, [onNeighborhoodSelect]);

  const handleNycClear = useCallback(() => {
    onNeighborhoodSelect?.(null, null, 'nyc');
  }, [onNeighborhoodSelect]);

  const handleSfClick = useCallback((name: string, feature: NeighborhoodFeature) => {
    onNeighborhoodSelect?.(name, feature, 'sf');
  }, [onNeighborhoodSelect]);

  const handleSfClear = useCallback(() => {
    onNeighborhoodSelect?.(null, null, 'sf');
  }, [onNeighborhoodSelect]);
  
  const nycConfig: NeighborhoodLayerConfig = useMemo(() => ({
    city: 'nyc',
    geojsonPath: '/nyc_nta_2020.geojson',
    labelField: 'ntaname',
    choroplethData: activeCity === 'nyc' ? choroplethData : null,
    onNeighborhoodClick: handleNycClick,
    onNeighborhoodClear: handleNycClear
  }), [handleNycClick, handleNycClear, activeCity, choroplethData]);

  const sfConfig: NeighborhoodLayerConfig = useMemo(() => ({
    city: 'sf',
    geojsonPath: '/sf_nta_2025.geojson',
    labelField: 'analysis_neighborhood',
    choroplethData: activeCity === 'sf' ? choroplethData : null,
    onNeighborhoodClick: handleSfClick,
    onNeighborhoodClear: handleSfClear
  }), [handleSfClick, handleSfClear, activeCity, choroplethData]);

  // Use the config for the active city
  const activeConfig = activeCity === 'nyc' ? nycConfig : sfConfig;

  return (
    <NeighborhoodLayer
      key={`neighborhoods-${activeCity}`} // Key changes with city to force re-initialization
      map={map}
      config={activeConfig}
    />
  );
}
