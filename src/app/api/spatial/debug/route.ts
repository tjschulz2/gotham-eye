// Debug endpoint for spatial indexing
// GET /api/spatial/debug

import { NextResponse } from 'next/server';
import { getCityIndex, initializeSpatialIndex, isSpatialIndexReady } from '@/lib/spatial-service';
import { latLngToCell } from 'h3-js';

export async function GET(request: Request) {
  try {
    const { searchParams } = new URL(request.url);
    const testLat = parseFloat(searchParams.get('testLat') || '40.7589');
    const testLon = parseFloat(searchParams.get('testLon') || '-73.9851');

    // Ensure spatial index is initialized
    if (!isSpatialIndexReady()) {
      initializeSpatialIndex();
    }

    // Get NYC index
    const nycIndex = getCityIndex('nyc');
    if (!nycIndex) {
      return NextResponse.json({ error: 'NYC index not found after initialization' });
    }

    // Convert test coordinates to H3
    const h3Index = latLngToCell(testLat, testLon, 9);
    
    // Get a sample of H3 cells from the index
    const h3Cells = Object.keys(nycIndex.h3ToRegionMap).slice(0, 10);
    
    // Check if our test H3 cell exists in the mapping
    const hasTestCell = nycIndex.h3ToRegionMap.hasOwnProperty(h3Index);
    
    // Find cells that start with the same prefix as our test cell
    const testPrefix = h3Index.substring(0, 6);
    const similarCells = Object.keys(nycIndex.h3ToRegionMap)
      .filter(cell => cell.startsWith(testPrefix))
      .slice(0, 5);
    
    // Look for Manhattan regions (MN prefix)
    const allRegions = Array.from(nycIndex.regionMeta.keys());
    const manhattanRegions = allRegions.filter(id => id.startsWith('MN')).slice(0, 10);
    
    // Find H3 cells for Manhattan regions
    const manhattanCells = Object.entries(nycIndex.h3ToRegionMap)
      .filter(([, regionId]) => regionId.startsWith('MN'))
      .slice(0, 10);
    
    // Check if Times Square region exists
    const timesSquareRegion = nycIndex.regionMeta.get('MN0502');
    const hasTimesSquare = !!timesSquareRegion;
    
    // Find H3 cells for Times Square if it exists
    const timesSquareCells = Object.entries(nycIndex.h3ToRegionMap)
      .filter(([, regionId]) => regionId === 'MN0502')
      .slice(0, 5);

    return NextResponse.json({
      testCoordinates: { lat: testLat, lon: testLon },
      testH3Index: h3Index,
      hasTestCell,
      testPrefix,
      sampleH3Cells: h3Cells,
      similarCells,
      manhattanRegions,
      manhattanCells: manhattanCells.map(([cell, regionId]) => ({
        h3: cell,
        regionId
      })),
      // Times Square specific info
      hasTimesSquare,
      timesSquareRegion: timesSquareRegion ? {
        regionId: timesSquareRegion.regionId,
        regionName: timesSquareRegion.regionName
      } : null,
      timesSquareCells: timesSquareCells.map(([cell, regionId]) => ({
        h3: cell,
        regionId
      })),
      totalH3Cells: Object.keys(nycIndex.h3ToRegionMap).length,
      sampleMappings: h3Cells.map(cell => ({
        h3: cell,
        regionId: nycIndex.h3ToRegionMap[cell]
      }))
    });

  } catch (error) {
    console.error('Debug endpoint error:', error);
    return NextResponse.json({
      error: 'Debug failed',
      message: error instanceof Error ? error.message : 'Unknown error'
    }, { status: 500 });
  }
}
