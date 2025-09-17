import { NextRequest } from "next/server";
import type { FeatureCollection, GeoJsonProperties, Geometry } from "geojson";

// Simple in-memory cache to avoid hammering upstream for identical requests
type CacheEntry = { expiresAt: number; data: FeatureCollection<Geometry, GeoJsonProperties> };
const CACHE_TTL_MS = 1000 * 60 * 60; // 1 hour

declare global { var __neighborhoodsCache: Map<string, CacheEntry> | undefined }
function getCache(): Map<string, CacheEntry> {
  if (!globalThis.__neighborhoodsCache) globalThis.__neighborhoodsCache = new Map<string, CacheEntry>();
  return globalThis.__neighborhoodsCache as Map<string, CacheEntry>;
}

async function fetchJson(url: string): Promise<FeatureCollection<Geometry, GeoJsonProperties>> {
  const headers: Record<string, string> = { Accept: "application/json" };
  try {
    const host = new URL(url).host.toLowerCase();
    if (host.includes("data.cityofnewyork.us")) {
      const token = process.env.NYC_OPENDATA_APP_TOKEN;
      if (token) headers["X-App-Token"] = token;
    }
  } catch {}
  const res = await fetch(url, { headers, cache: "no-store", next: { revalidate: 0 } });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`Upstream error ${res.status}: ${text}`);
  }
  return res.json();
}

async function loadNYCNeighborhoods(): Promise<FeatureCollection<Geometry, GeoJsonProperties>> {
  // NYC NTA (Neighborhood Tabulation Areas) — GeoJSON endpoint
  const candidates = [
    "https://data.cityofnewyork.us/resource/cpf4-rkhq.geojson?$limit=50000",
  ];
  let lastErr: unknown = null;
  for (const url of candidates) {
    try {
      const json = await fetchJson(url);
      if (json && (json.type === "FeatureCollection" || Array.isArray(json.features))) {
        return json;
      }
    } catch (e) {
      lastErr = e;
    }
  }
  throw (lastErr instanceof Error ? lastErr : new Error("Failed to load NYC neighborhoods"));
}

export async function GET(req: NextRequest) {
  try {
    const url = req.nextUrl;
    const city = (url.searchParams.get("city") || "nyc").toLowerCase();
    const cacheKey = `city:${city}`;
    const cache = getCache();
    const now = Date.now();
    const cached = cache.get(cacheKey);
    if (cached && cached.expiresAt > now) {
      return Response.json(cached.data, {
        headers: { "Cache-Control": "public, s-maxage=3600" },
      });
    }

    let data: FeatureCollection<Geometry, GeoJsonProperties>;
    switch (city) {
      case "nyc":
        data = await loadNYCNeighborhoods();
        break;
      default:
        // For unsupported cities, return an empty FeatureCollection
        data = { type: "FeatureCollection", features: [] } as FeatureCollection<Geometry, GeoJsonProperties>;
        break;
    }

    cache.set(cacheKey, { expiresAt: now + CACHE_TTL_MS, data });
    return Response.json(data, {
      headers: { "Cache-Control": "public, s-maxage=3600" },
    });
  } catch (e: unknown) {
    console.error("/api/neighborhoods error:", e instanceof Error ? e.message : e);
    return new Response("Neighborhoods error: " + (e instanceof Error ? e.message : String(e)), { status: 500 });
  }
}


