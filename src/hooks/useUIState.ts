"use client";

import { useState, useEffect } from "react";

export interface UIState {
  isMobile: boolean;
  viewportWidth: number;
  filtersOpen: boolean;
  cityDropdownOpen: boolean;
  noDataMode: boolean;
  statsLoading: boolean;
  includeUnknown: boolean;
  pairsLocalLoading: boolean;
}

export interface UIActions {
  setFiltersOpen: (open: boolean | ((prev: boolean) => boolean)) => void;
  setCityDropdownOpen: (open: boolean | ((prev: boolean) => boolean)) => void;
  setNoDataMode: (mode: boolean) => void;
  setStatsLoading: (loading: boolean) => void;
  setIncludeUnknown: (include: boolean) => void;
  setPairsLocalLoading: (loading: boolean) => void;
}

export function useUIState() {
  const [isMobile, setIsMobile] = useState<boolean>(false);
  const [viewportWidth, setViewportWidth] = useState<number>(0);
  const [filtersOpen, setFiltersOpen] = useState<boolean>(false);
  const [cityDropdownOpen, setCityDropdownOpen] = useState<boolean>(false);
  const [noDataMode, setNoDataMode] = useState<boolean>(false);
  const [statsLoading, setStatsLoading] = useState<boolean>(false);
  const [includeUnknown, setIncludeUnknown] = useState<boolean>(false);
  const [pairsLocalLoading, setPairsLocalLoading] = useState<boolean>(false);

  // Initialize viewport and mobile detection
  useEffect(() => {
    const updateViewport = () => {
      const width = window.innerWidth;
      setViewportWidth(width);
      setIsMobile(width < 768);
    };

    // Initial setup
    updateViewport();

    // Add resize listener
    window.addEventListener('resize', updateViewport);
    return () => window.removeEventListener('resize', updateViewport);
  }, []);

  const state: UIState = {
    isMobile,
    viewportWidth,
    filtersOpen,
    cityDropdownOpen,
    noDataMode,
    statsLoading,
    includeUnknown,
    pairsLocalLoading,
  };

  const actions: UIActions = {
    setFiltersOpen,
    setCityDropdownOpen,
    setNoDataMode,
    setStatsLoading,
    setIncludeUnknown,
    setPairsLocalLoading,
  };

  return {
    ...state,
    ...actions,
  };
}
