import { NextRequest, NextResponse } from 'next/server';
import { batchLookupPoints, isSpatialIndexReady, initializeSpatialIndex } from '@/lib/spatial-service';
import type { CityId } from '@/lib/city-config';
import type { ChoroplethResponse } from '@/types/api';

// ClickHouse connection config
const CH_HTTP = process.env.CLICKHOUSE_HTTP_URL;
const CH_USER = process.env.CLICKHOUSE_USER;
const CH_PASS = process.env.CLICKHOUSE_PASS;

const isClickHouseConfigured = CH_HTTP && CH_USER && CH_PASS;
const AUTH = isClickHouseConfigured ? "Basic " + Buffer.from(`${CH_USER}:${CH_PASS}`).toString("base64") : "";

// Compute statistical scale for choropleth coloring
function computeScale(counts: number[]): { min: number; max: number; p50: number; p90: number; p99: number } {
  if (counts.length === 0) {
    return { min: 0, max: 0, p50: 0, p90: 0, p99: 0 };
  }

  const sorted = [...counts].sort((a, b) => a - b);
  const len = sorted.length;

  return {
    min: sorted[0],
    max: sorted[len - 1],
    p50: sorted[Math.floor(len * 0.5)],
    p90: sorted[Math.floor(len * 0.9)],
    p99: sorted[Math.floor(len * 0.99)]
  };
}

export async function GET(request: NextRequest) {
  try {
    const { searchParams } = new URL(request.url);
    const city = searchParams.get('city') as CityId || 'nyc';
    const from = searchParams.get('from') || '2024-12-01';
    const to = searchParams.get('to') || '2024-12-31';
    
    // Parse optional filters
    const offenses = searchParams.getAll('offenses').filter(Boolean);
    const lawClasses = searchParams.getAll('lawClass').filter(Boolean);
    const showNoResults = searchParams.get('showNoResults') === 'true';

    console.log('Simple choropleth request:', { city, from, to, offenses: offenses.length, lawClasses: lawClasses.length, showNoResults });

    // Ensure spatial index is ready
    if (!isSpatialIndexReady()) {
      console.log('Initializing spatial index...');
      initializeSpatialIndex();
    }

    // Handle "Clear all" case - return no results
    if (showNoResults) {
      return NextResponse.json({
        neighborhoods: [],
        scale: { min: 0, max: 0, p50: 0, p90: 0, p99: 0 }
      });
    }

    // Build WHERE conditions
    const whereConditions = [
      `city = '${city}'`,
      `occurred_at >= '${from} 00:00:00'`,
      `occurred_at <= '${to} 23:59:59'`,
      `lat IS NOT NULL`,
      `lon IS NOT NULL`
    ];

    // Add offense filters
    if (offenses.length > 0) {
      const offenseList = offenses.map(o => `'${o.replace(/'/g, "''")}'`).join(',');
      whereConditions.push(`offense IN (${offenseList})`);
    }

    // Add law class filters (NYC only)
    if (lawClasses.length > 0 && city === 'nyc') {
      const lawClassList = lawClasses.map(lc => `'${lc.replace(/'/g, "''")}'`).join(',');
      whereConditions.push(`law_class IN (${lawClassList})`);
    }

    // Simple ClickHouse query - remove limit to get all neighborhoods
    const query = `
      SELECT 
        round(lat, 4) as lat_grid,
        round(lon, 4) as lon_grid,
        count() as count
      FROM public.crime_events
      WHERE ${whereConditions.join(' AND ')}
      GROUP BY lat_grid, lon_grid
      ORDER BY count DESC
    `;

    console.log('Executing query...');
    const queryUrl = `${CH_HTTP}/?query=${encodeURIComponent(query)}&default_format=JSON`;
    const queryRes = await fetch(queryUrl, {
      method: 'GET',
      headers: { Authorization: AUTH }
    });

    if (!queryRes.ok) {
      const errorText = await queryRes.text();
      throw new Error(`ClickHouse query failed: ${queryRes.status} ${errorText}`);
    }

    const queryRawData = await queryRes.json();
    const queryData = queryRawData.data || queryRawData;
    console.log('Got', queryData.length, 'grid cells');

    if (!Array.isArray(queryData) || queryData.length === 0) {
      return NextResponse.json({
        neighborhoods: [],
        scale: { min: 0, max: 0, p50: 0, p90: 0, p99: 0 }
      });
    }

    // Process grid data
    const neighborhoodCounts = new Map<string, number>();

    const batchPoints = queryData.map((row: any) => ({
      lat: parseFloat(row.lat_grid || row[0]),
      lon: parseFloat(row.lon_grid || row[1]),
      count: parseInt(row.count || row[2] || 0)
    }));

    console.log('Processing', batchPoints.length, 'points');

    // Batch lookup neighborhoods
    const lookupResults = batchLookupPoints(city, batchPoints.map(p => ({
      lat: p.lat,
      lon: p.lon
    })));

    console.log('Got', lookupResults.length, 'lookup results');

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

    console.log(`Found ${foundNeighborhoods} points with neighborhoods`);
    console.log(`Aggregated into ${neighborhoodCounts.size} neighborhoods`);

    // Convert to response format
    const neighborhoods = Array.from(neighborhoodCounts.entries()).map(([regionId, count]) => ({
      regionId,
      count
    }));

    const counts = neighborhoods.map(n => n.count);
    const scale = computeScale(counts);

    const response: ChoroplethResponse = { neighborhoods, scale };
    
    console.log('Final response:', {
      neighborhoodCount: neighborhoods.length,
      scale,
      sampleNeighborhoods: neighborhoods.slice(0, 3)
    });

    return NextResponse.json(response);

  } catch (error: any) {
    console.error('Simple choropleth error:', error);
    
    return NextResponse.json(
      { 
        error: 'Internal Server Error',
        message: error.message
      },
      { status: 500 }
    );
  }
}
