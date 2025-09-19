"use client";

import { useRef, useEffect } from "react";
import type { CityId } from "@/lib/city-config";

interface SearchButtonProps {
  city: CityId;
  cityConfig: {
    displayName: string;
  };
  cityDropdownOpen: boolean;
  setCityDropdownOpen: (open: boolean) => void;
  setCity: (city: CityId) => void;
}

export default function SearchButton({
  city,
  cityConfig,
  cityDropdownOpen,
  setCityDropdownOpen,
  setCity,
}: SearchButtonProps) {
  const cityDropdownRef = useRef<HTMLDivElement>(null);

  // Close dropdown when clicking outside
  useEffect(() => {
    const handleClickOutside = (event: MouseEvent) => {
      if (cityDropdownRef.current && !cityDropdownRef.current.contains(event.target as Node)) {
        setCityDropdownOpen(false);
      }
    };

    if (cityDropdownOpen) {
      document.addEventListener('mousedown', handleClickOutside);
      return () => document.removeEventListener('mousedown', handleClickOutside);
    }
  }, [cityDropdownOpen, setCityDropdownOpen]);

  return (
    <div ref={cityDropdownRef} style={{ position: "relative", flex: 1, minWidth: 0 }}>
      {/* Search button */}
      <div
        onClick={() => setCityDropdownOpen(!cityDropdownOpen)}
        style={{
          background: "rgba(0, 0, 0, 0.3)",
          backdropFilter: "blur(10px)",
          color: "#fff",
          padding: "8px 16px",
          borderRadius: 100,
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          gap: 12,
          cursor: "pointer",
          height: 40,
          flex: 1,
          minWidth: 0,
        }}
      >
        <div style={{ display: "flex", alignItems: "center", gap: 8, minWidth: 0 }}>
          {/* Search Icon */}
          <svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" strokeWidth={1.5} stroke="currentColor" style={{ width: 16, height: 16, opacity: 0.6 }}>
            <path strokeLinecap="round" strokeLinejoin="round" d="m21 21-5.197-5.197m0 0A7.5 7.5 0 1 0 5.196 5.196a7.5 7.5 0 0 0 10.607 10.607Z" />
          </svg>
          {/* Location Text */}
          <span style={{ fontSize: 15, fontWeight: 500, marginLeft: 4, transform: "translateY(-1px)", whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>
            {cityConfig.displayName}
          </span>
        </div>
        {/* Down Chevron */}
        <svg 
          xmlns="http://www.w3.org/2000/svg" 
          fill="none" 
          viewBox="0 0 24 24" 
          strokeWidth={1.5} 
          stroke="currentColor" 
          style={{ 
            width: 14, 
            height: 14, 
            opacity: 0.8,
            transform: cityDropdownOpen ? "rotate(180deg)" : "rotate(0deg)",
            transition: "transform 0.2s ease"
          }}
        >
          <path strokeLinecap="round" strokeLinejoin="round" d="m19.5 8.25-7.5 7.5-7.5-7.5" />
        </svg>
      </div>

      {/* Dropdown */}
      {cityDropdownOpen && (
        <div
          style={{
            position: "absolute",
            top: "100%",
            left: 0,
            right: 0,
            marginTop: 8,
            background: "rgba(0, 0, 0, 0.4)",
            backdropFilter: "blur(10px)",
            borderRadius: 12,
            overflow: "hidden",
            boxShadow: "0 4px 12px rgba(0, 0, 0, 0.3)",
          }}
        >
          <div
            onClick={() => {
              setCity("nyc");
              setCityDropdownOpen(false);
            }}
            style={{
              padding: "12px 24px",
              color: "#fff",
              cursor: "pointer",
              fontSize: 14,
              fontWeight: 500,
              backgroundColor: city === "nyc" ? "rgba(255, 255, 255, 0.1)" : "transparent",
              borderBottom: "1px solid rgba(255, 255, 255, 0.1)",
            }}
            onMouseEnter={(e) => {
              if (city !== "nyc") {
                e.currentTarget.style.backgroundColor = "rgba(255, 255, 255, 0.05)";
              }
            }}
            onMouseLeave={(e) => {
              if (city !== "nyc") {
                e.currentTarget.style.backgroundColor = "transparent";
              }
            }}
          >
            New York City
          </div>
          <div
            onClick={() => {
              setCity("sf");
              setCityDropdownOpen(false);
            }}
            style={{
              padding: "12px 24px",
              color: "#fff",
              cursor: "pointer",
              fontSize: 14,
              fontWeight: 500,
              backgroundColor: city === "sf" ? "rgba(255, 255, 255, 0.1)" : "transparent",
            }}
            onMouseEnter={(e) => {
              if (city !== "sf") {
                e.currentTarget.style.backgroundColor = "rgba(255, 255, 255, 0.05)";
              }
            }}
            onMouseLeave={(e) => {
              if (city !== "sf") {
                e.currentTarget.style.backgroundColor = "transparent";
              }
            }}
          >
            San Francisco
          </div>
        </div>
      )}
    </div>
  );
}
