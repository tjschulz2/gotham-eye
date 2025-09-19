"use client";

import { useState, useMemo } from "react";
import { getCityConfig, type CityId } from "@/lib/city-config";
import type { CrimeType, PairsMode } from "@/types/crime";
import { QueryParamsBuilder, dateUtils, type NormalizedQueryParams, type FiltersResponse } from "@/types/api";
import { getRegionIdFromFeature } from "@/lib/choropleth-colors";

// Types

export type Stats = {
  total: number;
  byType: { [key: string]: number };
};

export type ChartSeries = {
  name: string;
  data: number[];
};

export type TrendStats = {
  avgMonthlyPct: number;
  line: any;
  trend: "up" | "down" | "stable";
  percentage: number;
};

export type SelectedNeighborhood = {
  name: string;
  feature: any;
} | null;

export interface DataState {
  // City & Config
  city: CityId;
  cityConfig: ReturnType<typeof getCityConfig>;
  
  // Time filters
  startYear: number;
  endYear: number;
  filtersVersion: number;
  
  // Crime data and filters
  crimeTypes: CrimeType[];
  selectedOffenses: string[];
  selectedLawClasses: string[];
  violentOn: boolean;
  nonviolentOn: boolean;
  
  // Statistics
  stats: Stats | null;
  selectedNeighborhood: SelectedNeighborhood;
  
  // Chart data
  rotatorResetKey: number;
  pairsData: any;
  pairsMode: PairsMode;
  chartSeries: ChartSeries[];
  chartKey: string;
  trendStats: TrendStats | null;
  aggData: any;
  
  // Computed values
  availableYears: number[];
  violentOfns: string[];
  nonviolentOfns: string[];
  effectiveSelectedOffenses: string[];
  activeFilterCount: number;
  
  // Query parameters for API calls
  queryParams: NormalizedQueryParams;
}

export interface DataActions {
  // City actions
  setCity: (city: CityId) => void;
  
  // Time actions
  setStartYear: (year: number) => void;
  setEndYear: (year: number) => void;
  setFiltersVersion: (version: number | ((prev: number) => number)) => void;
  
  // Crime data actions
  setCrimeTypes: (types: CrimeType[]) => void;
  setSelectedOffenses: (offenses: string[] | ((prev: string[]) => string[])) => void;
  setSelectedLawClasses: (lawClasses: string[] | ((prev: string[]) => string[])) => void;
  setViolentOn: (on: boolean | ((prev: boolean) => boolean)) => void;
  setNonviolentOn: (on: boolean | ((prev: boolean) => boolean)) => void;
  
  // Statistics actions
  setStats: (stats: Stats | null) => void;
  setSelectedNeighborhood: (neighborhood: SelectedNeighborhood) => void;
  
  // Chart actions
  setRotatorResetKey: (key: number | ((prev: number) => number)) => void;
  setPairsData: (data: any) => void;
  setPairsMode: (mode: PairsMode) => void;
  setChartSeries: (series: ChartSeries[]) => void;
  setChartKey: (key: string) => void;
  setTrendStats: (stats: TrendStats | null) => void;
  setAggData: (data: any) => void;
  
  // Filter actions
  toggleCategory: (category: "violent" | "nonviolent") => void;
  toggleOffense: (offense: string, currentState: boolean) => void;
  toggleLawClass: (lawClass: string) => void;
  clearAllFilters: () => void;
  onChangePairsMode: (mode: PairsMode) => void;
  setFiltersData: (data: FiltersResponse | null) => void;
}

export function useDataState() {
  // City & Config
  const [city, setCity] = useState<CityId>("nyc");
  const [cityConfig, setCityConfig] = useState(getCityConfig("nyc"));
  
  // Time filters
  const [startYear, setStartYear] = useState<number>(2022);
  const [endYear, setEndYear] = useState<number>(2025);
  const [filtersVersion, setFiltersVersion] = useState<number>(0);
  
  // Crime data and filters
  const [crimeTypes, setCrimeTypes] = useState<CrimeType[]>([]);
  const [selectedOffenses, setSelectedOffenses] = useState<string[]>([]);
  const [selectedLawClasses, setSelectedLawClasses] = useState<string[]>([]);
  const [violentOn, setViolentOn] = useState<boolean>(true);
  const [nonviolentOn, setNonviolentOn] = useState<boolean>(true);
  const [filtersData, setFiltersData] = useState<FiltersResponse | null>(null);
  
  // Statistics
  const [stats, setStats] = useState<Stats | null>(null);
  const [selectedNeighborhood, setSelectedNeighborhood] = useState<SelectedNeighborhood>(null);
  
  // Chart data
  const [rotatorResetKey, setRotatorResetKey] = useState<number>(0);
  const [pairsData, setPairsData] = useState<any>(null);
  const [pairsMode, setPairsMode] = useState<PairsMode>("both");
  const [chartSeries, setChartSeries] = useState<ChartSeries[]>([]);
  const [chartKey, setChartKey] = useState<string>("");
  const [trendStats, setTrendStats] = useState<TrendStats | null>(null);
  const [aggData, setAggData] = useState<any>(null);

  // Update city config when city changes
  const handleSetCity = (newCity: CityId) => {
    setCity(newCity);
    setCityConfig(getCityConfig(newCity));
    
    // Reset city-specific data to prevent conflicts between cities
    setCrimeTypes([]);
    setSelectedOffenses([]);
    setSelectedLawClasses([]);
    setFiltersData(null); // Clear filters data so new city's filters can load
    setStats(null);
    setSelectedNeighborhood(null);
    setChartSeries([]);
    setChartKey("");
    setTrendStats(null);
    setAggData(null);
    setPairsData(null);
    
    // Reset filters to defaults
    setViolentOn(true);
    setNonviolentOn(true);
    setFiltersVersion(v => v + 1);
    
    // Reset chart state
    setRotatorResetKey(k => k + 1);
  };

  // Computed values
  const availableYears = useMemo(() => 
    Array.from({ length: 2025 - 2022 + 1 }, (_, i) => 2022 + i), 
    [] // No dependencies - always 2022-2025
  );
  
  // Calculate violent/nonviolent offenses from API data (same logic as filter components)
  const violentOfns = useMemo(() => {
    if (!filtersData?.offenses) return [];
    return filtersData.offenses
      .map(o => o.offense)
      .filter((offense) => {
        const lower = offense.toLowerCase();
        return lower.includes("assault") || 
               lower.includes("robbery") || 
               lower.includes("rape") ||
               lower.includes("murder") ||
               lower.includes("homicide") ||
               lower.includes("shooting") ||
               lower.includes("violence") ||
               lower.includes("battery");
      });
  }, [filtersData]);

  const nonviolentOfns = useMemo(() => {
    if (!filtersData?.offenses) return [];
    const allOffenses = filtersData.offenses.map(o => o.offense);
    return allOffenses.filter((offense) => !violentOfns.includes(offense));
  }, [filtersData, violentOfns]);
  
  const effectiveSelectedOffenses = useMemo(() => {
    // If specific offenses are selected, use those
    if (selectedOffenses.length > 0) {
      console.log('[useDataState] Using specific selected offenses:', selectedOffenses);
      return selectedOffenses;
    }
    
    // If both violent and nonviolent are off, return empty (will trigger showNoResults)
    if (!violentOn && !nonviolentOn) {
      console.log('[useDataState] Both violent and nonviolent OFF - returning empty array');
      return [];
    }
    
    // If filters data isn't loaded yet, return empty array to avoid showing wrong data
    if (!filtersData?.offenses || violentOfns.length === 0 && nonviolentOfns.length === 0) {
      console.log('[useDataState] Filters data not ready yet - returning empty array');
      return [];
    }
    
    // If both are on, return all available offenses (show all crimes)
    if (violentOn && nonviolentOn) {
      const allOffenses = [...violentOfns, ...nonviolentOfns];
      console.log('[useDataState] Both violent and nonviolent ON - returning all offenses:', allOffenses.length);
      return allOffenses;
    }
    
    // If only one category is on, return just that category
    const categoryOffenses = [...(violentOn ? violentOfns : []), ...(nonviolentOn ? nonviolentOfns : [])];
    console.log('[useDataState] One category ON - returning category offenses:', {
      violentOn,
      nonviolentOn,
      violentCount: violentOfns.length,
      nonviolentCount: nonviolentOfns.length,
      resultCount: categoryOffenses.length
    });
    return categoryOffenses;
  }, [selectedOffenses, violentOn, nonviolentOn, violentOfns, nonviolentOfns, filtersData]);
  
  const activeFilterCount = useMemo(() => 
    effectiveSelectedOffenses.length + selectedLawClasses.length, 
    [effectiveSelectedOffenses, selectedLawClasses]
  );

  // Generate normalized query parameters for API calls
  const queryParams = useMemo(() => {
    const dateRange = dateUtils.yearRangeToISO(startYear, endYear);
    
    // Extract neighborhood ID from selected neighborhood feature using the same logic as choropleth
    let selectedNeighborhoodId: string | undefined = undefined;
    if (selectedNeighborhood?.feature) {
      selectedNeighborhoodId = getRegionIdFromFeature(selectedNeighborhood.feature, city) || undefined;
    }
    
    // Debug neighborhood selection
    if (selectedNeighborhood) {
      console.log('[useDataState] Selected neighborhood:', {
        name: selectedNeighborhood.name,
        city,
        properties: selectedNeighborhood.feature?.properties,
        extractedId: selectedNeighborhoodId
      });
    }
    
    const params = new QueryParamsBuilder()
      .city(city)
      .dateRange(dateRange.from, dateRange.to)
      .offenses(effectiveSelectedOffenses)
      .lawClass(selectedLawClasses)
      .selectedNeighborhood(selectedNeighborhoodId)
      .build();
    
    // Add special flag when "Clear all" is clicked (both violent and nonviolent are off AND no specific offenses selected)
    if (!violentOn && !nonviolentOn && selectedOffenses.length === 0 && filtersData?.offenses) {
      params.showNoResults = true;
      console.log('[useDataState] 🚨 CLEAR ALL MODE: Setting showNoResults=true');
    }
    
    console.log('[useDataState] Generated query params:', {
      city: params.city,
      offensesCount: params.offenses.length,
      offenses: params.offenses.slice(0, 3), // Show first 3 for brevity
      lawClassCount: params.lawClass.length,
      selectedNeighborhood: params.selectedNeighborhood,
      showNoResults: params.showNoResults
    });
    
    return params;
  }, [city, startYear, endYear, effectiveSelectedOffenses, selectedLawClasses, selectedNeighborhood, violentOn, nonviolentOn, filtersData]);

  // Filter actions
  const toggleCategory = (category: "violent" | "nonviolent") => {
    if (category === "violent") {
      setViolentOn(prev => !prev);
    } else {
      setNonviolentOn(prev => !prev);
    }
    setFiltersVersion(v => v + 1);
  };

  const toggleOffense = (offense: string, currentState: boolean) => {
    if (selectedOffenses.includes(offense)) {
      setSelectedOffenses(prev => prev.filter(o => o !== offense));
    } else {
      setSelectedOffenses(prev => [...prev, offense]);
    }
    setFiltersVersion(v => v + 1);
  };

  const toggleLawClass = (lawClass: string) => {
    if (selectedLawClasses.includes(lawClass)) {
      setSelectedLawClasses(prev => prev.filter(lc => lc !== lawClass));
    } else {
      setSelectedLawClasses(prev => [...prev, lawClass]);
    }
    setFiltersVersion(v => v + 1);
  };

  const clearAllFilters = () => {
    console.log('[useDataState] 🧹 Clear All Filters clicked!');
    
    // Clear all cached data to ensure fresh API calls
    const { dataService } = require('@/services/dataService');
    dataService.clearCache();
    console.log('[useDataState] 🧹 Cache cleared');
    
    setSelectedOffenses([]);
    setSelectedLawClasses([]);
    setViolentOn(false); // Turn OFF violent crimes = show nothing
    setNonviolentOn(false); // Turn OFF nonviolent crimes = show nothing
    setSelectedNeighborhood(null); // Clear neighborhood selection too
    setFiltersVersion(v => v + 1);
    console.log('[useDataState] 🧹 Clear All Filters completed - both violent and nonviolent set to FALSE');
  };

  const onChangePairsMode = (mode: PairsMode) => {
    setPairsMode(mode);
    setRotatorResetKey(k => k + 1);
  };

  const state: DataState = {
    city,
    cityConfig,
    startYear,
    endYear,
    filtersVersion,
    crimeTypes,
    selectedOffenses,
    selectedLawClasses,
    violentOn,
    nonviolentOn,
    stats,
    selectedNeighborhood,
    rotatorResetKey,
    pairsData,
    pairsMode,
    chartSeries,
    chartKey,
    trendStats,
    aggData,
    availableYears,
    violentOfns,
    nonviolentOfns,
    effectiveSelectedOffenses,
    activeFilterCount,
    queryParams,
  };

  const actions: DataActions = {
    setCity: handleSetCity,
    setStartYear,
    setEndYear,
    setFiltersVersion,
    setCrimeTypes,
    setSelectedOffenses,
    setSelectedLawClasses,
    setViolentOn,
    setNonviolentOn,
    setStats,
    setSelectedNeighborhood,
    setRotatorResetKey,
    setPairsData,
    setPairsMode,
    setChartSeries,
    setChartKey,
    setTrendStats,
    setAggData,
    toggleCategory,
    toggleOffense,
    toggleLawClass,
    clearAllFilters,
    onChangePairsMode,
    setFiltersData,
  };

  return {
    ...state,
    ...actions,
  };
}
