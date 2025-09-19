// API endpoint to manually initialize spatial index
// GET /api/spatial/init

import { NextResponse } from 'next/server';
import { initializeSpatialIndex, getSpatialIndexStats, resetSpatialIndex } from '@/lib/spatial-service';

export async function GET() {
  try {
    console.log('Manual spatial index initialization requested...');
    
    // Reset first to ensure clean initialization
    resetSpatialIndex();
    initializeSpatialIndex();
    
    const stats = getSpatialIndexStats();
    
    return NextResponse.json({
      success: true,
      message: 'Spatial index initialized successfully',
      stats,
    });

  } catch (error) {
    console.error('Manual spatial initialization failed:', error);
    return NextResponse.json({
      success: false,
      error: 'Failed to initialize spatial index',
      message: error instanceof Error ? error.message : 'Unknown error'
    }, { status: 500 });
  }
}
