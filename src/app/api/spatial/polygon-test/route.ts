// Test polygon to H3 conversion
// GET /api/spatial/polygon-test

import { NextResponse } from 'next/server';
import { polygonToCells, latLngToCell } from 'h3-js';
import { readFileSync } from 'fs';
import { join } from 'path';

export async function GET() {
  try {
    // Load NYC GeoJSON
    const fullPath = join(process.cwd(), 'public/nyc_nta_2020.geojson');
    const data = readFileSync(fullPath, 'utf-8');
    const geojson = JSON.parse(data);
    
    // Find Times Square feature
    const timesSquareFeature = geojson.features.find((f: any) => 
      f.properties.NTA2020 === 'MN0502'
    );
    
    if (!timesSquareFeature) {
      return NextResponse.json({ error: 'Times Square feature not found' });
    }
    
    // Get the first polygon coordinates
    const geometry = timesSquareFeature.geometry;
    let coordinates;
    
    if (geometry.type === 'Polygon') {
      coordinates = geometry.coordinates[0]; // Outer ring
    } else if (geometry.type === 'MultiPolygon') {
      coordinates = geometry.coordinates[0][0]; // First polygon, outer ring
    } else {
      return NextResponse.json({ error: 'Unsupported geometry type' });
    }
    
    // Test a few coordinate points
    const sampleCoords = coordinates.slice(0, 5);
    const coordTests = sampleCoords.map((coord: [number, number]) => {
      const [lon, lat] = coord; // GeoJSON is [lon, lat]
      const h3Index = latLngToCell(lat, lon, 9);
      return { lon, lat, h3Index };
    });
    
    // Try polygon filling
    let h3Cells: string[] = [];
    try {
      h3Cells = polygonToCells(coordinates, 9);
    } catch (error) {
      return NextResponse.json({
        error: 'Polygon filling failed',
        message: error instanceof Error ? error.message : 'Unknown error',
        coordinates: coordinates.slice(0, 3), // Show first 3 coordinates
        coordTests
      });
    }
    
    return NextResponse.json({
      featureName: timesSquareFeature.properties.NTAName,
      geometryType: geometry.type,
      coordinateCount: coordinates.length,
      sampleCoordinates: coordinates.slice(0, 3),
      coordTests,
      h3CellCount: h3Cells.length,
      sampleH3Cells: h3Cells.slice(0, 10),
      containsExpected: h3Cells.includes('89f05ab4537ffff')
    });

  } catch (error) {
    console.error('Polygon test error:', error);
    return NextResponse.json({
      error: 'Polygon test failed',
      message: error instanceof Error ? error.message : 'Unknown error'
    }, { status: 500 });
  }
}
