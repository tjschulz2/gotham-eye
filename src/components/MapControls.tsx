"use client";

import FilterControls from "./FilterControls";
import SearchButton from "./SearchButton";
import type { CityId } from "@/lib/city-config";
import type { CrimeType } from "@/types/crime";
import type { FiltersResponse } from "@/types/api";
import type { Map as MapLibreMap } from 'maplibre-gl';
import type { Stats } from "@/hooks/useDataState";

interface MapControlsProps {
  // UI state
  isMobile: boolean;
  viewportWidth: number;
  filtersOpen: boolean;
  setFiltersOpen: (open: boolean | ((prev: boolean) => boolean)) => void;
  cityDropdownOpen: boolean;
  setCityDropdownOpen: (open: boolean | ((prev: boolean) => boolean)) => void;
  
  // Filter state
  activeFilterCount: number;
  availableYears: number[];
  startYear: number;
  endYear: number;
  setStartYear: (year: number) => void;
  setEndYear: (year: number) => void;
  setFiltersVersion: (version: number | ((prev: number) => number)) => void;
  
  // Crime data
  crimeTypes: CrimeType[];
  selectedOfns: string[];
  violentOn: boolean;
  nonviolentOn: boolean;
  effectiveSelectedOfns: string[];
  
  // API Data
  filtersData: FiltersResponse | null;
  filtersLoading: boolean;
  filtersError: string | null;
  
  // Actions
  toggleCategory: (category: "violent" | "nonviolent") => void;
  toggleOffense: (label: string, categoryOn: boolean) => void;
  clearAllFilters: () => void;
  
  // City config
  city: CityId;
  cityConfig: {
    displayName: string;
    hasDemographics: boolean;
    dataSources: string[];
  };
  setCity: (city: CityId) => void;
  
  // Map actions
  mapRef: MapLibreMap | null;
  setStats: (stats: Stats | null) => void;
  setAggData: (data: unknown) => void;}

export default function MapControls({
  isMobile,
  viewportWidth,
  filtersOpen,
  setFiltersOpen,
  cityDropdownOpen,
  setCityDropdownOpen,
  activeFilterCount,
  availableYears,
  startYear,
  endYear,
  setStartYear,
  setEndYear,
  setFiltersVersion,
  crimeTypes,
  selectedOfns,
  violentOn,
  nonviolentOn,
  effectiveSelectedOfns,
  filtersData,
  filtersLoading,
  filtersError,
  toggleCategory,
  toggleOffense,
  clearAllFilters,
  city,
  cityConfig,
  setCity,
  mapRef,
  setStats,
  setAggData,
}: MapControlsProps) {
  return (
    <div
      style={{
        position: "absolute",
        top: 12,
        left: isMobile ? 12 : "50%",
        transform: isMobile ? undefined : "translateX(-50%)",
        zIndex: 10,
        fontFamily: "system-ui, -apple-system, Segoe UI, Roboto, sans-serif",
      }}
    >
      {/* Top row container (leave ~96px on the right for MapLibre controls) */}
      <div 
        style={{ 
          display: "flex", 
          alignItems: "center", 
          gap: 8, 
          width: (isMobile
            ? Math.min(640, Math.max(200, viewportWidth - 24 - 96))
            : Math.min(308, Math.max(240, viewportWidth - 24 - 96 - 400))) 
        }}
      >
        <FilterControls
          filtersOpen={filtersOpen}
          setFiltersOpen={setFiltersOpen}
          activeFilterCount={activeFilterCount}
          availableYears={availableYears}
          startYear={startYear}
          endYear={endYear}
          setStartYear={setStartYear}
          setEndYear={setEndYear}
          setFiltersVersion={setFiltersVersion}
          crimeTypes={crimeTypes}
          selectedOfns={selectedOfns}
          violentOn={violentOn}
          nonviolentOn={nonviolentOn}
          effectiveSelectedOfns={effectiveSelectedOfns}
          filtersData={filtersData}
          filtersLoading={filtersLoading}
          filtersError={filtersError}
          toggleCategory={toggleCategory}
          toggleOffense={toggleOffense}
          clearAllFilters={clearAllFilters}
          isMobile={isMobile}
          viewportWidth={viewportWidth}
          mapRef={mapRef}
          setStats={setStats}
          setAggData={setAggData}
        />

        <SearchButton
          city={city}
          cityConfig={cityConfig}
          cityDropdownOpen={cityDropdownOpen}
          setCityDropdownOpen={setCityDropdownOpen}
          setCity={setCity}
        />
      </div>
    </div>
  );
}
