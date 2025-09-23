import { NextRequest, NextResponse } from 'next/server';
import type { ChoroplethResponse } from '@/types/api';
import { batchLookupPoints, isSpatialIndexReady, initializeSpatialIndex } from '@/lib/spatial-service';
import type { CityId } from '@/lib/city-config';

// ClickHouse connection config
const CH_HTTP = process.env.CLICKHOUSE_HTTP_URL;
const CH_USER = process.env.CLICKHOUSE_USER;
const CH_PASS = process.env.CLICKHOUSE_PASS;

// Check if ClickHouse is configured
const isClickHouseConfigured = CH_HTTP && CH_USER && CH_PASS;
const AUTH = isClickHouseConfigured ? "Basic " + Buffer.from(`${CH_USER}:${CH_PASS}`).toString("base64") : "";

// Cache for choropleth data
const cache = new Map<string, { data: ChoroplethResponse; timestamp: number }>();
const CACHE_TTL = 5 * 60 * 1000; // 5 minutes

// Input validation
function validateParams(searchParams: URLSearchParams) {
  const city = searchParams.get('city') as CityId;
  const from = searchParams.get('from');
  const to = searchParams.get('to');

  if (!city || !['nyc', 'sf'].includes(city)) {
    throw new Error('Invalid or missing city parameter. Must be "nyc" or "sf"');
  }

  if (!from || !to) {
    throw new Error('Missing required parameters: from, to');
  }

  // Validate date format (YYYY-MM-DD)
  const dateRegex = /^\d{4}-\d{2}-\d{2}$/;
  if (!dateRegex.test(from) || !dateRegex.test(to)) {
    throw new Error('Invalid date format. Use YYYY-MM-DD');
  }

  // Parse optional filters
  const offenses = searchParams.getAll('offenses').filter(Boolean);
  const lawClasses = searchParams.getAll('lawClass').filter(Boolean);
  const showNoResults = searchParams.get('showNoResults') === 'true';

  return { city, from, to, offenses, lawClasses, showNoResults };
}

// Compute statistical scale for choropleth coloring
function computeScale(counts: number[]): { min: number; max: number; p50: number; p90: number; p99: number } {
  if (counts.length === 0) {
    return { min: 0, max: 0, p50: 0, p90: 0, p99: 0 };
  }

  const sorted = [...counts].sort((a, b) => a - b);
  const len = sorted.length;

  const scale = {
    min: sorted[0],
    max: sorted[len - 1],
    p50: sorted[Math.floor(len * 0.5)],
    p90: sorted[Math.floor(len * 0.9)],
    p99: sorted[Math.floor(len * 0.99)]
  };

  // For very low data scenarios, ensure some spread in percentiles
  // This helps with color distribution when there are few unique values
  if (len <= 5 && scale.min === scale.max) {
    // All values are the same, create artificial spread for better visualization
    const baseValue = scale.min;
    return {
      min: baseValue,
      max: baseValue,
      p50: baseValue,
      p90: baseValue,
      p99: baseValue
    };
  } else if (len <= 10 && scale.p50 === scale.p90) {
    // Very few unique values, adjust percentiles to create some spread
    const range = scale.max - scale.min;
    if (range > 0) {
      return {
        min: scale.min,
        max: scale.max,
        p50: scale.min + Math.floor(range * 0.3),
        p90: scale.min + Math.floor(range * 0.7),
        p99: scale.max
      };
    }
  }

  return scale;
}

// Query ClickHouse for crime data with H3 aggregation
async function queryChoroplethData(
  city: CityId, 
  from: string, 
  to: string, 
  offenses: string[], 
  lawClasses: string[],
  showNoResults: boolean = false
): Promise<ChoroplethResponse> {
  // Ensure spatial index is ready
  if (!isSpatialIndexReady()) {
    console.log('Spatial index not ready, initializing...');
    initializeSpatialIndex();
  }

  // Escape SQL strings to prevent injection
  const escapeString = (str: string) => `'${str.replace(/'/g, "''")}'`;
  
  const cityEscaped = escapeString(city);
  const fromEscaped = escapeString(`${from} 00:00:00`);
  const toEscaped = escapeString(`${to} 23:59:59`);

  // Build WHERE conditions for filters
  const whereConditions = [
    `city = ${cityEscaped}`,
    `occurred_at >= ${fromEscaped}`,
    `occurred_at <= ${toEscaped}`,
    `lat IS NOT NULL`,
    `lon IS NOT NULL`
  ];

  // Handle "Clear all" case - return no results
  if (showNoResults) {
    whereConditions.push(`1 = 0`); // This will make the query return zero results
  } else {
    // Add offense filters
    if (offenses.length > 0) {
      const offenseList = offenses.map(escapeString).join(',');
      whereConditions.push(`offense IN (${offenseList})`);
    }
    // If offenses array is empty and showNoResults is false, don't add any offense filter (show all offenses)
  }

  // Add law class filters (NYC only)
  if (lawClasses.length > 0 && city === 'nyc') {
    const lawClassList = lawClasses.map(escapeString).join(',');
    whereConditions.push(`law_class IN (${lawClassList})`);
  }

  const whereClause = whereConditions.join(' AND ');

  // Try H3 aggregation first (preferred method) with performance settings
  const h3Query = `
    SELECT 
      lower(hex(geoToH3(lon, lat, 9))) as h3_index,
      count() as count
    FROM public.crime_events
    PREWHERE ${whereClause}
    GROUP BY h3_index
    HAVING h3_index != '0'
    ORDER BY count DESC
    LIMIT 10000
  `;

  try {
    // Test if ClickHouse supports H3 functions
    const h3Url = `${CH_HTTP}/?query=${encodeURIComponent(h3Query)}&default_format=JSON`;
    console.log(`[Choropleth API] Executing H3 query:`, h3Query.substring(0, 200) + '...');
    console.log(`[Choropleth API] H3 URL length: ${h3Url.length}`);
    
    const h3Res = await fetch(h3Url, {
      method: 'GET',
      headers: { Authorization: AUTH }
    });

    if (h3Res.ok) {
      const h3RawData = await h3Res.json();
      const h3Data = h3RawData.data || h3RawData;
      
      console.log(`[Choropleth API] H3 query successful. Raw data type: ${typeof h3RawData}, Array: ${Array.isArray(h3Data)}, Length: ${h3Data?.length || 0}`);
      console.log(`[Choropleth API] Sample H3 data:`, h3Data?.slice(0, 2));

      if (Array.isArray(h3Data) && h3Data.length > 0) {
        console.log(`[Choropleth API] Using H3 aggregation: ${h3Data.length} H3 cells found`);
        
        // TEMPORARY FIX: Process H3 data directly here instead of using the separate function
        const neighborhoodCounts = new Map<string, number>();
        const { cellToLatLng } = await import('h3-js');
        const { lookupPoint, initializeSpatialIndex } = await import('@/lib/spatial-service');
        
        // Initialize spatial index
        initializeSpatialIndex();
        
        for (const row of h3Data) {
          const h3Index = String(row.h3_index || row[0]);
          const count = parseInt(row.count || row[1] || 0);
          
          try {
            // Convert H3 to lat/lon (cellToLatLng returns [lng, lat])
            const [lon, lat] = cellToLatLng(h3Index);
            
            // Lookup neighborhood
            const result = lookupPoint(city, lat, lon);
            
            if (result.regionId) {
              const existing = neighborhoodCounts.get(result.regionId) || 0;
              neighborhoodCounts.set(result.regionId, existing + count);
            }
          } catch (error) {
            console.warn(`[Choropleth API] Error processing H3 cell ${h3Index}:`, error);
          }
        }
        
        // Convert to response format
        const neighborhoods = Array.from(neighborhoodCounts.entries()).map(([regionId, count]) => ({
          regionId,
          count
        }));
        
        const counts = neighborhoods.map(n => n.count);
        const scale = computeScale(counts);
        
        return { neighborhoods, scale };
        
      } else {
        console.log(`[Choropleth API] H3 data is empty or invalid, falling back to grid`);
      }
    } else {
      const errorText = await h3Res.text();
      console.warn(`[Choropleth API] H3 query failed with status ${h3Res.status}:`, errorText);
      console.warn('H3 functions not available in ClickHouse, falling back to lat/lon grid');
    }
  } catch (error) {
    console.warn('H3 query failed, falling back to lat/lon grid:', error);
  }

  // Fallback: Use lat/lon grid aggregation with performance optimizations
  console.log('Using lat/lon grid fallback');
  const gridQuery = `
    SELECT 
      round(lat, 4) as lat_grid,
      round(lon, 4) as lon_grid,
      count() as count
    FROM public.crime_events
    PREWHERE ${whereClause}
    GROUP BY lat_grid, lon_grid
    HAVING count > 0
    ORDER BY count DESC
    LIMIT 5000
  `;

  const gridUrl = `${CH_HTTP}/?query=${encodeURIComponent(gridQuery)}&default_format=JSON`;
  const gridRes = await fetch(gridUrl, {
    method: 'GET',
    headers: { Authorization: AUTH }
  });

  if (!gridRes.ok) {
    const errorText = await gridRes.text();
    throw new Error(`ClickHouse grid query failed: ${gridRes.status} ${errorText}`);
  }

  const gridRawData = await gridRes.json();
  const gridData = gridRawData.data || gridRawData;

  if (!Array.isArray(gridData)) {
    throw new Error(`Invalid grid data format: expected array, got ${typeof gridData}`);
  }

  console.log(`Grid aggregation: ${gridData.length} grid cells found`);
  console.log('Sample grid data:', gridData.slice(0, 3));
  return await processGridData(city, gridData);
}

// Process H3 aggregated data from ClickHouse
async function processH3Data(city: CityId, h3Data: any[]): Promise<ChoroplethResponse> {
  
  // Convert H3 indices to neighborhood counts
  const neighborhoodCounts = new Map<string, number>();

  // Import H3 functions
  const { cellToLatLng } = await import('h3-js');
  
  // Batch process H3 cells to get neighborhoods
  const batchPoints = h3Data.map((row: any) => {
    const h3IndexRaw = row.h3_index || row[0];
    const count = parseInt(row.count || row[1] || 0);
    
    // H3 index should now be a hexadecimal string from ClickHouse
    const h3Index = String(h3IndexRaw);
    
    try {
      // Convert H3 cell to lat/lon for neighborhood lookup
      const [lon, lat] = cellToLatLng(h3Index); // Note: cellToLatLng returns [lng, lat]
      
      return {
        id: h3Index,
        lat, // This is correct now - lat from cellToLatLng
        lon, // This is correct now - lon from cellToLatLng  
        count
      };
    } catch (error) {
      console.warn(`[Choropleth API] Invalid H3 index: ${h3IndexRaw} (${h3Index})`, error);
      return null;
    }
  }).filter(Boolean); // Remove null entries

  // Batch lookup neighborhoods
  const lookupResults = batchLookupPoints(city, batchPoints.filter(p => p).map(p => ({
    lat: p!.lat,
    lon: p!.lon,
    id: p!.id
  })));
  

  // Aggregate counts by neighborhood
  lookupResults.forEach((result, index) => {
    if (result.regionId) {
      const point = batchPoints[index];
      if (point) {
        const count = point.count;
        const existing = neighborhoodCounts.get(result.regionId) || 0;
        neighborhoodCounts.set(result.regionId, existing + count);
      }
    }
  });

  // Convert to response format
  const neighborhoods = Array.from(neighborhoodCounts.entries()).map(([regionId, count]) => ({
    regionId,
    count
  }));

  const counts = neighborhoods.map(n => n.count);
  const scale = computeScale(counts);

  return { neighborhoods, scale };
}

// Process lat/lon grid data (fallback method)
async function processGridData(city: CityId, gridData: any[]): Promise<ChoroplethResponse> {
  // Convert grid points to neighborhood counts
  const neighborhoodCounts = new Map<string, number>();

  // Batch process grid points
  const batchPoints = gridData.map((row: any) => {
    const lat = parseFloat(row.lat_grid || row[0]);
    const lon = parseFloat(row.lon_grid || row[1]);
    const count = parseInt(row.count || row[2] || 0);
    
    return { lat, lon, count };
  });

  console.log(`Processing ${batchPoints.length} grid points for ${city}`);
  console.log('Sample batch points:', batchPoints.slice(0, 3));

  // Batch lookup neighborhoods
  const lookupResults = batchLookupPoints(city, batchPoints.map(p => ({
    lat: p.lat,
    lon: p.lon,
    id: `grid_${p.lat}_${p.lon}`
  })));
  
  // Debug Clinton Hill specifically for grid data
  if (city === 'nyc') {
    console.log(`[Choropleth API] DEBUG GRID: Processing ${batchPoints.length} grid points for NYC`);
    const clintonHillGridPoints = batchPoints.filter(p => 
      p.lat >= 40.680 && p.lat <= 40.699 && p.lon >= -73.971 && p.lon <= -73.958
    );
    console.log(`[Choropleth API] DEBUG GRID: ${clintonHillGridPoints.length} grid points in Clinton Hill area`);
    
    if (clintonHillGridPoints.length > 0) {
      console.log(`[Choropleth API] DEBUG GRID: Sample Clinton Hill grid points:`, clintonHillGridPoints.slice(0, 3));
      console.log(`[Choropleth API] DEBUG GRID: Total crimes in Clinton Hill grid points:`, 
        clintonHillGridPoints.reduce((sum, p) => sum + p.count, 0)
      );
      
      // Check what the spatial lookup returns for these points
      const clintonHillGridLookups = lookupResults.filter((result, index) => {
        const point = batchPoints[index];
        return point.lat >= 40.680 && point.lat <= 40.699 && point.lon >= -73.971 && point.lon <= -73.958;
      });
      
      console.log(`[Choropleth API] DEBUG GRID: Clinton Hill grid lookup results:`, clintonHillGridLookups.slice(0, 3));
      
      const bk0204GridResults = clintonHillGridLookups.filter(r => r.regionId === 'BK0204');
      console.log(`[Choropleth API] DEBUG GRID: ${bk0204GridResults.length} grid points mapped to BK0204`);
      
      if (bk0204GridResults.length > 0) {
        const totalCrimesForBK0204 = bk0204GridResults.reduce((sum, result, index) => {
          const originalIndex = lookupResults.indexOf(result);
          return sum + (originalIndex >= 0 ? batchPoints[originalIndex].count : 0);
        }, 0);
        console.log(`[Choropleth API] DEBUG GRID: Total crimes that should be attributed to BK0204: ${totalCrimesForBK0204}`);
      }
    }
  }

  console.log(`Lookup results: ${lookupResults.length} results`);
  console.log('Sample lookup results:', lookupResults.slice(0, 3));

  // Aggregate counts by neighborhood
  let foundNeighborhoods = 0;
  lookupResults.forEach((result, index) => {
    if (result.regionId) {
      foundNeighborhoods++;
      const count = batchPoints[index].count;
      const existing = neighborhoodCounts.get(result.regionId) || 0;
      neighborhoodCounts.set(result.regionId, existing + count);
    }
  });

  console.log(`Found ${foundNeighborhoods} points with neighborhoods out of ${lookupResults.length} total points`);
  console.log(`Aggregated into ${neighborhoodCounts.size} neighborhoods`);

  // Convert to response format
  const neighborhoods = Array.from(neighborhoodCounts.entries()).map(([regionId, count]) => ({
    regionId,
    count
  }));

  const counts = neighborhoods.map(n => n.count);
  const scale = computeScale(counts);

  console.log(`Final result: ${neighborhoods.length} neighborhoods, scale: ${JSON.stringify(scale)}`);

  return { neighborhoods, scale };
}

export async function GET(request: NextRequest) {
  const startTime = Date.now();
  
  try {
    console.log('=== CHOROPLETH REQUEST START ===');
    const { searchParams } = new URL(request.url);
    const { city, from, to, offenses, lawClasses, showNoResults } = validateParams(searchParams);
    console.log(`Request params: city=${city}, from=${from}, to=${to}, offenses=${offenses.length}, lawClasses=${lawClasses.length}`);
    console.log(`Offenses array:`, offenses);
    console.log(`Law classes array:`, lawClasses);
    console.log(`Show no results:`, showNoResults);

    // Require ClickHouse to be configured
    if (!isClickHouseConfigured) {
      throw new Error('ClickHouse not configured. Please set CLICKHOUSE_HTTP_URL, CLICKHOUSE_USER, and CLICKHOUSE_PASS environment variables.');
    }

    // Check cache first
    const cacheKey = `choropleth:${city}:${from}:${to}:${offenses.join(',')}:${lawClasses.join(',')}`;
    const cached = cache.get(cacheKey);
    
    if (cached && Date.now() - cached.timestamp < CACHE_TTL) {
      console.log('Returning cached data');
      return NextResponse.json(cached.data, {
        headers: {
          'Cache-Control': 'public, max-age=300', // 5 minutes
        }
      });
    }

    console.log('Querying ClickHouse...');
    
    // Add timeout to the query - reduced from 30s to 15s
    const timeoutPromise = new Promise((_, reject) => {
      setTimeout(() => reject(new Error('Request timeout after 15 seconds')), 15000);
    });

    const dataPromise = queryChoroplethData(city, from, to, offenses, lawClasses, showNoResults);
    
    const data = await Promise.race([dataPromise, timeoutPromise]) as any;

    console.log(`Query completed in ${Date.now() - startTime}ms`);

    // Cache the result
    cache.set(cacheKey, {
      data,
      timestamp: Date.now()
    });

    console.log(`Choropleth data: ${data.neighborhoods.length} neighborhoods, scale: ${JSON.stringify(data.scale)}`);
    console.log('=== CHOROPLETH REQUEST END ===');

    return NextResponse.json(data, {
      headers: {
        'Cache-Control': 'public, max-age=300', // 5 minutes
      }
    });

  } catch (error: any) {
    console.error('Choropleth API error:', error);
    console.error('Error stack:', error.stack);
    console.log(`Request failed after ${Date.now() - startTime}ms`);
    
    return NextResponse.json(
      { 
        error: 'Internal Server Error',
        message: error.message || 'Failed to fetch choropleth data',
        duration: Date.now() - startTime
      },
      { status: 500 }
    );
  }
}
