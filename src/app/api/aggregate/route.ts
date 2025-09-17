import { NextRequest } from "next/server";
import { z } from "zod";
import { buildShootingsURL, escapeSoqlString, fetchSocrata, toFloatingTimestamp, ShootingRow, buildShootingsURLCurrent, buildSFIncidentsURL, buildSFIncidentsLegacyURL, loadComplaintsRowsCombined } from "@/lib/socrata";
import { buildViolentSoqlCondition, parseViolenceParam } from "@/lib/categories";
import * as h3 from "h3-js";

const Query = z.object({
  bbox: z.string(), // minLon,minLat,maxLon,maxLat
  z: z.string(),
  start: z.string().optional(),
  end: z.string().optional(),
  ofns: z.string().optional(),
  law: z.string().optional(),
  vclass: z.string().optional(),
  includeUnknown: z.string().optional(), // "1" to include
  seq: z.string().optional(),
});

function h3ResForZoom(z: number): number {
  if (z <= 8) return 6;
  if (z <= 10) return 7;
  if (z <= 12) return 8;
  if (z <= 13) return 9;
  return 10;
}

export async function GET(req: NextRequest) {
  const tReq = Date.now();
  const p = Query.safeParse(Object.fromEntries(req.nextUrl.searchParams.entries()));
  if (!p.success) return new Response("Bad query", { status: 400 });
  const { bbox, z, ofns, law, vclass } = p.data;
  const includeUnknown = (p.data.includeUnknown || "0") === "1";
  const [minLonStr, minLatStr, maxLonStr, maxLatStr] = bbox.split(",");
  const minLon = Number(minLonStr), minLat = Number(minLatStr), maxLon = Number(maxLonStr), maxLat = Number(maxLatStr);
  const zNum = Number(z);
  if (![minLon, minLat, maxLon, maxLat].every(Number.isFinite) || !Number.isFinite(zNum)) {
    return new Response("Invalid bbox or z", { status: 400 });
  }
  const res = h3ResForZoom(zNum);
  const startISO = toFloatingTimestamp(p.data.start ? new Date(p.data.start) : new Date(Date.now() - 1000 * 60 * 60 * 24 * 365 * 4));
  const endISO = toFloatingTimestamp(p.data.end ? new Date(p.data.end) : new Date());
  const centerLon = (minLon + maxLon) / 2;
  const centerLat = (minLat + maxLat) / 2;
  const isSF = (lat: number, lon: number) => lat > 37.4 && lat < 38.2 && lon > -123.2 && lon < -122.0;

  try {
    console.log(`[agg][req][seq=${p.data.seq || '-'}]`, {
      bbox: `${minLon},${minLat},${maxLon},${maxLat}`,
      z: zNum,
      res,
      startISO,
      endISO,
      includeUnknown,
      ofns,
      law,
      vclass,
      city: isSF(centerLat, centerLon) ? 'sf' : 'nyc',
    });
  } catch {}

  const where: string[] = [
    `cmplnt_fr_dt >= '${startISO}'`,
    `cmplnt_fr_dt <= '${endISO}'`,
    `lat_lon IS NOT NULL`,
    // Socrata within_box: (min_lat, min_lon, max_lat, max_lon)
    `within_box(lat_lon, ${minLat}, ${minLon}, ${maxLat}, ${maxLon})`,
  ];
  if (!includeUnknown) {
    const notUnknown = (col: string) => `(${col} IS NOT NULL AND trim(${col}) <> '' AND upper(${col}) NOT IN ('UNKNOWN','(UNKNOWN)','(NULL)','NULL','U','N/A','NA','UNK','UNKN','NONE'))`;
    where.push(
      notUnknown("susp_race"),
      notUnknown("susp_age_group"),
      notUnknown("susp_sex"),
      notUnknown("vic_race"),
      notUnknown("vic_age_group"),
      notUnknown("vic_sex")
    );
  }
  // Apply violent/non-violent filter to complaints
  const vset = parseViolenceParam(vclass);
  const includesViolent = vset.has("violent");
  const includesNonviolent = vset.has("nonviolent");
  const violentCond = buildViolentSoqlCondition("ofns_desc");
  if (includesViolent && !includesNonviolent) {
    where.push(violentCond);
  } else if (!includesViolent && includesNonviolent) {
    where.push(`NOT (${violentCond})`);
  }
  if (ofns) {
    const values = ofns.split(",").map((v) => `'${escapeSoqlString(v.trim())}'`).join(",");
    where.push(`ofns_desc IN (${values})`);
  }
  if (law) {
    const values = law.split(",").map((v) => `'${escapeSoqlString(v.trim())}'`).join(",");
    where.push(`law_cat_cd IN (${values})`);
  }

  // Pull raw lat/long from both datasets; branch for SF vs NYC
  const useSF = isSF(centerLat, centerLon);
  let complaintsUrl: string | undefined;
  let complaintsUrlCur: string | undefined;
  let complaintsUrlLegacy: string | undefined;
  
  if (useSF) {
    // For SF, determine which APIs to use based on date range
    const startYear = Number(startISO.slice(0, 4));
    const endYear = Number(endISO.slice(0, 4));
    
    if (endYear < 2018) {
      // Use legacy API only (2003-2018)
      const yearConditions: string[] = [];
      for (let year = Math.max(2003, startYear); year <= Math.min(2017, endYear); year++) {
        yearConditions.push(`date_extract_y(date)=${year}`);
      }
      complaintsUrlLegacy = buildSFIncidentsLegacyURL({ where: [
        `(${yearConditions.join(' OR ')})`,
        `x IS NOT NULL AND y IS NOT NULL`,
        ...(ofns ? [`category IN (${ofns.split(",").map((v)=>`'${escapeSoqlString(v.trim())}'`).join(",")})`] : []),
      ], select: ["category", "x", "y"], limit: 50000 });
    } else if (startYear >= 2018) {
      // Use modern API only (2018-Present)
      const yearConditions: string[] = [];
      for (let year = Math.max(2018, startYear); year <= Math.min(2025, endYear); year++) {
        yearConditions.push(`incident_year='${year}'`);
      }
      complaintsUrl = buildSFIncidentsURL({ where: [
        `(${yearConditions.join(' OR ')})`,
        `latitude IS NOT NULL`,
        `longitude IS NOT NULL`,
        ...(ofns ? [`incident_category IN (${ofns.split(",").map((v)=>`'${escapeSoqlString(v.trim())}'`).join(",")})`] : []),
      ], select: ["incident_category", "latitude", "longitude"], limit: 50000 });
    } else {
      // Use both APIs for spans crossing 2018
      const modernYearConditions: string[] = [];
      for (let year = Math.max(2018, startYear); year <= Math.min(2025, endYear); year++) {
        modernYearConditions.push(`incident_year='${year}'`);
      }
      complaintsUrl = buildSFIncidentsURL({ where: [
        `(${modernYearConditions.join(' OR ')})`,
        `latitude IS NOT NULL`,
        `longitude IS NOT NULL`,
        ...(ofns ? [`incident_category IN (${ofns.split(",").map((v)=>`'${escapeSoqlString(v.trim())}'`).join(",")})`] : []),
      ], select: ["incident_category", "latitude", "longitude"], limit: 25000 });
      
      const legacyYearConditions: string[] = [];
      for (let year = Math.max(2003, startYear); year <= Math.min(2017, endYear); year++) {
        legacyYearConditions.push(`date_extract_y(date)=${year}`);
      }
      complaintsUrlLegacy = buildSFIncidentsLegacyURL({ where: [
        `(${legacyYearConditions.join(' OR ')})`,
        `x IS NOT NULL AND y IS NOT NULL`,
        ...(ofns ? [`category IN (${ofns.split(",").map((v)=>`'${escapeSoqlString(v.trim())}'`).join(",")})`] : []),
      ], select: ["category", "x", "y"], limit: 25000 });
    }
  } else {
    // NYC: use canonical combined row loader so aggregates match sidebar stats exactly
    complaintsUrl = undefined;
    complaintsUrlCur = undefined;
  }
  
  // Build shooting query
  const shootingWhere: string[] = [
    `occur_date >= '${startISO}'`,
    `occur_date <= '${endISO}'`,
    `geocoded_column IS NOT NULL`,
    `within_box(geocoded_column, ${minLat}, ${minLon}, ${maxLat}, ${maxLon})`,
  ];
  if (!includeUnknown) {
    const notUnknown = (col: string) => `(${col} IS NOT NULL AND trim(${col}) <> '' AND upper(${col}) NOT IN ('UNKNOWN','(UNKNOWN)','(NULL)','NULL','U','N/A','NA','UNK','UNKN','NONE'))`;
    shootingWhere.push(
      notUnknown("perp_race"),
      notUnknown("perp_age_group"),
      notUnknown("vic_race"),
      notUnknown("vic_age_group"),
      notUnknown("perp_sex"),
      notUnknown("vic_sex")
    );
  }

  // Apply offense type filters to shooting data
  if (ofns) {
    const selectedOffenses = ofns.split(",").map(v => v.trim());
    const includesMurder = selectedOffenses.includes("MURDER & NON-NEGL. MANSLAUGHTER");
    const includesShootings = selectedOffenses.includes("SHOOTING INCIDENT");
    
    if (!includesMurder && !includesShootings) {
      // Skip shooting data entirely
      shootingWhere.push("1 = 0");
    } else if (includesMurder && !includesShootings) {
      // Only fetch murders
      shootingWhere.push("statistical_murder_flag = true");
    } else if (!includesMurder && includesShootings) {
      // Only fetch non-murders
      shootingWhere.push("statistical_murder_flag = false");
    }
  }

  // Apply law category filters to shooting data
  if (law) {
    const selectedLawCats = law.split(",").map(v => v.trim());
    if (!selectedLawCats.includes("FELONY")) {
      shootingWhere.push("1 = 0");
    }
  }
  // Apply violent class to shootings: if violent not included, skip entirely
  if (!includesViolent) {
    shootingWhere.push("1 = 0");
  }
  
  const shootingsUrl = buildShootingsURL({ where: shootingWhere, select: ["geocoded_column", "latitude", "longitude"], limit: 10000 });
  const shootingsUrlCur = buildShootingsURLCurrent({ where: shootingWhere, select: ["geocoded_column", "latitude", "longitude"], limit: 10000 });

  try {
    // Micro-cache key: quantized bbox + z + filters
    const q = (n: number) => Math.round(n * 10000) / 10000;
    const cacheKey = `agg|${q(minLon)}|${q(minLat)}|${q(maxLon)}|${q(maxLat)}|z:${zNum}|${startISO}|${endISO}|${includeUnknown?'1':'0'}|${ofns||''}|${law||''}|${vclass||''}`;
    try {
      const cache = (globalThis as any).__aggCache as Map<string, { expiresAt: number; data: any }> || new Map();
      (globalThis as any).__aggCache = cache;
      const cached = cache.get(cacheKey);
      if (cached && cached.expiresAt > Date.now()) {
        return Response.json(cached.data, { headers: { "Cache-Control": "public, s-maxage=10" } });
      }
    } catch {}

    const tFetchStart = Date.now();
    // Fetch datasets; tolerate partial failures
    const tasks: Promise<any[]>[] = [];
    let taskIndex = 0;
    
    // Add complaints tasks with shorter cache for better responsiveness
    if (useSF) {
      if (complaintsUrl) { tasks.push(fetchSocrata<any[]>(complaintsUrl + "&$limit=100000", 5)); taskIndex++; }
      if (complaintsUrlCur) { tasks.push(fetchSocrata<any[]>(complaintsUrlCur + "&$limit=100000", 5)); taskIndex++; }
      if (complaintsUrlLegacy) { tasks.push(fetchSocrata<any[]>(complaintsUrlLegacy + "&$limit=100000", 5)); taskIndex++; }
    } else {
      // NYC complaints rows (historic + YTD) via shared loader
      const nycComplaintsPromise = loadComplaintsRowsCombined(where, 10000, `agg-complaints|${minLon}|${minLat}|${maxLon}|${maxLat}|${startISO}|${endISO}|${includeUnknown?'1':'0'}|${ofns||''}|${law||''}|${vclass||''}`);
      tasks.push(nycComplaintsPromise);
      taskIndex++;
    }
    
    // Add shooting tasks (only for NYC)
    const shootingStartIndex = taskIndex;
    if (!useSF) {
      tasks.push(fetchSocrata<ShootingRow[]>(shootingsUrl + "&$limit=10000"));
      tasks.push(fetchSocrata<ShootingRow[]>(shootingsUrlCur + "&$limit=10000"));
    }
    
    const settled = await Promise.allSettled(tasks);
    const tFetchEnd = Date.now();
    try {
      console.log(
        `[agg][fetch][seq=${p.data.seq || '-'}] done`,
        {
          complaintsTasks: !!complaintsUrl || !!complaintsUrlCur || !!complaintsUrlLegacy,
          shootingsTasks: !useSF,
          fetchMs: tFetchEnd - tFetchStart,
          z: zNum,
          bbox: `${minLon},${minLat},${maxLon},${maxLat}`,
        }
      );
    } catch {}
    const getOk = (i: number): any[] => (settled[i] && settled[i].status === "fulfilled" ? (settled[i] as any).value : []);
    
    // Combine complaints data from all sources
    let complaintsRows: any[] = [];
    let currentIndex = 0;
    if (useSF) {
      if (complaintsUrl) complaintsRows.push(...getOk(currentIndex++));
      if (complaintsUrlCur) complaintsRows.push(...getOk(currentIndex++));
      if (complaintsUrlLegacy) complaintsRows.push(...getOk(currentIndex++));
    } else {
      complaintsRows = getOk(currentIndex++);
    }
    
    const shootingRows = useSF ? [] : [...getOk(shootingStartIndex), ...getOk(shootingStartIndex + 1)];

    const counts = new Map<string, number>();
    
    // Helper to normalize lat/lon from various shapes
    const extract = (r: any): { lat: number; lon: number } | null => {
      let lat: any = r.latitude || r.y; // SF legacy uses 'y' for latitude
      let lon: any = r.longitude || r.x; // SF legacy uses 'x' for longitude
      if ((!lat || !lon) && r.lat_lon) {
        if (typeof r.lat_lon === "string") {
          const m = r.lat_lon.match(/(-?\d+\.\d+)\s+[ ,]\s*(-?\d+\.\d+)/);
          if (m) {
            const a = Number(m[1]);
            const b = Number(m[2]);
            if (Math.abs(a) <= 90 && Math.abs(b) <= 180) {
              lat = a; lon = b;
            } else {
              lat = b; lon = a;
            }
          }
        } else if (typeof r.lat_lon === "object") {
          lat = r.lat_lon.latitude;
          lon = r.lat_lon.longitude;
        }
      }
      if ((!lat || !lon) && r.point) {
        if (typeof r.point === "string") {
          const m = r.point.match(/(-?\d+\.?\d*)\s*[ ,]\s*(-?\d+\.?\d*)/);
          if (m) {
            const a = Number(m[1]);
            const b = Number(m[2]);
            if (Math.abs(a) <= 90 && Math.abs(b) <= 180) { lon = a; lat = b; } else { lon = b; lat = a; }
          }
        }
      }
      const nlat = Number(lat);
      const nlon = Number(lon);
      if (!Number.isFinite(nlat) || !Number.isFinite(nlon)) return null;
      return { lat: nlat, lon: nlon };
    };

    // Process complaints data
    for (const r of complaintsRows) {
      if (!includeUnknown) {
        const d = (r as any).ofns_desc;
        if (!d || String(d).toUpperCase() === "UNKNOWN") continue;
      }
      const p = extract(r);
      if (!p) continue;
      const cell = h3.latLngToCell(p.lat, p.lon, res);
      counts.set(cell, (counts.get(cell) || 0) + 1);
    }

    // Process shooting data with fallback parsing from geocoded_column
    const parseShootLatLon = (r: any): { lat: number; lon: number } | null => {
      let lat: any = r.latitude;
      let lon: any = r.longitude;
      if ((!lat || !lon) && r.geocoded_column) {
        if (typeof r.geocoded_column === "string") {
          const m = r.geocoded_column.match(/(-?\d+\.?\d*)\s*[ ,]\s*(-?\d+\.?\d*)/);
          if (m) {
            const a = Number(m[1]);
            const b = Number(m[2]);
            if (Math.abs(a) <= 90 && Math.abs(b) <= 180) { lat = a; lon = b; } else { lat = b; lon = a; }
          }
        } else if (typeof r.geocoded_column === "object" && Array.isArray((r.geocoded_column as any).coordinates)) {
          const coords = (r.geocoded_column as any).coordinates;
          lon = coords[0];
          lat = coords[1];
        }
      }
      const nlat = Number(lat);
      const nlon = Number(lon);
      if (!Number.isFinite(nlat) || !Number.isFinite(nlon)) return null;
      return { lat: nlat, lon: nlon };
    };
    for (const r of shootingRows) {
      const p = parseShootLatLon(r);
      if (!p) continue;
      const cell = h3.latLngToCell(p.lat, p.lon, res);
      counts.set(cell, (counts.get(cell) || 0) + 1);
    }
    const features = Array.from(counts.entries()).map(([cell, count]) => {
      const boundaryLatLng = h3.cellToBoundary(cell, true);
      if (boundaryLatLng && Array.isArray(boundaryLatLng) && boundaryLatLng.length) {
        // Convert [lat, lng] pairs from h3-js to GeoJSON [lng, lat] and close the ring
        const boundaryLngLat = boundaryLatLng.map((p: any) => [p[1], p[0]]);
        if (boundaryLngLat.length && (boundaryLngLat[0][0] !== boundaryLngLat[boundaryLngLat.length - 1][0] || boundaryLngLat[0][1] !== boundaryLngLat[boundaryLngLat.length - 1][1])) {
          boundaryLngLat.push([boundaryLngLat[0][0], boundaryLngLat[0][1]]);
        }
        return {
          type: "Feature",
          geometry: { type: "Polygon", coordinates: [boundaryLngLat] as any },
          properties: { count },
        } as const;
      }
      const centerLatLng = h3.cellToLatLng(cell); // [lat, lng]
      return {
        type: "Feature",
        geometry: { type: "Point", coordinates: [centerLatLng[1], centerLatLng[0]] as any },
        properties: { count },
      } as const;
    });
    const fc = { type: "FeatureCollection", features } as const;
    try {
      const cache = (globalThis as any).__aggCache as Map<string, { expiresAt: number; data: any }> || new Map();
      (globalThis as any).__aggCache = cache;
      cache.set(cacheKey, { expiresAt: Date.now() + 10000, data: fc });
    } catch {}
    const tDone = Date.now();
    const serverTiming = [
      `fetch;dur=${tFetchEnd - tFetchStart}`,
      `process;dur=${tDone - tFetchEnd}`,
      `total;dur=${tDone - tReq}`,
    ].join(", ");
    return Response.json(fc, { headers: { "Cache-Control": "no-store, max-age=0, must-revalidate", "Server-Timing": serverTiming, "X-Agg-Seq": p.data.seq || '' } });
  } catch (e: any) {
    console.error("/api/aggregate error:", e?.message);
    // Degrade gracefully: return an empty collection rather than a 500 so the UI keeps rendering
    return Response.json({ type: "FeatureCollection", features: [] }, { headers: { "Cache-Control": "no-store, max-age=0, must-revalidate" } });
  }
}


