// Test spatial lookup with known good coordinates
// GET /api/spatial/test-lookup

import { NextResponse } from 'next/server';
import { lookupPoint, initializeSpatialIndex, isSpatialIndexReady } from '@/lib/spatial-service';
import { cellToLatLng } from 'h3-js';

export async function GET(request: Request) {
  try {
    const { searchParams } = new URL(request.url);
    const testH3 = searchParams.get('h3') || '89f05ab4537ffff'; // Default to Times Square H3 cell
    
    // Ensure spatial index is initialized
    if (!isSpatialIndexReady()) {
      initializeSpatialIndex();
    }

    // Use the specified H3 cell and convert it back to coordinates
    // Note: cellToLatLng actually returns [lng, lat] despite the name
    const [lon, lat] = cellToLatLng(testH3);
    
    // Now test lookup with these coordinates
    const result = lookupPoint('nyc', lat, lon);
    
    return NextResponse.json({
      knownH3Cell: testH3,
      coordinates: { lat, lon },
      lookupResult: result,
      success: result.regionId !== null
    });

  } catch (error) {
    console.error('Test lookup error:', error);
    return NextResponse.json({
      error: 'Test lookup failed',
      message: error instanceof Error ? error.message : 'Unknown error'
    }, { status: 500 });
  }
}
