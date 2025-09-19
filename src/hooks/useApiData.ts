"use client";

import { useState, useEffect, useCallback, useRef } from "react";
import { dataService } from "@/services/dataService";
import type { 
  NormalizedQueryParams, 
  FiltersResponse, 
  ChoroplethResponse, 
  StatsResponse 
} from "@/types/api";

// Loading states for each endpoint
export interface ApiLoadingState {
  filters: boolean;
  choropleth: boolean;
  stats: boolean;
}

// Error states for each endpoint
export interface ApiErrorState {
  filters: string | null;
  choropleth: string | null;
  stats: string | null;
}

// Data states for each endpoint
export interface ApiDataState {
  filters: FiltersResponse | null;
  choropleth: ChoroplethResponse | null;
  stats: StatsResponse | null;
}

// Hook for managing all API data fetching
export function useApiData(queryParams: NormalizedQueryParams) {
  const [loading, setLoading] = useState<ApiLoadingState>({
    filters: false,
    choropleth: false,
    stats: false,
  });

  const [errors, setErrors] = useState<ApiErrorState>({
    filters: null,
    choropleth: null,
    stats: null,
  });

  const [data, setData] = useState<ApiDataState>({
    filters: null,
    choropleth: null,
    stats: null,
  });

  // Track current request to prevent race conditions
  const currentRequestRef = useRef<string>("");

  // Generate request ID for deduplication
  const getRequestId = useCallback((params: NormalizedQueryParams): string => {
    return `${params.city}-${params.from}-${params.to}-${[...params.offenses].sort().join(',')}-${[...params.lawClass].sort().join(',')}-${params.selectedNeighborhood || ''}`;
  }, []);

  // Fetch all data in parallel
  const fetchAllData = useCallback(async (params: NormalizedQueryParams) => {
    const requestId = getRequestId(params);
    currentRequestRef.current = requestId;

    console.log(`[useApiData] 🚀 Starting fetchAllData for: ${params.city}, neighborhood: ${params.selectedNeighborhood || 'none'}, requestId: ${requestId}`);

    // Reset loading states
    setLoading({
      filters: true,
      choropleth: true,
      stats: true,
    });

    // Clear previous errors
    setErrors({
      filters: null,
      choropleth: null,
      stats: null,
    });

    try {
      // Fetch all endpoints in parallel
      const [filtersResult, choroplethResult, statsResult] = await Promise.allSettled([
        dataService.getFilters(params),
        dataService.getChoropleth(params),
        dataService.getStats(params),
      ]);

      // Check if this request is still current (prevent race conditions)
      if (currentRequestRef.current !== requestId) {
        return;
      }

      // Process filters result
      if (filtersResult.status === 'fulfilled') {
        setData(prev => ({ ...prev, filters: filtersResult.value }));
        setErrors(prev => ({ ...prev, filters: null }));
      } else {
        setErrors(prev => ({ ...prev, filters: filtersResult.reason?.message || 'Failed to load filters' }));
      }

      // Process choropleth result
      if (choroplethResult.status === 'fulfilled') {
        console.log(`[useApiData] Choropleth loaded: ${params.city} (${choroplethResult.value.neighborhoods?.length || 0} neighborhoods)`);
        setData(prev => ({ ...prev, choropleth: choroplethResult.value }));
        setErrors(prev => ({ ...prev, choropleth: null }));
      } else {
        console.error('[useApiData] Choropleth error:', choroplethResult.reason);
        setErrors(prev => ({ ...prev, choropleth: choroplethResult.reason?.message || 'Failed to load choropleth data' }));
      }

      // Process stats result
      if (statsResult.status === 'fulfilled') {
        console.log(`[useApiData] Stats loaded: ${params.city} (${statsResult.value.totals?.events || 0} total events)`);
        console.log(`[useApiData] Stats result for neighborhood: ${params.selectedNeighborhood || 'none'}`);
        console.log(`[useApiData] Setting stats data:`, { 
          events: statsResult.value.totals?.events,
          byOffense: statsResult.value.byOffense?.length || 0,
          timeSeries: statsResult.value.timeSeries?.length || 0,
          demographics: !!statsResult.value.demographics
        });
        setData(prev => ({ ...prev, stats: statsResult.value }));
        setErrors(prev => ({ ...prev, stats: null }));
      } else {
        console.error('[useApiData] Stats error:', statsResult.reason);
        setErrors(prev => ({ ...prev, stats: statsResult.reason?.message || 'Failed to load stats' }));
      }

    } catch (error) {
      // This shouldn't happen with Promise.allSettled, but just in case
      console.error('Unexpected error in fetchAllData:', error);
    } finally {
      // Update loading states
      setLoading({
        filters: false,
        choropleth: false,
        stats: false,
      });
    }
  }, [getRequestId]);

  // Fetch individual endpoints (for selective updates)
  const fetchFilters = useCallback(async (params: NormalizedQueryParams) => {
    setLoading(prev => ({ ...prev, filters: true }));
    setErrors(prev => ({ ...prev, filters: null }));

    try {
      const result = await dataService.getFilters(params);
      setData(prev => ({ ...prev, filters: result }));
    } catch (error: unknown) {
      setErrors(prev => ({ ...prev, filters: error instanceof Error ? error.message : 'Failed to load filters' }));
    } finally {
      setLoading(prev => ({ ...prev, filters: false }));
    }
  }, []);

  const fetchChoropleth = useCallback(async (params: NormalizedQueryParams) => {
    // Don't fetch choropleth if offenses array is empty and showNoResults is not set (filters not ready yet)
    if (params.offenses.length === 0 && !params.showNoResults) {
      console.log('[useApiData] Choropleth: Offenses empty and showNoResults not set - filters not ready yet, skipping fetch');
      return;
    }

    setLoading(prev => ({ ...prev, choropleth: true }));
    setErrors(prev => ({ ...prev, choropleth: null }));

    try {
      const result = await dataService.getChoropleth(params);
      setData(prev => ({ ...prev, choropleth: result }));
    } catch (error: unknown) {
      setErrors(prev => ({ ...prev, choropleth: error instanceof Error ? error.message : 'Failed to load choropleth data' }));
    } finally {
      setLoading(prev => ({ ...prev, choropleth: false }));
    }
  }, []);

  const fetchStats = useCallback(async (params: NormalizedQueryParams) => {
    // Don't fetch stats if offenses array is empty and showNoResults is not set (filters not ready yet)
    if (params.offenses.length === 0 && !params.showNoResults) {
      console.log('[useApiData] Stats: Offenses empty and showNoResults not set - filters not ready yet, skipping fetch');
      return;
    }

    setLoading(prev => ({ ...prev, stats: true }));
    setErrors(prev => ({ ...prev, stats: null }));

    try {
      const result = await dataService.getStats(params);
      setData(prev => ({ ...prev, stats: result }));
    } catch (error: unknown) {
      setErrors(prev => ({ ...prev, stats: error instanceof Error ? error.message : 'Failed to load stats' }));
    } finally {
      setLoading(prev => ({ ...prev, stats: false }));
    }
  }, []);

  // Auto-fetch when query params change
  useEffect(() => {
    const requestId = getRequestId(queryParams);
    
    // Skip if this is the same request we're already processing
    if (currentRequestRef.current === requestId) {
      return;
    }
    
    // Log city changes
    const currentCity = currentRequestRef.current?.split('-')[0];
    const newCity = queryParams.city;
    
    if (currentCity && currentCity !== newCity) {
      console.log(`[useApiData] City changed: ${currentCity} → ${newCity}`);
    }
    
    fetchAllData(queryParams);
  }, [queryParams]); // Remove fetchAllData from dependencies

  // Computed loading states
  const isLoading = loading.filters || loading.choropleth || loading.stats;
  const hasErrors = !!(errors.filters || errors.choropleth || errors.stats);
  const hasData = !!(data.filters || data.choropleth || data.stats);

  return {
    // Data
    data,
    
    // Loading states
    loading,
    isLoading,
    
    // Error states
    errors,
    hasErrors,
    
    // Status
    hasData,
    
    // Manual fetch functions
    fetchAllData: () => fetchAllData(queryParams),
    fetchFilters: () => fetchFilters(queryParams),
    fetchChoropleth: () => fetchChoropleth(queryParams),
    fetchStats: () => fetchStats(queryParams),
    
    // Utility
    clearCache: dataService.clearCache,
  };
}