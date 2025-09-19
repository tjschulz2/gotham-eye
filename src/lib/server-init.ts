// Server initialization - runs once at startup
// Initializes spatial index and other server-side resources

import { initializeSpatialIndex, getSpatialIndexStats } from './spatial-service';

let isServerInitialized = false;

/**
 * Initialize server resources
 * Call this once at server startup (e.g., in middleware or API route)
 */
export async function initializeServer(): Promise<void> {
  if (isServerInitialized) {
    return;
  }

  console.log('🚀 Initializing server resources...');
  const startTime = Date.now();

  try {
    // Initialize spatial index
    initializeSpatialIndex();
    
    // Log initialization stats
    const spatialStats = getSpatialIndexStats();
    console.log('✅ Spatial index ready:', spatialStats);
    
    isServerInitialized = true;
    const duration = Date.now() - startTime;
    console.log(`🎉 Server initialization complete in ${duration}ms`);
    
  } catch (error) {
    console.error('❌ Server initialization failed:', error);
    throw error;
  }
}

/**
 * Check if server is initialized
 */
export function isServerReady(): boolean {
  return isServerInitialized;
}

/**
 * Middleware to ensure server is initialized
 */
export async function ensureServerInitialized(): Promise<void> {
  if (!isServerInitialized) {
    await initializeServer();
  }
}
