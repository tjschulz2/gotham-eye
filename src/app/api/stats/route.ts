import { NextRequest, NextResponse } from 'next/server';
import type { StatsResponse, NormalizedQueryParams } from '@/types/api';
import { lookupPoint, initializeSpatialIndex } from '@/lib/spatial-service';

// ClickHouse connection config
const CH_HTTP = process.env.CLICKHOUSE_HTTP_URL;
const CH_USER = process.env.CLICKHOUSE_USER;
const CH_PASS = process.env.CLICKHOUSE_PASS;

// Check if ClickHouse is configured
const isClickHouseConfigured = CH_HTTP && CH_USER && CH_PASS;
const AUTH = isClickHouseConfigured ? "Basic " + Buffer.from(`${CH_USER}:${CH_PASS}`).toString("base64") : "";

// Cache for stats data
const cache = new Map<string, { data: StatsResponse; timestamp: number }>();
const CACHE_TTL = 5 * 60 * 1000; // 5 minutes

// Input validation and normalization
function validateAndNormalizeParams(searchParams: URLSearchParams): NormalizedQueryParams {
  const city = searchParams.get('city');
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

  // Get optional filters
  const offenses = searchParams.getAll('offenses').filter(Boolean);
  const lawClass = searchParams.getAll('lawClass').filter(Boolean);
  const neighborhoods = searchParams.getAll('neighborhoods').filter(Boolean);
  const selectedNeighborhood = searchParams.get('selectedNeighborhood');
  const showNoResults = searchParams.get('showNoResults') === 'true';

  return {
    city: city as 'nyc' | 'sf',
    from,
    to,
    offenses,
    lawClass,
    neighborhoods,
    selectedNeighborhood: selectedNeighborhood || undefined,
    showNoResults
  };
}

// Build WHERE clause for ClickHouse queries
function buildWhereClause(params: NormalizedQueryParams): string {
  const conditions = [
    `city = '${params.city}'`,
    `occurred_at >= '${params.from} 00:00:00'`,
    `occurred_at <= '${params.to} 23:59:59'`
  ];

  // Handle "Clear all" case - return no results
  if (params.showNoResults) {
    console.log(`[Stats API] 🚨 CLEAR ALL MODE: Adding 1=0 condition to WHERE clause`);
    conditions.push(`1 = 0`); // This will make the query return zero results
    const whereClause = conditions.join(' AND ');
    console.log(`[Stats API] 🚨 CLEAR ALL WHERE CLAUSE:`, whereClause);
    return whereClause;
  }

  if (params.offenses.length > 0) {
    const offenseList = params.offenses.map(o => `'${o.replace(/'/g, "''")}'`).join(',');
    conditions.push(`offense IN (${offenseList})`);
  }
  // If offenses array is empty and showNoResults is false, don't add any offense filter (show all offenses)

  if (params.lawClass.length > 0) {
    const lawClassList = params.lawClass.map(lc => `'${lc.replace(/'/g, "''")}'`).join(',');
    conditions.push(`law_class IN (${lawClassList})`);
  }

  return conditions.join(' AND ');
}

// Execute ClickHouse query with performance optimizations
async function executeQuery(query: string, timeout: number = 15000): Promise<any[]> {
  if (!isClickHouseConfigured) {
    throw new Error('ClickHouse not configured');
  }

  // Add query timeout and performance settings
  const url = `${CH_HTTP}/?query=${encodeURIComponent(query)}&default_format=JSONEachRow&max_execution_time=${Math.floor(timeout/1000)}&max_memory_usage=2000000000`;
  
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), timeout);
  
  try {
    const response = await fetch(url, {
      method: 'GET',
      headers: { 
        'Authorization': AUTH,
        'Accept': 'application/json'
      },
      signal: controller.signal
    });

    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(`ClickHouse query failed: ${response.status} ${errorText}`);
    }

    const text = await response.text();
    if (!text.trim()) return [];

    return text.trim().split('\n').map(line => JSON.parse(line));
  } finally {
    clearTimeout(timeoutId);
  }
}


// Query total events with PREWHERE optimization
async function queryTotalEvents(params: NormalizedQueryParams, spatialFilter: string = ''): Promise<number> {
  const whereClause = buildWhereClause(params);
  const query = `SELECT count() as total FROM public.crime_events PREWHERE ${whereClause}${spatialFilter}`;
  
  const results = await executeQuery(query, 10000); // 10s timeout for count queries
  return Number(results[0]?.total) || 0;
}

// Query time series data (monthly) with PREWHERE optimization
async function queryTimeSeries(params: NormalizedQueryParams, spatialFilter: string = ''): Promise<Array<{ month: string; count: number }>> {
  const whereClause = buildWhereClause(params);
  const query = `
    SELECT 
      formatDateTime(toStartOfMonth(occurred_at), '%Y-%m') as month,
      count() as count
    FROM public.crime_events 
    PREWHERE ${whereClause}${spatialFilter}
    GROUP BY month
    ORDER BY month ASC
  `;
  
  const results = await executeQuery(query, 12000); // 12s timeout
  return results.map(r => ({ month: r.month, count: Number(r.count) || 0 }));
}

// Query offense breakdown with PREWHERE optimization
async function queryOffenseBreakdown(params: NormalizedQueryParams, spatialFilter: string = ''): Promise<Array<{ offense: string; count: number }>> {
  const whereClause = buildWhereClause(params);
  const query = `
    SELECT 
      offense,
      count() as count
    FROM public.crime_events 
    PREWHERE ${whereClause}${spatialFilter} AND offense != ''
    GROUP BY offense
    ORDER BY count DESC
    LIMIT 20
  `;
  
  const results = await executeQuery(query, 10000); // 10s timeout
  return results.map(r => ({ offense: r.offense, count: Number(r.count) || 0 }));
}

// Query law class breakdown with PREWHERE optimization
async function queryLawClassBreakdown(params: NormalizedQueryParams, spatialFilter: string = ''): Promise<Array<{ lawClass: string; count: number }>> {
  const whereClause = buildWhereClause(params);
  const query = `
    SELECT 
      law_class as lawClass,
      count() as count
    FROM public.crime_events 
    PREWHERE ${whereClause}${spatialFilter} AND law_class != ''
    GROUP BY law_class
    ORDER BY count DESC
    LIMIT 15
  `;
  
  const results = await executeQuery(query, 10000); // 10s timeout
  return results.map(r => ({ lawClass: r.lawClass, count: Number(r.count) || 0 }));
}

// Query location breakdown with optimized JSON extraction
async function queryLocationBreakdown(params: NormalizedQueryParams, spatialFilter: string = ''): Promise<Array<{ location: string; locationType: 'borough' | 'precinct' | 'district' | 'neighborhood' | 'premise'; count: number }>> {
  const whereClause = buildWhereClause(params);
  
  if (params.city === 'nyc') {
    // For NYC, get premise types from raw JSON data with PREWHERE optimization
    const premiseQuery = `
      SELECT 
        JSONExtractString(raw, 'prem_typ_desc') as location,
        'premise' as locationType,
        count() as count
      FROM public.crime_events 
      PREWHERE ${whereClause}${spatialFilter}
      WHERE JSONExtractString(raw, 'prem_typ_desc') != ''
      GROUP BY location
      ORDER BY count DESC
      LIMIT 20
    `;
    
    const results = await executeQuery(premiseQuery, 15000); // 15s timeout for JSON queries
    
    return results.map(r => ({ 
      location: r.location, 
      locationType: 'premise' as const, 
      count: Number(r.count) || 0 
    }));
  } else {
    // For SF, use optimized spatial aggregation
    const query = `
      SELECT 
        round(lat, 3) as lat_rounded, 
        round(lon, 3) as lon_rounded, 
        count() as count
      FROM public.crime_events 
      PREWHERE ${whereClause}${spatialFilter}
      GROUP BY lat_rounded, lon_rounded
      HAVING count > 0
      ORDER BY count DESC
      LIMIT 100
    `;
    
    const results = await executeQuery(query, 12000);
    
    // Initialize spatial index if needed
    initializeSpatialIndex();
    
    // Map coordinates to neighborhoods and aggregate
    const neighborhoodCounts = new Map<string, number>();
    
    for (const result of results) {
      const lookup = lookupPoint(params.city, result.lat_rounded, result.lon_rounded);
      if (lookup.regionId) {
        const current = neighborhoodCounts.get(lookup.regionId) || 0;
        neighborhoodCounts.set(lookup.regionId, current + (Number(result.count) || 0));
      }
    }
    
    // Convert to array and sort
    return Array.from(neighborhoodCounts.entries())
      .map(([location, count]) => ({ location, locationType: 'neighborhood' as const, count }))
      .sort((a, b) => b.count - a.count)
      .slice(0, 20);
  }
}

// Query demographics (NYC only) with major performance optimizations
async function queryDemographics(params: NormalizedQueryParams, spatialFilter: string = '') {
  if (params.city !== 'nyc') {
    return undefined;
  }

  const whereClause = buildWhereClause(params);
  
  // MAJOR OPTIMIZATION: Use a single query to extract all demographic fields at once
  // This reduces JSON parsing overhead from 9 separate queries to 1
  const combinedDemographicsQuery = `
    SELECT 
      JSONExtractString(raw, 'susp_race') as susp_race,
      JSONExtractString(raw, 'susp_sex') as susp_sex,
      JSONExtractString(raw, 'susp_age_group') as susp_age_group,
      JSONExtractString(raw, 'vic_race') as vic_race,
      JSONExtractString(raw, 'vic_sex') as vic_sex,
      JSONExtractString(raw, 'vic_age_group') as vic_age_group,
      count() as count
    FROM public.crime_events 
    PREWHERE ${whereClause}${spatialFilter}
    WHERE raw != ''
    GROUP BY susp_race, susp_sex, susp_age_group, vic_race, vic_sex, vic_age_group
    HAVING count > 0
    ORDER BY count DESC
    LIMIT 1000
  `;

  console.log(`[Stats API] Running optimized demographics query with timeout`);
  const startTime = Date.now();
  
  try {
    const results = await executeQuery(combinedDemographicsQuery, 20000); // 20s timeout for complex query
    const queryTime = Date.now() - startTime;
    console.log(`[Stats API] Demographics query completed in ${queryTime}ms, got ${results.length} result groups`);

    // Process results into the expected format
    const suspRaceMap = new Map<string, number>();
    const suspSexMap = new Map<string, number>();
    const suspAgeMap = new Map<string, number>();
    const vicRaceMap = new Map<string, number>();
    const vicSexMap = new Map<string, number>();
    const vicAgeMap = new Map<string, number>();
    const pairsRaceMap = new Map<string, number>();
    const pairsSexMap = new Map<string, number>();
    const pairsBothMap = new Map<string, number>();

    // Aggregate the results
    for (const row of results) {
      const count = Number(row.count) || 0;
      
      // Individual demographics
      if (row.susp_race && row.susp_race.trim()) {
        suspRaceMap.set(row.susp_race, (suspRaceMap.get(row.susp_race) || 0) + count);
      }
      if (row.susp_sex && row.susp_sex.trim()) {
        suspSexMap.set(row.susp_sex, (suspSexMap.get(row.susp_sex) || 0) + count);
      }
      if (row.susp_age_group && row.susp_age_group.trim()) {
        suspAgeMap.set(row.susp_age_group, (suspAgeMap.get(row.susp_age_group) || 0) + count);
      }
      if (row.vic_race && row.vic_race.trim()) {
        vicRaceMap.set(row.vic_race, (vicRaceMap.get(row.vic_race) || 0) + count);
      }
      if (row.vic_sex && row.vic_sex.trim()) {
        vicSexMap.set(row.vic_sex, (vicSexMap.get(row.vic_sex) || 0) + count);
      }
      if (row.vic_age_group && row.vic_age_group.trim()) {
        vicAgeMap.set(row.vic_age_group, (vicAgeMap.get(row.vic_age_group) || 0) + count);
      }
      
      // Pairs
      if (row.susp_race && row.vic_race && row.susp_race.trim() && row.vic_race.trim()) {
        const key = `${row.susp_race}|${row.vic_race}`;
        pairsRaceMap.set(key, (pairsRaceMap.get(key) || 0) + count);
      }
      if (row.susp_sex && row.vic_sex && row.susp_sex.trim() && row.vic_sex.trim()) {
        const key = `${row.susp_sex}|${row.vic_sex}`;
        pairsSexMap.set(key, (pairsSexMap.get(key) || 0) + count);
      }
      if (row.susp_race && row.susp_sex && row.vic_race && row.vic_sex && 
          row.susp_race.trim() && row.susp_sex.trim() && row.vic_race.trim() && row.vic_sex.trim()) {
        const key = `${row.susp_race}|${row.susp_sex}|${row.vic_race}|${row.vic_sex}`;
        pairsBothMap.set(key, (pairsBothMap.get(key) || 0) + count);
      }
    }

    // Convert maps to sorted arrays
    const sortAndLimit = (map: Map<string, number>, limit: number) => 
      Array.from(map.entries())
        .sort((a, b) => b[1] - a[1])
        .slice(0, limit);

    return {
      susp: {
        race: sortAndLimit(suspRaceMap, 10).map(([category, count]) => ({ category, count })),
        sex: sortAndLimit(suspSexMap, 10).map(([category, count]) => ({ category, count })),
        age: sortAndLimit(suspAgeMap, 10).map(([category, count]) => ({ category, count }))
      },
      vic: {
        race: sortAndLimit(vicRaceMap, 10).map(([category, count]) => ({ category, count })),
        sex: sortAndLimit(vicSexMap, 10).map(([category, count]) => ({ category, count })),
        age: sortAndLimit(vicAgeMap, 10).map(([category, count]) => ({ category, count }))
      },
      pairs: {
        suspVicRace: sortAndLimit(pairsRaceMap, 15).map(([key, count]) => {
          const [suspRace, vicRace] = key.split('|');
          return { suspRace, vicRace, count };
        }),
        suspVicSex: sortAndLimit(pairsSexMap, 15).map(([key, count]) => {
          const [suspSex, vicSex] = key.split('|');
          return { suspSex, vicSex, count };
        }),
        suspVicBoth: sortAndLimit(pairsBothMap, 10).map(([key, count]) => {
          const [suspRace, suspSex, vicRace, vicSex] = key.split('|');
          return { suspRace, suspSex, vicRace, vicSex, count };
        })
      }
    };
  } catch (error) {
    console.error(`[Stats API] Demographics query failed after ${Date.now() - startTime}ms:`, error);
    // Return empty demographics on error to prevent total failure
    return {
      susp: { race: [], sex: [], age: [] },
      vic: { race: [], sex: [], age: [] },
      pairs: { suspVicRace: [], suspVicSex: [], suspVicBoth: [] }
    };
  }
}

// Main query function
async function queryStats(params: NormalizedQueryParams, request?: NextRequest): Promise<StatsResponse> {
  // For neighborhood filtering, return the total from choropleth and empty detailed stats for now
  if (params.selectedNeighborhood) {
    console.log(`[Stats API] Getting neighborhood stats for: ${params.selectedNeighborhood}`);
    
    try {
      // Build choropleth URL with all filters applied
      const choroplethParams = new URLSearchParams({
        city: params.city,
        from: params.from,
        to: params.to
      });
      
      // Add offense filters
      params.offenses.forEach(offense => {
        choroplethParams.append('offenses', offense);
      });
      
      // Add law class filters
      params.lawClass.forEach(lawClass => {
        choroplethParams.append('lawClass', lawClass);
      });
      
      // Add showNoResults flag if present
      if (params.showNoResults) {
        choroplethParams.set('showNoResults', 'true');
      }
      
      // Build the correct base URL for internal API calls
      let baseUrl = 'http://localhost:3000';
      if (request) {
        const protocol = request.headers.get('x-forwarded-proto') || 'http';
        const host = request.headers.get('host') || 'localhost:3000';
        baseUrl = `${protocol}://${host}`;
      }
      
      const choroplethUrl = `${baseUrl}/api/simple-choropleth?${choroplethParams.toString()}`;
      console.log(`[Stats API] Calling choropleth API with filters: ${choroplethUrl}`);
      
      const response = await fetch(choroplethUrl);
      
      if (!response.ok) {
        console.error(`[Stats API] Choropleth API failed: ${response.status}`);
        return {
          totals: { events: 0 },
          timeSeries: [],
          byOffense: [],
          byLawClass: [],
          byLocation: [],
          demographics: undefined
        };
      }
      
      const choroplethData = await response.json();
      console.log(`[Stats API] Choropleth API returned ${choroplethData.neighborhoods?.length || 0} neighborhoods`);
      
      // Find the count for the selected neighborhood
      const neighborhood = choroplethData.neighborhoods?.find((n: any) => n.regionId === params.selectedNeighborhood);
      const count = neighborhood?.count || 0;
      
      console.log(`[Stats API] Found ${count} crimes in neighborhood ${params.selectedNeighborhood} via choropleth API`);
      
      if (count === 0) {
        return {
          totals: { events: 0 },
          timeSeries: [],
          byOffense: [],
          byLawClass: [],
          byLocation: [],
          demographics: undefined
        };
      }

      // Simple approach: Just add neighborhood filter to the base WHERE clause
      console.log(`[Stats API] Getting detailed stats for neighborhood ${params.selectedNeighborhood}`);
      
      // Get the neighborhood bounds and add a simple lat/lon filter
      const { initializeSpatialIndex, batchLookupPoints } = await import('@/lib/spatial-service');
      initializeSpatialIndex();

      // OPTIMIZED: Use coarser grid and simpler spatial filtering
      const baseWhereClause = buildWhereClause(params);
      const gridQuery = `
        SELECT 
          round(lat, 3) as lat_grid,
          round(lon, 3) as lon_grid,
          count() as count
        FROM public.crime_events
        PREWHERE ${baseWhereClause}
          AND lat IS NOT NULL 
          AND lon IS NOT NULL
        GROUP BY lat_grid, lon_grid
        HAVING count > 0
        ORDER BY count DESC
        LIMIT 500
      `;
      
      const gridData = await executeQuery(gridQuery, 15000);
      console.log(`[Stats API] Got ${gridData.length} grid cells`);

      // Find which grid cells are in the neighborhood
      const batchPoints = gridData.map((row: any) => ({
        id: `${row.lat_grid}_${row.lon_grid}`,
        lat: Number(row.lat_grid),
        lon: Number(row.lon_grid),
        count: Number(row.count) || 0
      }));

      const lookupResults = await batchLookupPoints(params.city, batchPoints);
      
      // Build optimized spatial filter using only grid cells in the neighborhood
      const validGridCells: Array<{lat: number; lon: number; count: number}> = [];
      let totalNeighborhoodEvents = 0;
      
      lookupResults.forEach((result: any, index: number) => {
        if (result && result.regionId === params.selectedNeighborhood) {
          const gridCell = batchPoints[index];
          validGridCells.push({
            lat: gridCell.lat,
            lon: gridCell.lon,
            count: gridCell.count
          });
          totalNeighborhoodEvents += gridCell.count;
        }
      });

      console.log(`[Stats API] Found ${validGridCells.length} grid cells with ~${totalNeighborhoodEvents} events in neighborhood`);
      
      if (validGridCells.length === 0) {
        return {
          totals: { events: 0 },
          timeSeries: [],
          byOffense: [],
          byLawClass: [],
          byLocation: [],
          demographics: undefined
        };
      }

      // Build efficient spatial filter - limit to reasonable number of conditions
      const maxGridCells = 100; // Prevent query from becoming too complex
      const topGridCells = validGridCells
        .sort((a, b) => b.count - a.count)
        .slice(0, maxGridCells);
      
      const spatialConditions = topGridCells.map(cell => 
        `(round(lat, 3) = ${cell.lat} AND round(lon, 3) = ${cell.lon})`
      ).join(' OR ');
      
      const spatialFilter = ` AND (${spatialConditions})`;
      
      console.log(`[Stats API] Using optimized spatial filter with ${topGridCells.length} grid cells`);
      
      // Get detailed stats in parallel with error handling
      console.log(`[Stats API] Starting detailed stats queries for neighborhood`);
      const statsStartTime = Date.now();
      
      try {
        const [
          byOffense,
          byLawClass,
          byLocation,
          timeSeries,
          demographics
        ] = await Promise.all([
          queryOffenseBreakdown(params, spatialFilter).catch(err => {
            console.error('[Stats API] Offense breakdown failed:', err);
            return [];
          }),
          queryLawClassBreakdown(params, spatialFilter).catch(err => {
            console.error('[Stats API] Law class breakdown failed:', err);
            return [];
          }),
          queryLocationBreakdown(params, spatialFilter).catch(err => {
            console.error('[Stats API] Location breakdown failed:', err);
            return [];
          }),
          queryTimeSeries(params, spatialFilter).catch(err => {
            console.error('[Stats API] Time series failed:', err);
            return [];
          }),
          queryDemographics(params, spatialFilter).catch(err => {
            console.error('[Stats API] Demographics failed:', err);
            return undefined;
          })
        ]);
        
        const statsTime = Date.now() - statsStartTime;
        console.log(`[Stats API] Detailed stats completed in ${statsTime}ms: ${byOffense.length} offenses, ${timeSeries.length} months, ${byLocation.length} locations`);

        return {
          totals: { events: count }, // Use choropleth count for accuracy
          timeSeries,
          byOffense,
          byLawClass,
          byLocation,
          demographics
        };
      } catch (error) {
        console.error(`[Stats API] Detailed stats failed after ${Date.now() - statsStartTime}ms:`, error);
        // Return basic stats on error
        return {
          totals: { events: count },
          timeSeries: [],
          byOffense: [],
          byLawClass: [],
          byLocation: [],
          demographics: undefined
        };
      }
      
    } catch (error) {
      console.error(`[Stats API] Error calling choropleth API:`, error);
      return {
        totals: { events: 0 },
        timeSeries: [],
        byOffense: [],
        byLawClass: [],
        byLocation: [],
        demographics: undefined
      };
    }
  }

  // Execute all queries in parallel for city-wide stats
  const [
    totalEvents,
    timeSeries,
    byOffense,
    byLawClass,
    byLocation,
    demographics
  ] = await Promise.all([
    queryTotalEvents(params),
    queryTimeSeries(params),
    queryOffenseBreakdown(params),
    queryLawClassBreakdown(params),
    queryLocationBreakdown(params),
    queryDemographics(params)
  ]);

  return {
    totals: {
      events: totalEvents
    },
    timeSeries,
    byOffense,
    byLawClass,
    byLocation,
    demographics
  };
}

export async function GET(request: NextRequest) {
  try {
    const { searchParams } = new URL(request.url);
    const params = validateAndNormalizeParams(searchParams);
    
    console.log(`[Stats API] 🚨 RECEIVED PARAMS:`, {
      city: params.city,
      showNoResults: params.showNoResults,
      offensesCount: params.offenses.length,
      lawClassCount: params.lawClass.length
    });
    
    // Generate cache key
    const cacheKey = `stats:${params.city}:${params.from}:${params.to}:${params.offenses.sort().join(',')}:${params.lawClass.sort().join(',')}:${params.neighborhoods?.sort().join(',') || ''}:${params.selectedNeighborhood || ''}:${params.showNoResults || ''}`;
    
    console.log(`[Stats API] Cache key: ${cacheKey}`);
    console.log(`[Stats API] Selected neighborhood: ${params.selectedNeighborhood}`);
    console.log(`[Stats API] Filters - Offenses: [${params.offenses.join(', ')}], Law Classes: [${params.lawClass.join(', ')}]`);
    
    // Disable cache for neighborhood requests temporarily for debugging
    if (!params.selectedNeighborhood) {
      // Check cache only for city-wide requests
      const cached = cache.get(cacheKey);
      if (cached && Date.now() - cached.timestamp < CACHE_TTL) {
        console.log(`[Stats API] Cache hit for key: ${cacheKey}, returning cached data with ${cached.data.totals?.events || 0} events`);
        return NextResponse.json(cached.data, {
          headers: {
            'Cache-Control': 'public, max-age=300',
            'X-Cache': 'HIT'
          }
        });
      }
    } else {
      console.log(`[Stats API] Skipping cache for neighborhood request: ${params.selectedNeighborhood}`);
    }
    
    console.log(`[Stats API] Cache miss for key: ${cacheKey}, fetching new data`);

    // Query fresh data with timeout
    console.log(`Querying stats for:`, params);
    const startTime = Date.now();
    
    // Add timeout for stats queries
    const timeoutPromise = new Promise((_, reject) => {
      setTimeout(() => reject(new Error('Stats query timeout after 25 seconds')), 25000);
    });

    const statsPromise = queryStats(params, request);
    const response = await Promise.race([statsPromise, timeoutPromise]) as StatsResponse;
    
    const queryTime = Date.now() - startTime;
    console.log(`Stats query completed in ${queryTime}ms`);

    // Cache the response
    cache.set(cacheKey, { data: response, timestamp: Date.now() });

    // Clean up old cache entries
    if (cache.size > 100) {
      const entries = Array.from(cache.entries());
      entries.sort((a, b) => a[1].timestamp - b[1].timestamp);
      for (let i = 0; i < 20; i++) {
        cache.delete(entries[i][0]);
      }
    }

    return NextResponse.json(response, {
      headers: {
        'Cache-Control': 'public, max-age=300',
        'X-Cache': 'MISS',
        'X-Query-Time': queryTime.toString()
      }
    });

  } catch (error: any) {
    console.error('Stats API error:', error);
    
    return NextResponse.json(
      { 
        error: 'Internal Server Error',
        message: error.message || 'Failed to fetch stats data'
      },
      { status: 500 }
    );
  }
}
