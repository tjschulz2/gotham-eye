// Test H3 coordinate conversion
// GET /api/spatial/h3-test

import { NextResponse } from 'next/server';
import { latLngToCell, cellToLatLng } from 'h3-js';

export async function GET(request: Request) {
  try {
    const { searchParams } = new URL(request.url);
    const testLat = parseFloat(searchParams.get('testLat') || '40.7589');
    const testLon = parseFloat(searchParams.get('testLon') || '-73.9851');

    // Convert coordinates to H3 and back
    const h3Index = latLngToCell(testLat, testLon, 9);
    const [convertedLat, convertedLon] = cellToLatLng(h3Index);
    
    // Test with a known Times Square H3 cell
    const knownTimesSquareH3 = '89f05ab4537ffff';
    const [knownLat, knownLon] = cellToLatLng(knownTimesSquareH3);
    const backToH3 = latLngToCell(knownLat, knownLon, 9);
    
    return NextResponse.json({
      original: { lat: testLat, lon: testLon },
      h3Index,
      converted: { lat: convertedLat, lon: convertedLon },
      roundTripMatch: h3Index === latLngToCell(convertedLat, convertedLon, 9),
      
      knownTimesSquare: {
        h3: knownTimesSquareH3,
        coordinates: { lat: knownLat, lon: knownLon },
        backToH3,
        roundTripMatch: knownTimesSquareH3 === backToH3
      }
    });

  } catch (error) {
    console.error('H3 test error:', error);
    return NextResponse.json({
      error: 'H3 test failed',
      message: error instanceof Error ? error.message : 'Unknown error'
    }, { status: 500 });
  }
}
