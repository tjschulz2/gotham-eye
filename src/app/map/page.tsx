"use client";

import { useEffect, useCallback, useRef, useMemo } from "react";
import { useMapState } from "@/hooks/useMapState";
import { useUIState } from "@/hooks/useUIState";
import { useDataState } from "@/hooks/useDataState";
import { useMapLibre } from "@/hooks/useMapLibre";
import { useApiData } from "@/hooks/useApiData";
import { initializeDummyData } from "@/data/dummyData";
import { 
  transformStatsResponse, 
  transformTimeSeriesData, 
  transformPairsData, 
  calculateTrendStats,
  isValidStatsData 
} from "@/lib/stats-transformer";
import MapControls from "@/components/MapControls";
import DesktopFilters from "@/components/DesktopFilters";
import LoadingOverlay from "@/components/LoadingOverlay";
import Legend from "@/components/Legend";
import Sidebar from "@/components/Sidebar";
import NeighborhoodsManager from "@/components/NeighborhoodsManager";
import { ErrorBoundary } from "@/components/ErrorBoundary";

export default function MapPage() {
  // Custom hooks for state management
  const mapState = useMapState();
  const uiState = useUIState();
  
  // Create data state and API data
  const dataState = useDataState();
  const apiData = useApiData(dataState.queryParams);
  
  // Update dataState with filters data when available
  useEffect(() => {
    if (apiData.data.filters) {
      dataState.setFiltersData(apiData.data.filters);
    }
  }, [apiData.data.filters]);
  
  // Debug query params
  console.log('[MapPage] Query params:', dataState.queryParams);
  
  // Track if this is the initial load to prevent unnecessary flyTo animation
  const isInitialLoad = useRef(true);

  // Initialize MapLibre
  useMapLibre({
    containerRef: mapState.containerRef,
    onMapLoad: mapState.setMapRef,
    center: [-73.99, 40.7328],
    zoom: 12.5,
  });

  // Initialize with dummy data (temporary) - only run once
  useEffect(() => {
    initializeDummyData(dataState);
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  // Handle city changes - move map to new city center
  useEffect(() => {
    if (mapState.mapRef && dataState.cityConfig) {
      // Skip animation on initial load
      if (isInitialLoad.current) {
        isInitialLoad.current = false;
        return;
      }
      
      const { center, zoom } = dataState.cityConfig;
      mapState.mapRef.flyTo({
        center: center,
        zoom: zoom,
        duration: 5000, // 5.0 second animation
        essential: true // This animation is considered essential with respect to prefers-reduced-motion
      });
    }
  }, [dataState.city, dataState.cityConfig, mapState.mapRef]);

  // Transform API stats data for Sidebar consumption
  const transformedStats = useMemo(() => {
    console.log('[MapPage] API stats data:', apiData.data.stats?.totals);
    console.log('[MapPage] API loading state:', apiData.loading.stats);
    
    if (!apiData.data.stats) {
      console.log('[MapPage] No stats data available for transformation');
      return null;
    }
    console.log('[MapPage] Raw API stats response:', apiData.data.stats);
    console.log('[MapPage] Selected neighborhood:', dataState.selectedNeighborhood?.name);
    console.log('[MapPage] Pairs data from API:', apiData.data.stats?.demographics?.pairs?.suspVicRace?.slice(0, 2));
    const transformed = transformStatsResponse(apiData.data.stats);
    console.log('[MapPage] Transformed stats result:', transformed);
    console.log('[MapPage] Is valid stats data:', isValidStatsData(transformed));
    return transformed;
  }, [apiData.data.stats, dataState.selectedNeighborhood]);

  const transformedTimeSeries = useMemo(() => {
    if (!apiData.data.stats) return [];
    return transformTimeSeriesData(apiData.data.stats);
  }, [apiData.data.stats]);

  const transformedPairsData = useMemo(() => {
    if (!apiData.data.stats) return null;
    return transformPairsData(apiData.data.stats, dataState.pairsMode);
  }, [apiData.data.stats, dataState.pairsMode]);

  const transformedTrendStats = useMemo(() => {
    if (transformedTimeSeries.length === 0) return null;
    return calculateTrendStats(transformedTimeSeries);
  }, [transformedTimeSeries]);

  // Update dataState with transformed stats when API data changes
  useEffect(() => {
    console.log('[MapPage] useEffect triggered - transformedStats:', { 
      total: transformedStats?.total,
      ofnsTop: transformedStats?.ofnsTop?.length,
      byType: Object.keys(transformedStats?.byType || {}).length
    });
    console.log('[MapPage] isValidStatsData:', transformedStats ? isValidStatsData(transformedStats) : 'no stats');
    
    if (transformedStats && isValidStatsData(transformedStats)) {
      console.log('[MapPage] Setting stats in dataState:', { total: transformedStats.total });
      dataState.setStats(transformedStats);
    } else if (!apiData.loading.stats && !transformedStats) {
      console.log('[MapPage] Clearing stats in dataState');
      dataState.setStats(null);
    } else {
      console.log('[MapPage] Not updating stats - conditions not met:', {
        hasTransformedStats: !!transformedStats,
        isValid: transformedStats ? isValidStatsData(transformedStats) : false,
        loading: apiData.loading.stats,
        transformedStats: transformedStats
      });
    }
  }, [transformedStats, apiData.loading.stats, dataState.setStats]);

  // Update chart key for re-rendering when data changes
  useEffect(() => {
    if (transformedTimeSeries.length > 0) {
      dataState.setChartKey(`chart-${dataState.city}-${dataState.filtersVersion}`);
    }
  }, [transformedTimeSeries, dataState.city, dataState.filtersVersion, dataState.setChartKey]);

  useEffect(() => {
    if (transformedTrendStats) {
      dataState.setTrendStats(transformedTrendStats);
    }
  }, [transformedTrendStats, dataState.setTrendStats]);

  // Update pairs data
  useEffect(() => {
    if (transformedPairsData) {
      dataState.setPairsData(transformedPairsData);
    }
  }, [transformedPairsData, dataState.setPairsData]);

  // Stable callback for neighborhood selection to prevent re-renders
  const handleNeighborhoodSelect = useCallback((name: string | null, feature: any, city: string) => {
    if (name && feature) {
      console.log('[MapPage] Neighborhood selected:', {
        name,
        city,
        properties: feature.properties,
        availableKeys: Object.keys(feature.properties || {})
      });
      dataState.setSelectedNeighborhood({ name, feature });
    } else {
      console.log('[MapPage] Neighborhood cleared');
      dataState.setSelectedNeighborhood(null);
    }
  }, [dataState.setSelectedNeighborhood]);

  // Determine if loading overlay should be visible
  const showLoadingOverlay = mapState.mapShimmering || apiData.loading.stats || mapState.choroplethLoading;

  return (
    <ErrorBoundary>
      <div 
        style={{ 
          display: "flex", 
          flexDirection: uiState.isMobile ? "column" : "row", 
          width: "100vw", 
          height: uiState.isMobile ? "auto" : "100vh" 
        }}
      >
      {/* Map container */}
      <div 
        style={{ 
          flex: uiState.isMobile ? "0 0 auto" : 1, 
          position: "relative", 
          width: uiState.isMobile ? "100vw" : "auto" 
        }}
      >
        <div 
          ref={mapState.containerRef} 
          style={{ 
            width: "100%", 
            height: uiState.isMobile ? uiState.viewportWidth : "100%" 
          }} 
        />

        {/* Loading overlay */}
        <LoadingOverlay visible={showLoadingOverlay} />

        {/* Neighborhood layers */}
        <NeighborhoodsManager
          map={mapState.mapRef}
          activeCity={dataState.city}
          choroplethData={apiData.data.choropleth}
          onNeighborhoodSelect={handleNeighborhoodSelect}
        />

        {/* Desktop-only filters pinned top-left */}
        {!uiState.isMobile && (
          <DesktopFilters
            filtersOpen={uiState.filtersOpen}
            setFiltersOpen={uiState.setFiltersOpen}
            activeFilterCount={dataState.activeFilterCount}
            availableYears={dataState.availableYears}
            startYear={dataState.startYear}
            endYear={dataState.endYear}
            setStartYear={dataState.setStartYear}
            setEndYear={dataState.setEndYear}
            setFiltersVersion={dataState.setFiltersVersion}
            crimeTypes={dataState.crimeTypes}
            selectedOfns={dataState.selectedOffenses}
            violentOn={dataState.violentOn}
            nonviolentOn={dataState.nonviolentOn}
            effectiveSelectedOfns={dataState.effectiveSelectedOffenses}
            filtersData={apiData.data.filters}
            filtersLoading={apiData.loading.filters}
            filtersError={apiData.errors.filters}
            toggleCategory={dataState.toggleCategory}
            toggleOffense={dataState.toggleOffense}
            clearAllFilters={dataState.clearAllFilters}
            viewportWidth={uiState.viewportWidth}
            mapRef={mapState.mapRef}
            setStats={dataState.setStats}
            setAggData={dataState.setAggData}
          />
        )}

        {/* Top controls: Filters (left on mobile) + Search (flex), centered on desktop */}
        <MapControls
          isMobile={uiState.isMobile}
          viewportWidth={uiState.viewportWidth}
          filtersOpen={uiState.filtersOpen}
          setFiltersOpen={uiState.setFiltersOpen}
          cityDropdownOpen={uiState.cityDropdownOpen}
          setCityDropdownOpen={uiState.setCityDropdownOpen}
          activeFilterCount={dataState.activeFilterCount}
          availableYears={dataState.availableYears}
          startYear={dataState.startYear}
          endYear={dataState.endYear}
          setStartYear={dataState.setStartYear}
          setEndYear={dataState.setEndYear}
          setFiltersVersion={dataState.setFiltersVersion}
          crimeTypes={dataState.crimeTypes}
          selectedOfns={dataState.selectedOffenses}
          violentOn={dataState.violentOn}
          nonviolentOn={dataState.nonviolentOn}
          effectiveSelectedOfns={dataState.effectiveSelectedOffenses}
          filtersData={apiData.data.filters}
          filtersLoading={apiData.loading.filters}
          filtersError={apiData.errors.filters}
          toggleCategory={dataState.toggleCategory}
          toggleOffense={dataState.toggleOffense}
          clearAllFilters={dataState.clearAllFilters}
          city={dataState.city}
          cityConfig={dataState.cityConfig}
          setCity={dataState.setCity}
          mapRef={mapState.mapRef}
          setStats={dataState.setStats}
          setAggData={dataState.setAggData}
        />

        {/* Legend */}
        <Legend
          isMobile={uiState.isMobile}
          viewportWidth={uiState.viewportWidth}
        />
      </div>

      {/* Sidebar */}
      <Sidebar
        isMobile={uiState.isMobile}
        viewportWidth={uiState.viewportWidth}
        noDataMode={uiState.noDataMode}
        statsLoading={apiData.loading.stats}
        stats={dataState.stats}
        selectedNeighborhood={dataState.selectedNeighborhood}
        mapShimmering={mapState.mapShimmering}
        rotatorResetKey={dataState.rotatorResetKey}
        city={dataState.city}
        cityConfig={dataState.cityConfig}
        includeUnknown={uiState.includeUnknown}
        setIncludeUnknown={uiState.setIncludeUnknown}
        pairsData={dataState.pairsData}
        pairsLocalLoading={apiData.loading.stats}
        pairsMode={dataState.pairsMode}
        onChangePairsMode={dataState.onChangePairsMode}
        chartSeries={transformedTimeSeries}
        chartKey={dataState.chartKey}
        trendStats={dataState.trendStats}
      />
      </div>
    </ErrorBoundary>
  );
}
