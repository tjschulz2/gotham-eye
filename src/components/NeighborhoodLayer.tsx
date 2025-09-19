import { useEffect, useRef, useCallback, useMemo, useState } from 'react';
import type { Map as MapLibreMap } from 'maplibre-gl';
import type { 
  NeighborhoodLayerConfig, 
  NeighborhoodFeature 
} from '@/types/geojson';
import {
  loadNeighborhoodGeoJSON,
  guessLabelField,
  generateCentroids,
  convertToLineFeatures,
  addShimmerBands
} from '@/lib/geojson-utils';
import { createChoroplethExpression } from '@/lib/choropleth-colors';

interface NeighborhoodLayerProps {
  map: MapLibreMap | null;
  config: NeighborhoodLayerConfig;
}

export default function NeighborhoodLayer({ map, config }: NeighborhoodLayerProps) {
  const currentSelectedRef = useRef<string | null>(null);
  const labelFieldRef = useRef<string>('name');
  const isInitializedRef = useRef<boolean>(false);
  const [initialized, setInitialized] = useState<boolean>(false);
  
  // Debug component lifecycle
  useEffect(() => {
    console.log(`[NeighborhoodLayer] ${config.city} component mounted`);
    return () => {
      console.log(`[NeighborhoodLayer] ${config.city} component unmounting`);
    };
  }, [config.city]);
  
  // Extract stable values from config to avoid dependency issues
  const city = config.city;
  const geojsonPath = config.geojsonPath;
  const labelField = config.labelField;
  const choroplethData = config.choroplethData;
  
  // Store callbacks in refs to avoid dependency issues
  const onNeighborhoodClickRef = useRef(config.onNeighborhoodClick);
  const onNeighborhoodClearRef = useRef(config.onNeighborhoodClear);
  
  // Update refs when callbacks change
  onNeighborhoodClickRef.current = config.onNeighborhoodClick;
  onNeighborhoodClearRef.current = config.onNeighborhoodClear;
  
  // Generate unique layer IDs based on city (memoized to prevent recreation)
  const layerIds = useMemo(() => ({
    fill: `neighborhoods-fill-${city}`,
    outline: `neighborhoods-outline-${city}`,
    labels: `neighborhoods-labels-${city}`,
    labelsSelected: `neighborhoods-labels-selected-${city}`,
    selected: `neighborhoods-selected-${city}`
  }), [city]);
  
  const sourceIds = useMemo(() => ({
    fill: `neighborhoods-source-${city}`,
    outline: `neighborhoods-outline-source-${city}`,
    labels: `neighborhoods-labels-source-${city}`
  }), [city]);

  const isGeoJSONSource = (source: unknown): source is maplibregl.GeoJSONSource => {
    return !!(source && 
             typeof source === 'object' && 
             source !== null && 
             'setData' in source && 
             typeof (source as Record<string, unknown>).setData === 'function');
  };

  // Helper function to get the region ID field based on city
  const getRegionIdField = (city: 'nyc' | 'sf'): string => {
    return city === 'nyc' ? 'NTA2020' : 'name';
  };

  const setupLayers = useCallback(async () => {
    if (!map) return;
    
    // Reset initialization flag when setting up layers
    isInitializedRef.current = false;
    setInitialized(false);
    console.log(`[NeighborhoodLayer] ${city} setting up layers`);
    
    // Check if layers already exist (e.g., from hot reload in development)
    const layerExists = map.getLayer(layerIds.fill);
    
    if (layerExists && isInitializedRef.current) {
      console.log(`[NeighborhoodLayer] ${city} already initialized, skipping`);
      return;
    }
    
    // If layer exists but we're not marked as initialized, clean up and re-initialize
    if (layerExists && !isInitializedRef.current) {
      console.log(`[NeighborhoodLayer] ${city} layer exists but not initialized, cleaning up first`);
      Object.values(layerIds).forEach(layerId => {
        try {
          if (map.getLayer(layerId)) {
            map.removeLayer(layerId);
          }
        } catch (e) {
          console.warn(`[NeighborhoodLayer] Failed to remove existing layer ${layerId}:`, e);
        }
      });
      
      Object.values(sourceIds).forEach(sourceId => {
        try {
          if (map.getSource(sourceId)) {
            map.removeSource(sourceId);
          }
        } catch (e) {
          console.warn(`[NeighborhoodLayer] Failed to remove existing source ${sourceId}:`, e);
        }
      });
    }
    
    // Reset initialization flag if we thought we were initialized but layer doesn't exist
    if (isInitializedRef.current && !layerExists) {
      console.log(`[NeighborhoodLayer] ${city} layer missing, re-initializing`);
      isInitializedRef.current = false;
    }

    try {
      console.log(`[NeighborhoodLayer] Loading ${city} neighborhoods from ${geojsonPath}`);
      
      // Load the GeoJSON data
      const geoJsonData = await loadNeighborhoodGeoJSON(geojsonPath);
      
      // Determine the label field
      const firstProps = geoJsonData.features[0]?.properties || {};
      const labelField = guessLabelField(firstProps);
      labelFieldRef.current = labelField;
      
      console.log(`[NeighborhoodLayer] ${city} loaded (${geoJsonData.features.length} features, label field: ${labelField})`);
      
      // Add shimmer bands for animation
      const dataWithBands = addShimmerBands(geoJsonData);
      
      // Setup fill source and layer
      const existingFillSource = map.getSource(sourceIds.fill);
      if (isGeoJSONSource(existingFillSource)) {
        existingFillSource.setData(dataWithBands as GeoJSON.FeatureCollection);
      } else {
        if (existingFillSource) map.removeSource(sourceIds.fill);
        map.addSource(sourceIds.fill, {
          type: 'geojson',
          data: dataWithBands as GeoJSON.FeatureCollection
        });
      }
      
      // Remove existing fill layer if present
      if (map.getLayer(layerIds.fill)) {
        map.removeLayer(layerIds.fill);
      }
      
      // Add fill layer with default colors (choropleth will be applied separately)
      map.addLayer({
        id: layerIds.fill,
        type: 'fill',
        source: sourceIds.fill,
        layout: { visibility: 'visible' },
        paint: {
          'fill-color': '#6b7280',
          'fill-opacity': 0.16,
          'fill-outline-color': '#A3A3A3'
        }
      });
      
      // Setup outline layers
      const lineFeatures = convertToLineFeatures(geoJsonData, labelField);
      
      const existingOutlineSource = map.getSource(sourceIds.outline);
      if (isGeoJSONSource(existingOutlineSource)) {
        existingOutlineSource.setData(lineFeatures as GeoJSON.FeatureCollection);
      } else {
        if (existingOutlineSource) map.removeSource(sourceIds.outline);
        map.addSource(sourceIds.outline, {
          type: 'geojson',
          data: lineFeatures as GeoJSON.FeatureCollection
        });
      }
      
      if (map.getLayer(layerIds.outline)) {
        map.removeLayer(layerIds.outline);
      }
      
      map.addLayer({
        id: layerIds.outline,
        type: 'line',
        source: sourceIds.outline,
        paint: {
          'line-color': '#FFFF00',
          'line-width': 2.5,
          'line-opacity': 0.07
        }
      });
      
      // Setup label layers
      const labelFeatures = generateCentroids(geoJsonData, labelField);
      
      const existingLabelsSource = map.getSource(sourceIds.labels);
      if (isGeoJSONSource(existingLabelsSource)) {
        existingLabelsSource.setData(labelFeatures as GeoJSON.FeatureCollection);
      } else {
        if (existingLabelsSource) map.removeSource(sourceIds.labels);
        map.addSource(sourceIds.labels, {
          type: 'geojson',
          data: labelFeatures as GeoJSON.FeatureCollection
        });
      }
      
      // Base labels layer
      if (map.getLayer(layerIds.labels)) {
        map.removeLayer(layerIds.labels);
      }
      
      map.addLayer({
        id: layerIds.labels,
        type: 'symbol',
        source: sourceIds.labels,
        minzoom: 10,
        layout: {
          'text-field': ['get', 'label'],
          'text-size': [
            'interpolate', ['linear'], ['zoom'],
            10, 10,
            12, 11,
            14, 12,
            16, 14
          ],
          'symbol-placement': 'point',
          'text-transform': 'uppercase',
          'text-padding': 2,
          'text-max-width': 12,
          'text-justify': 'center',
          'text-anchor': 'center',
          'text-allow-overlap': true,
          'text-ignore-placement': true,
          'text-optional': true
        },
        paint: {
          'text-color': '#FFFFFF',
          'text-halo-color': '#0b1220',
          'text-halo-width': 1.2,
          'text-opacity': 0.6
        }
      });
      
      // Selected labels layer (bright white)
      if (map.getLayer(layerIds.labelsSelected)) {
        map.removeLayer(layerIds.labelsSelected);
      }
      
      map.addLayer({
        id: layerIds.labelsSelected,
        type: 'symbol',
        source: sourceIds.labels,
        minzoom: 10,
        layout: {
          'text-field': ['get', 'label'],
          'text-size': [
            'interpolate', ['linear'], ['zoom'],
            10, 10,
            12, 11,
            14, 12,
            16, 14
          ],
          'symbol-placement': 'point',
          'text-transform': 'uppercase',
          'text-padding': 2,
          'text-max-width': 12,
          'text-justify': 'center',
          'text-anchor': 'center',
          'text-allow-overlap': true,
          'text-ignore-placement': true,
          'text-optional': true
        },
        paint: {
          'text-color': '#FFFFFF',
          'text-halo-color': '#0b1220',
          'text-halo-width': 1.2,
          'text-opacity': 1.0
        },
        filter: ['==', ['get', 'label'], '__none__']
      });
      
      // Selection highlight layer
      if (map.getLayer(layerIds.selected)) {
        map.removeLayer(layerIds.selected);
      }
      
      map.addLayer({
        id: layerIds.selected,
        type: 'line',
        source: sourceIds.outline,
        layout: { visibility: 'visible' },
        paint: {
          'line-color': '#FFFFFF',
          'line-width': 4,
          'line-opacity': 0.9
        },
        filter: ['==', ['get', labelField], '__none__']
      });
      
      // Move layers to ensure proper rendering order
      try {
        map.moveLayer(layerIds.outline);
        map.moveLayer(layerIds.fill);
        map.moveLayer(layerIds.labels);
        map.moveLayer(layerIds.labelsSelected);
      } catch (e) {
        console.warn('[NeighborhoodLayer] Layer ordering failed:', e);
      }
      
      // Mark as initialized
      isInitializedRef.current = true;
      setInitialized(true);
      console.log(`[NeighborhoodLayer] ${city} marked as initialized`);
      
    } catch (error) {
      console.error(`[NeighborhoodLayer] Failed to load ${city} neighborhoods:`, error);
    }
  }, [map, city, geojsonPath, layerIds, sourceIds]);

  const setupInteractivity = useCallback(() => {
    if (!map) return;

    console.log(`[NeighborhoodLayer] ${city} setting up interactivity for layer ${layerIds.fill}`);

    const handleMouseEnter = () => {
      map.getCanvas().style.cursor = 'pointer';
    };

    const handleMouseLeave = () => {
      map.getCanvas().style.cursor = '';
    };

    const handleClick = (e: maplibregl.MapMouseEvent & { features?: GeoJSON.Feature[] }) => {
      console.log(`[NeighborhoodLayer] ${city} neighborhood clicked`, e);
      const feature = e?.features?.[0];
      if (!feature) return;

      const labelField = labelFieldRef.current;
      const name = String(feature.properties?.[labelField] || '');

      // Toggle off if clicking the same neighborhood
      if (currentSelectedRef.current === name) {
        currentSelectedRef.current = null;
        map.setFilter(layerIds.selected, ['==', ['get', labelField], '__none__']);
        map.setFilter(layerIds.labelsSelected, ['==', ['get', 'label'], '__none__']);
        onNeighborhoodClearRef.current?.();
        return;
      }

      // Select new neighborhood
      currentSelectedRef.current = name;
      map.setFilter(layerIds.selected, ['==', ['get', labelField], name]);
      map.setFilter(layerIds.labelsSelected, ['==', ['get', 'label'], name]);
      
      // Ensure selected label renders on top
      try {
        map.moveLayer(layerIds.labelsSelected);
      } catch (e) {
        console.warn('[NeighborhoodLayer] Failed to move selected label layer:', e);
      }
      
      onNeighborhoodClickRef.current?.(name, feature as NeighborhoodFeature);
    };

    const handleMapClick = (e: maplibregl.MapMouseEvent & { features?: GeoJSON.Feature[] }) => {
      try {
        const hits = map.queryRenderedFeatures(e.point, { layers: [layerIds.fill] }) || [];
        if (hits.length > 0) return; // Clicked on a neighborhood, let layer handler manage
      } catch (e) {
        console.warn('[NeighborhoodLayer] Query rendered features failed:', e);
      }
      
      // Clicked outside neighborhoods, clear selection
      currentSelectedRef.current = null;
      const labelField = labelFieldRef.current;
      map.setFilter(layerIds.selected, ['==', ['get', labelField], '__none__']);
      map.setFilter(layerIds.labelsSelected, ['==', ['get', 'label'], '__none__']);
      onNeighborhoodClearRef.current?.();
    };

    // Ensure layer exists before adding event listeners
    const checkLayerAndSetupEvents = () => {
      if (!map.getLayer(layerIds.fill)) {
        console.log(`[NeighborhoodLayer] ${city} layer ${layerIds.fill} not ready, retrying...`);
        setTimeout(checkLayerAndSetupEvents, 100);
        return;
      }

      console.log(`[NeighborhoodLayer] ${city} adding event listeners to layer ${layerIds.fill}`);
      
      // Add event listeners
      map.on('mouseenter', layerIds.fill, handleMouseEnter);
      map.on('mouseleave', layerIds.fill, handleMouseLeave);
      map.on('click', layerIds.fill, handleClick);
      map.on('click', handleMapClick);
    };

    checkLayerAndSetupEvents();

    // Return cleanup function
    return () => {
      console.log(`[NeighborhoodLayer] ${city} cleaning up event listeners`);
      map.off('mouseenter', layerIds.fill, handleMouseEnter);
      map.off('mouseleave', layerIds.fill, handleMouseLeave);
      map.off('click', layerIds.fill, handleClick);
      map.off('click', handleMapClick);
    };
  }, [map, layerIds, city]);

  // Setup layers when map is ready
  useEffect(() => {
    if (!map) return;
    setupLayers();
  }, [map, setupLayers]);

  // Update choropleth colors when data changes
  useEffect(() => {
    if (!map) return;

    const updateColors = () => {
      try {
        // Wait for layer to be initialized
        if (!map.getLayer(layerIds.fill)) {
          console.log(`[NeighborhoodLayer] ${city} fill layer not ready, will retry...`);
          return false; // Indicate retry needed
        }

        const fillColor = choroplethData 
          ? createChoroplethExpression(choroplethData, getRegionIdField(city))
          : '#6b7280';
        
        const fillOpacity = choroplethData ? 0.7 : 0.16;

        // Validate expression before applying
        if (choroplethData && (!Array.isArray(fillColor) || (fillColor[0] !== 'case' && fillColor[0] !== 'literal'))) {
          console.error(`[NeighborhoodLayer] ${city} invalid choropleth expression:`, fillColor);
          return true; // Don't retry for validation errors
        }

        map.setPaintProperty(layerIds.fill, 'fill-color', fillColor);
        map.setPaintProperty(layerIds.fill, 'fill-opacity', fillOpacity);
        console.log(`[NeighborhoodLayer] ${city} choropleth colors updated`, {
          hasData: !!choroplethData,
          neighborhoodCount: choroplethData?.neighborhoods?.length || 0,
          initialized: isInitializedRef.current
        });
        return true; // Success
      } catch (error) {
        console.error(`[NeighborhoodLayer] Failed to update ${city} choropleth colors:`, error);
        return true; // Don't retry for errors
      }
    };

    // Try to update colors with retries
    const attemptUpdate = (attempt = 0) => {
      const success = updateColors();
      if (!success && attempt < 10) {
        // Retry with exponential backoff
        setTimeout(() => attemptUpdate(attempt + 1), Math.min(100 * Math.pow(1.5, attempt), 2000));
      }
    };

    attemptUpdate();
  }, [map, city, choroplethData, layerIds.fill]);

  // Setup interactivity - only after layers are initialized
  useEffect(() => {
    if (!map || !initialized) return;
    console.log(`[NeighborhoodLayer] ${city} setting up interactivity after layer initialization`);
    return setupInteractivity();
  }, [map, setupInteractivity, city, initialized]);

  // Cleanup on unmount
  useEffect(() => {
    return () => {
      if (!map) return;
      
      console.log(`[NeighborhoodLayer] ${city} cleanup starting`);
      
      // Remove layers
      Object.values(layerIds).forEach(layerId => {
        try {
          if (map.getLayer(layerId)) {
            console.log(`[NeighborhoodLayer] ${city} removing layer ${layerId}`);
            map.removeLayer(layerId);
          }
        } catch (e) {
          console.warn(`[NeighborhoodLayer] Failed to remove layer ${layerId}:`, e);
        }
      });
      
      // Remove sources
      Object.values(sourceIds).forEach(sourceId => {
        try {
          if (map.getSource(sourceId)) {
            console.log(`[NeighborhoodLayer] ${city} removing source ${sourceId}`);
            map.removeSource(sourceId);
          }
        } catch (e) {
          console.warn(`[NeighborhoodLayer] Failed to remove source ${sourceId}:`, e);
        }
      });
      
      // Reset initialization flag
      console.log(`[NeighborhoodLayer] ${city} cleanup - resetting initialized flag`);
      isInitializedRef.current = false;
      setInitialized(false);
      
      // Clear any selected state
      currentSelectedRef.current = null;
    };
  }, [map, layerIds, sourceIds, city]);

  return null; // This component doesn't render anything visible
}
