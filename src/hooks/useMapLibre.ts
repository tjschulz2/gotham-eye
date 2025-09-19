"use client";

import { useEffect, useRef } from "react";
import type { Map as MapLibreMap } from "maplibre-gl";

interface UseMapLibreProps {
  containerRef: React.RefObject<HTMLDivElement | null>;
  onMapLoad: (map: MapLibreMap) => void;
  center?: [number, number];
  zoom?: number;
}

export function useMapLibre({ 
  containerRef, 
  onMapLoad, 
  center = [-73.99, 40.7328], 
  zoom = 12.5 
}: UseMapLibreProps) {
  const onMapLoadRef = useRef(onMapLoad);
  const mapRef = useRef<MapLibreMap | null>(null);
  onMapLoadRef.current = onMapLoad;

  useEffect(() => {
    let map: MapLibreMap;
    let cancelled = false;

    const initializeMap = async () => {
      try {
        // Prevent multiple initializations
        if (mapRef.current || !containerRef.current || cancelled) return;
        
        const maplibregl = (await import("maplibre-gl")).default;

        map = new maplibregl.Map({
          container: containerRef.current,
          style: {
            version: 8,
            sources: {
              'carto-dark': {
                type: 'raster',
                tiles: [
                  'https://a.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}@2x.png',
                  'https://b.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}@2x.png',
                  'https://c.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}@2x.png',
                  'https://d.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}@2x.png'
                ],
                tileSize: 256,
                attribution: '© <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors © <a href="https://carto.com/attributions">CARTO</a>'
              }
            },
            layers: [
              {
                id: 'carto-dark-layer',
                type: 'raster',
                source: 'carto-dark'
              }
            ],
            glyphs: 'https://demotiles.maplibre.org/font/{fontstack}/{range}.pbf'
          },
          center,
          zoom,
        });

        // Store map reference
        mapRef.current = map;

        // Wait for map to load before adding controls and notifying
        map.on('load', () => {
          console.log('Map loaded successfully');
          // Add navigation controls
          map.addControl(new maplibregl.NavigationControl({ visualizePitch: true }));
          
          // Notify parent component
          onMapLoadRef.current(map);
        });

        map.on('error', (e) => {
          console.error('Map error:', e);
        });
      } catch (error) {
        console.error('Failed to initialize MapLibre:', error);
      }
    };

    initializeMap();

    return () => {
      cancelled = true;
      if (mapRef.current) {
        mapRef.current.remove();
        mapRef.current = null;
      }
    };
  }, []); // Only run once on mount
}
