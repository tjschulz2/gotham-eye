"use client";

import { useState, useMemo } from "react";
import type { CrimeType } from "@/types/crime";
import type { FiltersResponse } from "@/types/api";
import type { Map as MapLibreMap } from 'maplibre-gl';
import type { Stats } from "@/hooks/useDataState";

interface DesktopFiltersProps {
  // State
  filtersOpen: boolean;
  setFiltersOpen: (open: boolean | ((prev: boolean) => boolean)) => void;
  activeFilterCount: number;
  
  // Years
  availableYears: number[];
  startYear: number;
  endYear: number;
  setStartYear: (year: number) => void;
  setEndYear: (year: number) => void;
  setFiltersVersion: (version: number | ((prev: number) => number)) => void;
  
  // Crime types (legacy - keeping for backward compatibility)
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
  
  // UI
  viewportWidth: number;
  
  // Map actions
  mapRef: MapLibreMap | null;
  setStats: (stats: Stats | null) => void;
  setAggData: (data: unknown) => void;
}

export default function DesktopFilters({
  filtersOpen,
  setFiltersOpen,
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
  viewportWidth,
  mapRef,
  setStats,
  setAggData,
}: DesktopFiltersProps) {
  // Search state for filtering offenses
  const [searchTerm, setSearchTerm] = useState("");

  // Get offense list from API data or fallback to legacy crimeTypes
  const availableOffenses = useMemo(() => {
    if (filtersData?.offenses) {
      return filtersData.offenses.map(o => o.offense);
    }
    // Fallback to legacy crimeTypes
    return crimeTypes.map(ct => ct.label);
  }, [filtersData, crimeTypes]);

  // Filter offenses by search term
  const filteredOffenses = useMemo(() => {
    if (!searchTerm) return availableOffenses;
    return availableOffenses.filter(offense => 
      offense.toLowerCase().includes(searchTerm.toLowerCase())
    );
  }, [availableOffenses, searchTerm]);

  // Separate violent and non-violent crimes based on keywords
  const violentOfns = useMemo(() => {
    return filteredOffenses.filter((offense) => {
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
  }, [filteredOffenses]);

  const nonviolentOfns = useMemo(() => {
    return filteredOffenses.filter((offense) => !violentOfns.includes(offense));
  }, [filteredOffenses, violentOfns]);

  return (
    <div
      style={{
        position: "absolute",
        top: 12,
        left: 12,
        zIndex: 11,
        fontFamily: "system-ui, -apple-system, Segoe UI, Roboto, sans-serif",
      }}
    >
      <div style={{ position: "relative", flex: "0 0 auto" }}>
        <button 
          onClick={() => setFiltersOpen((v) => !v)} 
          style={{ 
            display: "flex", 
            alignItems: "center", 
            justifyContent: "center", 
            background: "rgba(0, 0, 0, 0.3)", 
            backdropFilter: "blur(10px)", 
            border: "none", 
            color: "#fff", 
            padding: 8, 
            borderRadius: 9999, 
            cursor: "pointer", 
            height: 40, 
            width: 40 
          }}
        >
          <svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" strokeWidth={2} stroke="currentColor" shapeRendering="crispEdges" style={{ width: 20, height: 20, opacity: 0.9 }}>
            <path vectorEffect="non-scaling-stroke" strokeLinecap="round" strokeLinejoin="round" d="M10.5 6h9.75M10.5 6a1.5 1.5 0 1 1-3 0m3 0a1.5 1.5 0 1 0-3 0M3.75 6H7.5m3 12h9.75m-9.75 0a1.5 1.5 0 0 1-3 0m3 0a1.5 1.5 0 0 0-3 0m-3.75 0H7.5m9-6h3.75m-3.75 0a1.5 1.5 0 0 1-3 0m3 0a1.5 1.5 0 0 0-3 0m-9.75 0h9.75" />
          </svg>
        </button>
        <div style={{ position: "absolute", top: -6, right: -6, background: activeFilterCount > 0 ? "#2563eb" : "#374151", color: "#fff", borderRadius: 9999, padding: "2px 6px", fontSize: 11, fontWeight: 700, minWidth: 18, textAlign: "center", lineHeight: 1 }}>
          {activeFilterCount}
        </div>
        {filtersOpen && (
          <div
            style={{
              position: "absolute",
              top: "calc(100% + 8px)",
              left: 0,
              zIndex: 20,
              width: Math.min(360, Math.max(220, viewportWidth - 32)),
              height: 400,
              overflowY: "auto",
              background: "rgba(0, 0, 0, 0.4)",
              backdropFilter: "blur(10px)",
              borderRadius: 12,
              padding: 12,
              boxShadow: "0 4px 12px rgba(0, 0, 0, 0.3)",
            }}
          >
            <div style={{ marginBottom: 8, display: "flex", alignItems: "center", justifyContent: "space-between" }}>
              <label style={{ fontSize: 13, fontWeight: 600, color: "#fff" }}>Years</label>
              <button
                type="button"
                onClick={(e) => { 
                  e.preventDefault(); 
                  clearAllFilters(); 
                  // Let the filter clearing trigger API calls that will return zero results
                  // Don't manually set stats - the API will return empty data when no filters are selected
                }}
                style={{ background: "transparent", border: "none", color: "#e5e7eb", cursor: "pointer", fontSize: 12, padding: 0 }}
              >
                Clear all
              </button>
            </div>
            <div style={{ marginTop: 4, display: "flex", gap: 8, alignItems: "center", flexWrap: viewportWidth <= 360 ? "wrap" : undefined }}>
              <select
                value={startYear}
                onChange={(e) => {
                  const y = Number(e.target.value);
                  console.log(`[Start Year Change] Selected: ${y}, current endYear: ${endYear}`);
                  if (!Number.isFinite(y)) return;
                  if (y > endYear) {
                    console.log(`[Start Year Change] Setting both years to ${y}`);
                    setStartYear(y);
                    setEndYear(y);
                    setFiltersVersion((v) => v + 1);
                  } else {
                    console.log(`[Start Year Change] Setting startYear to ${y}`);
                    setStartYear(y);
                    setFiltersVersion((v) => v + 1);
                  }
                }}
                style={{ fontSize: 12, padding: "4px 8px", borderRadius: 6, background: "#111", color: "#fff", border: "1px solid #444" }}
              >
                {availableYears.map((y, idx) => (
                  <option key={`start-${y}-${idx}`} value={y}>{y}</option>
                ))}
              </select>
              <span style={{ opacity: 0.9, color: "rgba(255,255,255,0.9)", fontSize: 12 }}>to</span>
              <select
                value={endYear}
                onChange={(e) => {
                  const y = Number(e.target.value);
                  console.log(`[End Year Change] Selected: ${y}, current startYear: ${startYear}`);
                  if (!Number.isFinite(y)) return;
                  if (y < startYear) {
                    console.log(`[End Year Change] Setting both years to ${y}`);
                    setStartYear(y);
                    setEndYear(y);
                    setFiltersVersion((v) => v + 1);
                  } else {
                    console.log(`[End Year Change] Setting endYear to ${y}`);
                    setEndYear(y);
                    setFiltersVersion((v) => v + 1);
                  }
                }}
                style={{ fontSize: 12, padding: "4px 8px", borderRadius: 6, background: "#111", color: "#fff", border: "1px solid #444" }}
              >
                {availableYears.map((y, idx) => (
                  <option key={`end-${y}-${idx}`} value={y}>{y}</option>
                ))}
              </select>
            </div>

            {/* Search input */}
            <div style={{ marginTop: 14, borderTop: "1px solid #333", paddingTop: 12 }}>
              <label style={{ fontSize: 13, fontWeight: 600, color: "#fff", display: "block", marginBottom: 8 }}>
                Search Offenses
              </label>
              <input
                type="text"
                placeholder="Type to filter offenses..."
                value={searchTerm}
                onChange={(e) => setSearchTerm(e.target.value)}
                style={{
                  width: "100%",
                  fontSize: 12,
                  padding: "6px 8px",
                  borderRadius: 6,
                  background: "#111",
                  color: "#fff",
                  border: "1px solid #444",
                  outline: "none"
                }}
              />
              {filtersLoading && (
                <div style={{ fontSize: 11, color: "rgba(255,255,255,0.6)", marginTop: 4 }}>
                  Loading offenses...
                </div>
              )}
              {filtersError && (
                <div style={{ fontSize: 11, color: "#ef4444", marginTop: 4 }}>
                  Error: {filtersError}
                </div>
              )}
              {filtersData && (
                <div style={{ fontSize: 11, color: "rgba(255,255,255,0.6)", marginTop: 4 }}>
                  {filtersData.totalOffenses} total offenses available
                </div>
              )}
            </div>

            {/* Violent section */}
            <div style={{ marginTop: 14, borderTop: "1px solid #333", paddingTop: 12 }}>
              <div style={{ display: "flex", alignItems: "center" }}>
                <div style={{ fontSize: 13, fontWeight: 600, flex: 1, color: "#fff" }}>
                  Violent crimes ({violentOfns.length})
                </div>
                <input type="checkbox" checked={violentOn} onChange={() => toggleCategory("violent")} />
              </div>
              <div style={{ marginTop: 10, display: "flex", flexDirection: "column", gap: 6, opacity: violentOn ? 1 : 0.9 }}>
                {filtersLoading && (
                  <div style={{ fontSize: 12, color: "rgba(255,255,255,0.5)", fontStyle: "italic" }}>
                    Loading violent crimes...
                  </div>
                )}
                {!filtersLoading && violentOfns.length === 0 && (
                  <div style={{ fontSize: 12, color: "rgba(255,255,255,0.5)", fontStyle: "italic" }}>
                    {searchTerm ? "No violent crimes match your search" : "No violent crimes available"}
                  </div>
                )}
                {violentOfns.map((label) => {
                  const isChecked = selectedOfns.length > 0 ? effectiveSelectedOfns.includes(label) : violentOn;
                  return (
                    <div key={label} style={{ display: "flex", alignItems: "center", gap: 8 }}>
                      <div style={{ fontSize: 12, flex: 1, color: "rgba(255,255,255,0.9)" }}>
                        {label}
                      </div>
                      <input type="checkbox" checked={isChecked} onChange={() => toggleOffense(label, violentOn)} />
                    </div>
                  );
                })}
              </div>
            </div>

            {/* Non-violent section */}
            <div style={{ marginTop: 20, borderTop: "1px solid #333", paddingTop: 12 }}>
              <div style={{ display: "flex", alignItems: "center" }}>
                <div style={{ fontSize: 13, fontWeight: 600, flex: 1, color: "#fff" }}>
                  Non-violent crimes ({nonviolentOfns.length})
                </div>
                <input type="checkbox" checked={nonviolentOn} onChange={() => toggleCategory("nonviolent")} />
              </div>
              <div style={{ marginTop: 10, display: "flex", flexDirection: "column", gap: 6, opacity: nonviolentOn ? 1 : 0.9 }}>
                {filtersLoading && (
                  <div style={{ fontSize: 12, color: "rgba(255,255,255,0.5)", fontStyle: "italic" }}>
                    Loading non-violent crimes...
                  </div>
                )}
                {!filtersLoading && nonviolentOfns.length === 0 && (
                  <div style={{ fontSize: 12, color: "rgba(255,255,255,0.5)", fontStyle: "italic" }}>
                    {searchTerm ? "No non-violent crimes match your search" : "No non-violent crimes available"}
                  </div>
                )}
                {nonviolentOfns.map((label) => {
                  const isChecked = selectedOfns.length > 0 ? effectiveSelectedOfns.includes(label) : nonviolentOn;
                  return (
                    <div key={label} style={{ display: "flex", alignItems: "center", gap: 8 }}>
                      <div style={{ fontSize: 12, flex: 1, color: "rgba(255,255,255,0.9)" }}>
                        {label}
                      </div>
                      <input type="checkbox" checked={isChecked} onChange={() => toggleOffense(label, nonviolentOn)} />
                    </div>
                  );
                })}
              </div>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
