"use client";

import type { CityId } from "@/lib/city-config";
import { 
  QueryParamsBuilder, 
  type NormalizedQueryParams,
  type FiltersResponse,
  type ChoroplethResponse,
  type StatsResponse 
} from "@/types/api";

// Cache for API responses
const cache = new Map<string, { data: unknown; timestamp: number; ttl: number }>();

// In-flight requests to prevent duplicate concurrent calls
const inflightRequests = new Map<string, Promise<unknown>>();

// Cache utilities

function getCachedData(key: string): unknown | null {
  const cached = cache.get(key);
  if (!cached) return null;
  
  const now = Date.now();
  if (now - cached.timestamp > cached.ttl) {
    cache.delete(key);
    return null;
  }
  
  return cached.data;
}

function setCachedData(key: string, data: unknown, ttlMs: number = 300000): void { // 5 min default
  cache.set(key, {
    data,
    timestamp: Date.now(),
    ttl: ttlMs,
  });
}


// Base API call function using QueryParamsBuilder
async function apiCall<T>(
  endpoint: string, 
  queryParams: NormalizedQueryParams, 
  options: { cache?: boolean; ttl?: number } = {}
): Promise<T> {
  const { cache: useCache = true, ttl = 300000 } = options;
  
  const builder = new QueryParamsBuilder()
    .city(queryParams.city)
    .dateRange(queryParams.from, queryParams.to)
    .offenses(queryParams.offenses)
    .lawClass(queryParams.lawClass)
    .selectedNeighborhood(queryParams.selectedNeighborhood);
  
  // Add showNoResults if present
  if (queryParams.showNoResults) {
    builder.showNoResults(queryParams.showNoResults);
  }
  
  const cacheKey = builder.toCacheKey(endpoint);
  
  // Check cache first
  if (useCache) {
    const cached = getCachedData(cacheKey);
    if (cached) {
      return cached as T;
    }
  }

  // Check if request is already in flight
  const existingRequest = inflightRequests.get(cacheKey);
  if (existingRequest) {
    return existingRequest as Promise<T>;
  }

  // Build URL with search params
  const searchParams = builder.toSearchParams();
  const url = `${endpoint}?${searchParams}`;
  
  // Create and store the request promise
  const requestPromise = (async () => {
    try {
      const response = await fetch(url);
      if (!response.ok) {
        throw new Error(`API Error ${response.status}: ${response.statusText}`);
      }
      
      const data = await response.json();
      
      // Cache the result
      if (useCache) {
        setCachedData(cacheKey, data, ttl);
      }
      
      return data;
    } catch (error) {
      console.error(`API call failed for ${endpoint}:`, error);
      throw error;
    } finally {
      // Remove from in-flight requests
      inflightRequests.delete(cacheKey);
    }
  })();

  // Store the promise to prevent duplicate requests
  inflightRequests.set(cacheKey, requestPromise);
  
  return requestPromise;
}

// Specific API service functions
export const dataService = {
  // New standardized API endpoints
  
  // Filters API - get available offenses and law classes
  async getFilters(queryParams: NormalizedQueryParams): Promise<FiltersResponse> {
    return apiCall<FiltersResponse>('/api/filters', queryParams, { 
      ttl: 1800000 // 30 min cache - filters change less frequently
    });
  },

  // Choropleth API - get neighborhood crime counts for map coloring
  async getChoropleth(queryParams: NormalizedQueryParams): Promise<ChoroplethResponse> {
    console.log('[dataService] Calling choropleth API with params:', queryParams);
    const result = await apiCall<ChoroplethResponse>('/api/simple-choropleth', queryParams, { 
      cache: !queryParams.showNoResults, // Disable cache for "Clear all" requests
      ttl: 300000 // 5 min cache
    });
    console.log('[dataService] Choropleth API response received:', {neighborhoods: result.neighborhoods?.length || 0, scale: result.scale});
    return result;
  },

  // Stats API - get comprehensive statistics for sidebar
  async getStats(queryParams: NormalizedQueryParams): Promise<StatsResponse> {
    console.log('[dataService] Calling stats API with params:', queryParams);
    const result = await apiCall<StatsResponse>('/api/stats', queryParams, { 
      cache: !queryParams.showNoResults, // Disable cache for "Clear all" requests
      ttl: 60000 // 1 min cache (shorter to prevent cache poisoning)
    });
    console.log('[dataService] Stats API response received:', result.totals);
    return result;
  },

  // Legacy API endpoints (for backward compatibility during transition)
  
  // Legacy Stats API
  async getLegacyStats(params: {
    city: CityId;
    start: string;
    end: string;
    ofns?: string;
    law?: string;
    source?: string;
    bbox?: string;
  }) {
    // Convert legacy params to normalized format
    const queryParams: NormalizedQueryParams = {
      city: params.city,
      from: params.start,
      to: params.end,
      offenses: params.ofns ? [params.ofns] : [],
      lawClass: params.law ? [params.law] : [],
    };
    return apiCall('/api/stats', queryParams);
  },

  // H3 data API (keeping for existing functionality)
  async getH3Data(queryParams: NormalizedQueryParams) {
    return apiCall('/api/h3', queryParams, { ttl: 120000 }); // 2 min cache for H3 data
  },

  // Cache management
  clearCache() {
    cache.clear();
    inflightRequests.clear();
  },

  getCacheSize() {
    return cache.size;
  },

  getCacheStats() {
    const now = Date.now();
    let validEntries = 0;
    let expiredEntries = 0;
    
    cache.forEach((entry) => {
      if (now - entry.timestamp > entry.ttl) {
        expiredEntries++;
      } else {
        validEntries++;
      }
    });
    
    return { total: cache.size, valid: validEntries, expired: expiredEntries };
  },
};
