// Shared API types and query parameters for all endpoints

import type { CityId } from "@/lib/city-config";

// Base query parameters shared across all endpoints
export interface BaseQueryParams {
  city: CityId;
  from: string; // ISO date string (YYYY-MM-DD)
  to: string;   // ISO date string (YYYY-MM-DD)
}

// Extended query parameters with optional filters
export interface FilteredQueryParams extends BaseQueryParams {
  offenses?: string[];  // Array of offense names to filter by
  lawClass?: string[];  // Array of law classes to filter by (NYC only)
}

// Normalized query parameters for internal use
export interface NormalizedQueryParams {
  city: CityId;
  from: string;
  to: string;
  offenses: string[];
  lawClass: string[];
  neighborhoods?: string[];
  selectedNeighborhood?: string; // Single neighborhood ID for filtering
  showNoResults?: boolean; // Special flag for "Clear all" case
}

// API Response types

export interface FiltersResponse {
  offenses: Array<{
    offense: string;
    count: number;
  }>;
  lawClasses?: Array<{
    lawClass: string;
    count: number;
  }>;
  totalOffenses: number;
}

export interface ChoroplethResponse {
  neighborhoods: Array<{
    regionId: string;
    count: number;
  }>;
  scale: {
    min: number;
    max: number;
    p50: number;
    p90: number;
    p99: number;
  };
}

export interface StatsResponse {
  totals: {
    events: number;
  };
  timeSeries: Array<{
    month: string; // YYYY-MM format
    count: number;
  }>;
  byOffense: Array<{
    offense: string;
    count: number;
  }>;
  byLawClass: Array<{
    lawClass: string;
    count: number;
  }>;
  byLocation: Array<{
    location: string; // premise types for NYC, neighborhood for SF
    locationType: 'borough' | 'precinct' | 'district' | 'neighborhood' | 'premise';
    count: number;
  }>;
  demographics?: {
    susp: {
      race: Array<{ category: string; count: number }>;
      sex: Array<{ category: string; count: number }>;
      age: Array<{ category: string; count: number }>;
    };
    vic: {
      race: Array<{ category: string; count: number }>;
      sex: Array<{ category: string; count: number }>;
      age: Array<{ category: string; count: number }>;
    };
    pairs?: {
      suspVicRace: Array<{ suspRace: string; vicRace: string; count: number }>;
      suspVicSex: Array<{ suspSex: string; vicSex: string; count: number }>;
      suspVicBoth: Array<{ suspRace: string; suspSex: string; vicRace: string; vicSex: string; count: number }>;
    };
  };
}

// API Error type
export interface ApiError {
  error: string;
  message: string;
  status: number;
}

// Cache configuration
export interface CacheConfig {
  ttl: number; // TTL in milliseconds
  key: string; // Cache key
}

// Query parameter validation and normalization utilities
export class QueryParamsBuilder {
  private params: Partial<NormalizedQueryParams> = {};

  constructor(base?: Partial<BaseQueryParams>) {
    if (base) {
      this.params = { ...base } as Partial<NormalizedQueryParams>;
    }
  }

  city(city: CityId): QueryParamsBuilder {
    this.params.city = city;
    return this;
  }

  dateRange(from: string, to: string): QueryParamsBuilder {
    this.params.from = from;
    this.params.to = to;
    return this;
  }

  offenses(offenses: string[]): QueryParamsBuilder {
    this.params.offenses = [...offenses];
    return this;
  }

  lawClass(lawClass: string[]): QueryParamsBuilder {
    this.params.lawClass = [...lawClass];
    return this;
  }

  selectedNeighborhood(neighborhoodId: string | undefined): QueryParamsBuilder {
    this.params.selectedNeighborhood = neighborhoodId;
    return this;
  }

  showNoResults(show: boolean): QueryParamsBuilder {
    this.params.showNoResults = show;
    return this;
  }

  build(): NormalizedQueryParams {
    if (!this.params.city) {
      throw new Error('City is required');
    }
    if (!this.params.from || !this.params.to) {
      throw new Error('Date range (from/to) is required');
    }

    return {
      city: this.params.city,
      from: this.params.from,
      to: this.params.to,
      offenses: this.params.offenses || [],
      lawClass: this.params.lawClass || [],
      selectedNeighborhood: this.params.selectedNeighborhood,
      showNoResults: this.params.showNoResults,
    };
  }

  // Convert to URL search params for API calls
  toSearchParams(): URLSearchParams {
    const normalized = this.build();
    const searchParams = new URLSearchParams();

    searchParams.set('city', normalized.city);
    searchParams.set('from', normalized.from);
    searchParams.set('to', normalized.to);

    if (normalized.offenses.length > 0) {
      normalized.offenses.forEach(offense => {
        searchParams.append('offenses', offense);
      });
    }

    if (normalized.lawClass.length > 0) {
      normalized.lawClass.forEach(lawClass => {
        searchParams.append('lawClass', lawClass);
      });
    }

    if (normalized.selectedNeighborhood) {
      searchParams.set('selectedNeighborhood', normalized.selectedNeighborhood);
    }

    if (normalized.showNoResults) {
      searchParams.set('showNoResults', 'true');
    }

    return searchParams;
  }

  // Generate cache key for consistent caching
  toCacheKey(endpoint: string): string {
    const normalized = this.build();
    const parts = [
      endpoint,
      normalized.city,
      normalized.from,
      normalized.to,
    ];

    if (normalized.offenses.length > 0) {
      parts.push(`offenses:${normalized.offenses.sort().join(',')}`);
    }

    if (normalized.lawClass.length > 0) {
      parts.push(`lawClass:${normalized.lawClass.sort().join(',')}`);
    }

    if (normalized.selectedNeighborhood) {
      parts.push(`selectedNeighborhood:${normalized.selectedNeighborhood}`);
    }

    if (normalized.showNoResults) {
      parts.push('showNoResults:true');
    }

    return parts.join('|');
  }
}

// Utility functions for date handling
export const dateUtils = {
  // Convert year range to ISO date strings
  yearRangeToISO(startYear: number, endYear: number): { from: string; to: string } {
    return {
      from: `${startYear}-01-01`,
      to: `${endYear}-12-31`,
    };
  },

  // Validate ISO date string
  isValidISODate(dateString: string): boolean {
    const regex = /^\d{4}-\d{2}-\d{2}$/;
    if (!regex.test(dateString)) return false;
    
    const date = new Date(dateString);
    return date instanceof Date && !isNaN(date.getTime());
  },

  // Get current date in ISO format
  getCurrentISODate(): string {
    return new Date().toISOString().split('T')[0];
  },

  // Format date for display
  formatDisplayDate(isoDate: string): string {
    const date = new Date(isoDate);
    return date.toLocaleDateString('en-US', {
      year: 'numeric',
      month: 'short',
      day: 'numeric'
    });
  }
};
