"use client";

import { useState, useRef, useCallback } from "react";
import type { Map as MapLibreMap } from "maplibre-gl";

export interface MapState {
  mapRef: MapLibreMap | null;
  mapShimmering: boolean;
  choroplethLoading: boolean;
  neighborhoodsLoaded: boolean;
}

export interface MapActions {
  setMapRef: (map: MapLibreMap | null) => void;
  setMapShimmering: (loading: boolean) => void;
  setChoroplethLoading: (loading: boolean) => void;
  setNeighborhoodsLoaded: (loaded: boolean) => void;
}

export function useMapState() {
  const containerRef = useRef<HTMLDivElement>(null);
  const [mapRef, setMapRef] = useState<MapLibreMap | null>(null);
  const [mapShimmering, setMapShimmering] = useState<boolean>(false);
  const [choroplethLoading, setChoroplethLoading] = useState<boolean>(false);
  const [neighborhoodsLoaded, setNeighborhoodsLoaded] = useState<boolean>(false);

  const state: MapState = {
    mapRef,
    mapShimmering,
    choroplethLoading,
    neighborhoodsLoaded,
  };

  const actions: MapActions = {
    setMapRef: useCallback((map: MapLibreMap | null) => setMapRef(map), []),
    setMapShimmering: useCallback((loading: boolean) => setMapShimmering(loading), []),
    setChoroplethLoading: useCallback((loading: boolean) => setChoroplethLoading(loading), []),
    setNeighborhoodsLoaded: useCallback((loaded: boolean) => setNeighborhoodsLoaded(loaded), []),
  };

  return {
    containerRef,
    ...state,
    ...actions,
  };
}
