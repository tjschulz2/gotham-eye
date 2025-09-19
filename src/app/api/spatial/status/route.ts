// API endpoint to check spatial index status
// GET /api/spatial/status

import { NextResponse } from 'next/server';
import { 
  isSpatialIndexReady, 
  getSpatialIndexStats, 
  lookupPoint,
  getCityRegions,
  initializeSpatialIndex
} from '@/lib/spatial-service';
import type { CityId } from '@/lib/city-config';

export async function GET(request: Request) {
  try {
    const { searchParams } = new URL(request.url);
    const testCity = searchParams.get('testCity') as CityId;
    const testLat = searchParams.get('testLat');
    const testLon = searchParams.get('testLon');

    let isReady = isSpatialIndexReady();
    
    // Try to initialize if not ready
    if (!isReady) {
      try {
        console.log('Spatial index not ready, initializing...');
        initializeSpatialIndex();
        isReady = isSpatialIndexReady();
      } catch (error) {
        console.error('Failed to initialize spatial index:', error);
        return NextResponse.json({
          ready: false,
          message: 'Failed to initialize spatial index',
          error: error instanceof Error ? error.message : 'Unknown error'
        }, { status: 503 });
      }
    }
    
    if (!isReady) {
      return NextResponse.json({
        ready: false,
        message: 'Spatial index initialization failed'
      }, { status: 503 });
    }

    const stats = getSpatialIndexStats();
    
    // Optional test lookup
    let testResult = null;
    if (testCity && testLat && testLon) {
      const lat = parseFloat(testLat);
      const lon = parseFloat(testLon);
      
      if (!isNaN(lat) && !isNaN(lon)) {
        testResult = lookupPoint(testCity, lat, lon);
      }
    }

    // Optional region list
    let regions = null;
    if (testCity) {
      regions = getCityRegions(testCity).map(r => ({
        regionId: r.regionId,
        regionName: r.regionName,
      }));
    }

    return NextResponse.json({
      ready: true,
      stats,
      testResult,
      regions: regions?.slice(0, 10), // Limit to first 10 for brevity
      totalRegions: regions?.length,
    });

  } catch (error) {
    console.error('Error in spatial status endpoint:', error);
    return NextResponse.json({
      error: 'Failed to get spatial status',
      message: error instanceof Error ? error.message : 'Unknown error'
    }, { status: 500 });
  }
}
