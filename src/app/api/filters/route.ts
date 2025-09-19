import { NextRequest, NextResponse } from 'next/server';
import type { FiltersResponse } from '@/types/api';

// ClickHouse connection config
const CH_HTTP = process.env.CLICKHOUSE_HTTP_URL;
const CH_USER = process.env.CLICKHOUSE_USER;
const CH_PASS = process.env.CLICKHOUSE_PASS;

// Check if ClickHouse is configured
const isClickHouseConfigured = CH_HTTP && CH_USER && CH_PASS;
const AUTH = isClickHouseConfigured ? "Basic " + Buffer.from(`${CH_USER}:${CH_PASS}`).toString("base64") : "";

// Cache for filters data
const cache = new Map<string, { data: FiltersResponse; timestamp: number }>();
const CACHE_TTL = 30 * 60 * 1000; // 30 minutes

// Input validation
function validateParams(searchParams: URLSearchParams) {
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

  return { city, from, to };
}

// Query ClickHouse for filters data
async function queryFilters(city: string, from: string, to: string): Promise<FiltersResponse> {
  // Escape SQL strings to prevent injection
  const escapeString = (str: string) => `'${str.replace(/'/g, "''")}'`;
  
  const cityEscaped = escapeString(city);
  const fromEscaped = escapeString(`${from} 00:00:00`);
  const toEscaped = escapeString(`${to} 23:59:59`);

  // Query for offenses - exclude shootings data as it has artificial offense categories
  const offensesQuery = `
    SELECT 
      offense,
      count() as count
    FROM public.crime_events
    PREWHERE city = ${cityEscaped}
      AND occurred_at >= ${fromEscaped}
      AND occurred_at <= ${toEscaped}
      AND offense != ''
      AND source != 'shootings'
    GROUP BY offense
    ORDER BY count DESC
    LIMIT 200
  `;

  // Query for law classes (NYC only)
  const lawClassQuery = city === 'nyc' ? `
    SELECT 
      law_class,
      count() as count
    FROM public.crime_events
    PREWHERE city = ${cityEscaped}
      AND occurred_at >= ${fromEscaped}
      AND occurred_at <= ${toEscaped}
      AND law_class != ''
    GROUP BY law_class
    ORDER BY count DESC
    LIMIT 50
  ` : null;

  // Query for total offenses count - exclude shootings data as it has artificial offense categories
  const totalQuery = `
    SELECT count(DISTINCT offense) as total_offenses
    FROM public.crime_events
    PREWHERE city = ${cityEscaped}
      AND occurred_at >= ${fromEscaped}
      AND occurred_at <= ${toEscaped}
      AND offense != ''
      AND source != 'shootings'
  `;

  try {
    // Execute offenses query
    const offensesUrl = `${CH_HTTP}/?query=${encodeURIComponent(offensesQuery)}&default_format=JSON`;
    const offensesRes = await fetch(offensesUrl, {
      method: 'GET',
      headers: { 
        Authorization: AUTH
      }
    });

    if (!offensesRes.ok) {
      const errorText = await offensesRes.text();
      throw new Error(`ClickHouse offenses query failed: ${offensesRes.status} ${errorText}`);
    }

    const offensesRawData = await offensesRes.json();
    console.log('ClickHouse offenses response:', offensesRawData);
    
    // ClickHouse returns data in format: { data: [...], meta: [...], rows: number }
    const offensesData = offensesRawData.data || offensesRawData;

    // Execute law class query if NYC
    let lawClassData = [];
    if (lawClassQuery) {
      const lawClassUrl = `${CH_HTTP}/?query=${encodeURIComponent(lawClassQuery)}&default_format=JSON`;
      const lawClassRes = await fetch(lawClassUrl, {
        method: 'GET',
        headers: { 
          Authorization: AUTH
        }
      });

      if (!lawClassRes.ok) {
        const errorText = await lawClassRes.text();
        throw new Error(`ClickHouse law class query failed: ${lawClassRes.status} ${errorText}`);
      }

      const lawClassRawData = await lawClassRes.json();
      lawClassData = lawClassRawData.data || lawClassRawData;
    }

    // Execute total query
    const totalUrl = `${CH_HTTP}/?query=${encodeURIComponent(totalQuery)}&default_format=JSON`;
    const totalRes = await fetch(totalUrl, {
      method: 'GET',
      headers: { 
        Authorization: AUTH
      }
    });

    if (!totalRes.ok) {
      const errorText = await totalRes.text();
      throw new Error(`ClickHouse total query failed: ${totalRes.status} ${errorText}`);
    }

    const totalRawData = await totalRes.json();
    const totalData = totalRawData.data || totalRawData;

    // Validate and format response
    if (!Array.isArray(offensesData)) {
      console.error('Offenses data is not an array:', offensesData);
      throw new Error(`Invalid offenses data format: expected array, got ${typeof offensesData}`);
    }

    if (!Array.isArray(totalData)) {
      console.error('Total data is not an array:', totalData);
      throw new Error(`Invalid total data format: expected array, got ${typeof totalData}`);
    }

    const response: FiltersResponse = {
      offenses: offensesData.map((row: any) => ({
        offense: row.offense || row[0], // Handle both object and array formats
        count: parseInt(row.count || row[1] || 0)
      })),
      totalOffenses: totalData[0]?.total_offenses || totalData[0]?.[0] || 0
    };

    // Add law classes for NYC
    if (city === 'nyc' && Array.isArray(lawClassData) && lawClassData.length > 0) {
      response.lawClasses = lawClassData.map((row: any) => ({
        lawClass: row.law_class || row[0],
        count: parseInt(row.count || row[1] || 0)
      }));
    }

    return response;

  } catch (error) {
    console.error('ClickHouse query error:', error);
    throw error;
  }
}

export async function GET(request: NextRequest) {
  try {
    const { searchParams } = new URL(request.url);
    const { city, from, to } = validateParams(searchParams);

    // If ClickHouse is not configured, return mock data
    if (!isClickHouseConfigured) {
      console.warn('ClickHouse not configured, returning mock data');
      const mockData: FiltersResponse = {
        offenses: [
          { offense: "GRAND LARCENY", count: 15420 },
          { offense: "ASSAULT 3 & RELATED OFFENSES", count: 12350 },
          { offense: "CRIMINAL MISCHIEF & RELATED OF", count: 8900 },
          { offense: "PETIT LARCENY", count: 7650 },
          { offense: "BURGLARY", count: 5430 },
          { offense: "ROBBERY", count: 4320 },
          { offense: "FELONY ASSAULT", count: 3210 },
          { offense: "VEHICLE AND TRAFFIC LAWS", count: 2890 },
          { offense: "THEFT OF SERVICES", count: 2340 },
          { offense: "HARASSMENT 2", count: 1980 }
        ],
        lawClasses: city === 'nyc' ? [
          { lawClass: "MISDEMEANOR", count: 45230 },
          { lawClass: "FELONY", count: 23450 },
          { lawClass: "VIOLATION", count: 12340 }
        ] : undefined,
        totalOffenses: 156
      };

      return NextResponse.json(mockData, {
        headers: {
          'Cache-Control': 'public, max-age=300', // 5 minutes for mock data
        }
      });
    }

    // Check cache first
    const cacheKey = `filters:${city}:${from}:${to}`;
    const cached = cache.get(cacheKey);
    
    if (cached && Date.now() - cached.timestamp < CACHE_TTL) {
      return NextResponse.json(cached.data, {
        headers: {
          'Cache-Control': 'public, max-age=1800', // 30 minutes
        }
      });
    }

    // Query ClickHouse
    const data = await queryFilters(city, from, to);

    // Cache the result
    cache.set(cacheKey, {
      data,
      timestamp: Date.now()
    });

    return NextResponse.json(data, {
      headers: {
        'Cache-Control': 'public, max-age=1800', // 30 minutes
      }
    });

  } catch (error: any) {
    console.error('Filters API error:', error);
    
    return NextResponse.json(
      { 
        error: 'Internal Server Error',
        message: error.message || 'Failed to fetch filters data'
      },
      { status: 500 }
    );
  }
}
