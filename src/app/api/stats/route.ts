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

// Execute ClickHouse query
async function executeQuery(query: string): Promise<any[]> {
  if (!isClickHouseConfigured) {
    throw new Error('ClickHouse not configured');
  }

  const url = `${CH_HTTP}/?query=${encodeURIComponent(query)}&default_format=JSONEachRow`;
  
  const response = await fetch(url, {
    method: 'GET',
    headers: { 
      'Authorization': AUTH,
      'Accept': 'application/json'
    }
  });

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`ClickHouse query failed: ${response.status} ${errorText}`);
  }

  const text = await response.text();
  if (!text.trim()) return [];

  return text.trim().split('\n').map(line => JSON.parse(line));
}


// Query total events
async function queryTotalEvents(params: NormalizedQueryParams, spatialFilter: string = ''): Promise<number> {
  const whereClause = buildWhereClause(params);
  const query = `SELECT count() as total FROM public.crime_events WHERE ${whereClause}${spatialFilter}`;
  
  const results = await executeQuery(query);
  return Number(results[0]?.total) || 0;
}

// Query time series data (monthly)
async function queryTimeSeries(params: NormalizedQueryParams, spatialFilter: string = ''): Promise<Array<{ month: string; count: number }>> {
  const whereClause = buildWhereClause(params);
  const query = `
    SELECT 
      formatDateTime(toStartOfMonth(occurred_at), '%Y-%m') as month,
      count() as count
    FROM public.crime_events 
    WHERE ${whereClause}${spatialFilter}
    GROUP BY month
    ORDER BY month ASC
  `;
  
  const results = await executeQuery(query);
  return results.map(r => ({ month: r.month, count: Number(r.count) || 0 }));
}

// Query offense breakdown
async function queryOffenseBreakdown(params: NormalizedQueryParams, spatialFilter: string = ''): Promise<Array<{ offense: string; count: number }>> {
  const whereClause = buildWhereClause(params);
  const query = `
    SELECT 
      offense,
      count() as count
    FROM public.crime_events 
    WHERE ${whereClause}${spatialFilter} AND offense != ''
    GROUP BY offense
    ORDER BY count DESC
    LIMIT 20
  `;
  
  const results = await executeQuery(query);
  return results.map(r => ({ offense: r.offense, count: Number(r.count) || 0 }));
}

// Query law class breakdown
async function queryLawClassBreakdown(params: NormalizedQueryParams, spatialFilter: string = ''): Promise<Array<{ lawClass: string; count: number }>> {
  const whereClause = buildWhereClause(params);
  const query = `
    SELECT 
      law_class as lawClass,
      count() as count
    FROM public.crime_events 
    WHERE ${whereClause}${spatialFilter} AND law_class != ''
    GROUP BY law_class
    ORDER BY count DESC
    LIMIT 15
  `;
  
  const results = await executeQuery(query);
  return results.map(r => ({ lawClass: r.lawClass, count: Number(r.count) || 0 }));
}

// Query location breakdown
async function queryLocationBreakdown(params: NormalizedQueryParams, spatialFilter: string = ''): Promise<Array<{ location: string; locationType: 'borough' | 'precinct' | 'district' | 'neighborhood' | 'premise'; count: number }>> {
  const whereClause = buildWhereClause(params);
  
  if (params.city === 'nyc') {
    // For NYC, get premise types from raw JSON data
    const premiseQuery = `
      SELECT 
        JSONExtractString(raw, 'prem_typ_desc') as location,
        'premise' as locationType,
        count() as count
      FROM public.crime_events 
      WHERE ${whereClause}${spatialFilter} AND JSONExtractString(raw, 'prem_typ_desc') != ''
      GROUP BY location
      ORDER BY count DESC
      LIMIT 20
    `;
    
    const results = await executeQuery(premiseQuery);
    
    return results.map(r => ({ 
      location: r.location, 
      locationType: 'premise' as const, 
      count: Number(r.count) || 0 
    }));
  } else {
    // For SF, we need to map lat/lon to neighborhoods using spatial service
    const query = `
      SELECT lat, lon, count() as count
      FROM public.crime_events 
      WHERE ${whereClause}${spatialFilter}
      GROUP BY lat, lon
      HAVING count > 0
    `;
    
    const results = await executeQuery(query);
    
    // Initialize spatial index if needed
    initializeSpatialIndex();
    
    // Map coordinates to neighborhoods and aggregate
    const neighborhoodCounts = new Map<string, number>();
    
    for (const result of results) {
      const lookup = lookupPoint(params.city, result.lat, result.lon);
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

// Query demographics (NYC only)
async function queryDemographics(params: NormalizedQueryParams, spatialFilter: string = '') {
  if (params.city !== 'nyc') {
    return undefined;
  }

  const whereClause = buildWhereClause(params);
  
  // Helper function to extract and clean demographic data
  const extractDemographic = (field: string, topN: number = 10) => `
    SELECT 
      JSONExtractString(raw, '${field}') as category,
      count() as count
    FROM public.crime_events 
    WHERE ${whereClause}${spatialFilter} AND JSONExtractString(raw, '${field}') != ''
    GROUP BY category
    ORDER BY count DESC
    LIMIT ${topN}
  `;

  // Query all demographic breakdowns in parallel
  const [
    suspRaceResults,
    suspSexResults, 
    suspAgeResults,
    vicRaceResults,
    vicSexResults,
    vicAgeResults
  ] = await Promise.all([
    executeQuery(extractDemographic('susp_race')),
    executeQuery(extractDemographic('susp_sex')),
    executeQuery(extractDemographic('susp_age_group')),
    executeQuery(extractDemographic('vic_race')),
    executeQuery(extractDemographic('vic_sex')),
    executeQuery(extractDemographic('vic_age_group'))
  ]);

  // Query suspect/victim pairs
  const pairsRaceQuery = `
    SELECT 
      JSONExtractString(raw, 'susp_race') as suspRace,
      JSONExtractString(raw, 'vic_race') as vicRace,
      count() as count
    FROM public.crime_events 
    WHERE ${whereClause}${spatialFilter}
      AND JSONExtractString(raw, 'susp_race') != ''
      AND JSONExtractString(raw, 'vic_race') != ''
    GROUP BY suspRace, vicRace
    ORDER BY count DESC
    LIMIT 15
  `;

  const pairsSexQuery = `
    SELECT 
      JSONExtractString(raw, 'susp_sex') as suspSex,
      JSONExtractString(raw, 'vic_sex') as vicSex,
      count() as count
    FROM public.crime_events 
    WHERE ${whereClause}${spatialFilter}
      AND JSONExtractString(raw, 'susp_sex') != ''
      AND JSONExtractString(raw, 'vic_sex') != ''
    GROUP BY suspSex, vicSex
    ORDER BY count DESC
    LIMIT 15
  `;

  const pairsBothQuery = `
    SELECT 
      JSONExtractString(raw, 'susp_race') as suspRace,
      JSONExtractString(raw, 'susp_sex') as suspSex,
      JSONExtractString(raw, 'vic_race') as vicRace,
      JSONExtractString(raw, 'vic_sex') as vicSex,
      count() as count
    FROM public.crime_events 
    WHERE ${whereClause}${spatialFilter}
      AND JSONExtractString(raw, 'susp_race') != ''
      AND JSONExtractString(raw, 'susp_sex') != ''
      AND JSONExtractString(raw, 'vic_race') != ''
      AND JSONExtractString(raw, 'vic_sex') != ''
    GROUP BY suspRace, suspSex, vicRace, vicSex
    ORDER BY count DESC
    LIMIT 10
  `;

  const [pairsRaceResults, pairsSexResults, pairsBothResults] = await Promise.all([
    executeQuery(pairsRaceQuery),
    executeQuery(pairsSexQuery),
    executeQuery(pairsBothQuery)
  ]);

  return {
    susp: {
      race: suspRaceResults.map(r => ({ category: r.category, count: Number(r.count) || 0 })),
      sex: suspSexResults.map(r => ({ category: r.category, count: Number(r.count) || 0 })),
      age: suspAgeResults.map(r => ({ category: r.category, count: Number(r.count) || 0 }))
    },
    vic: {
      race: vicRaceResults.map(r => ({ category: r.category, count: Number(r.count) || 0 })),
      sex: vicSexResults.map(r => ({ category: r.category, count: Number(r.count) || 0 })),
      age: vicAgeResults.map(r => ({ category: r.category, count: Number(r.count) || 0 }))
    },
    pairs: {
      suspVicRace: pairsRaceResults.map(r => ({ suspRace: r.suspRace, vicRace: r.vicRace, count: Number(r.count) || 0 })),
      suspVicSex: pairsSexResults.map(r => ({ suspSex: r.suspSex, vicSex: r.vicSex, count: Number(r.count) || 0 })),
      suspVicBoth: pairsBothResults.map(r => ({ 
        suspRace: r.suspRace, 
        suspSex: r.suspSex, 
        vicRace: r.vicRace, 
        vicSex: r.vicSex, 
        count: Number(r.count) || 0 
      }))
    }
  };
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

      // Get ALL events and find which ones are in the neighborhood using grid approach
      const baseWhereClause = buildWhereClause(params);
      const gridQuery = `
        SELECT 
          round(lat, 4) as lat_grid,
          round(lon, 4) as lon_grid,
          groupArray(event_id) as event_ids
        FROM public.crime_events
        WHERE ${baseWhereClause}
          AND lat IS NOT NULL 
          AND lon IS NOT NULL
        GROUP BY lat_grid, lon_grid
        ORDER BY length(event_ids) DESC
      `;
      
      const gridData = await executeQuery(gridQuery);
      console.log(`[Stats API] Got ${gridData.length} grid cells`);

      // Find which grid cells are in the neighborhood
      const batchPoints = gridData.map((row: any) => ({
        id: `${row.lat_grid}_${row.lon_grid}`,
        lat: Number(row.lat_grid),
        lon: Number(row.lon_grid),
        eventIds: row.event_ids || []
      }));

      const lookupResults = await batchLookupPoints(params.city, batchPoints);
      
      // Get ALL event IDs from grid cells in the neighborhood
      const neighborhoodEventIds: string[] = [];
      lookupResults.forEach((result: any, index: number) => {
        if (result && result.regionId === params.selectedNeighborhood) {
          const gridCell = batchPoints[index];
          if (gridCell && gridCell.eventIds) {
            for (const eventId of gridCell.eventIds) {
              if (eventId && typeof eventId === 'string') {
                neighborhoodEventIds.push(eventId);
              }
            }
          }
        }
      });

      console.log(`[Stats API] Found ${neighborhoodEventIds.length} total events in neighborhood (not just sample)`);
      
      if (neighborhoodEventIds.length === 0) {
        return {
          totals: { events: 0 },
          timeSeries: [],
          byOffense: [],
          byLawClass: [],
          byLocation: [],
          demographics: undefined
        };
      }

      // Instead of using event IDs (which might be too many), use spatial grid filter
      const gridCells: Array<{lat: number; lon: number}> = [];
      lookupResults.forEach((result: any, index: number) => {
        if (result && result.regionId === params.selectedNeighborhood) {
          const gridCell = batchPoints[index];
          gridCells.push({
            lat: gridCell.lat,
            lon: gridCell.lon
          });
        }
      });
      
      console.log(`[Stats API] Using spatial filter with ${gridCells.length} grid cells for ${neighborhoodEventIds.length} events`);
      
      // Build spatial filter using grid coordinates
      const spatialConditions = gridCells.map(cell => 
        `(round(lat, 4) = ${cell.lat} AND round(lon, 4) = ${cell.lon})`
      ).join(' OR ');
      
      const spatialFilter = ` AND (${spatialConditions})`;
      
      console.log(`[Stats API] Getting all detailed stats with spatial filter`);
      
      // Get all detailed stats in parallel
      const [
        byOffense,
        byLawClass,
        byLocation,
        timeSeries,
        demographics
      ] = await Promise.all([
        queryOffenseBreakdown(params, spatialFilter),
        queryLawClassBreakdown(params, spatialFilter),
        queryLocationBreakdown(params, spatialFilter),
        queryTimeSeries(params, spatialFilter),
        queryDemographics(params, spatialFilter)
      ]);
      
      console.log(`[Stats API] Detailed stats completed: ${byOffense.length} offenses, ${timeSeries.length} months, ${byLocation.length} locations`);

      return {
        totals: { events: count }, // Use choropleth count for accuracy
        timeSeries,
        byOffense,
        byLawClass,
        byLocation,
        demographics
      };
      
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

    // Query fresh data
    console.log(`Querying stats for:`, params);
    const startTime = Date.now();
    
    const response = await queryStats(params, request);
    
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
