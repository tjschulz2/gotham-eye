import { NextRequest } from "next/server";
import { z } from "zod";
import { buildComplaintsURL, buildShootingsURL, escapeSoqlString, fetchSocrata, fetchSocrataAll, toFloatingTimestamp, ShootingRow, buildComplaintsURLCurrent, buildShootingsURLCurrent, mergeAggregateRows, loadComplaintsRowsCombined, loadShootingsRowsCombined, buildSFIncidentsURL, buildSFIncidentsLegacyURL } from "@/lib/socrata";
import { buildViolentSoqlCondition, parseViolenceParam } from "@/lib/categories";
import fs from "fs/promises";
import path from "path";

const QuerySchema = z.object({
  city: z.string().optional(),
  bbox: z.string().optional(), // "minLon,minLat,maxLon,maxLat" (optional when poly is provided)
  poly: z.string().optional(), // GeoJSON Polygon/MultiPolygon as JSON string
  start: z.string().optional(),
  end: z.string().optional(),
  ofns: z.string().optional(),
  law: z.string().optional(),
  vclass: z.string().optional(),
  includeUnknown: z.string().optional(), // "1" to include
  seq: z.string().optional(),
});

export async function GET(req: NextRequest) {
  const tReq = Date.now();
  const parsed = QuerySchema.safeParse(Object.fromEntries(req.nextUrl.searchParams.entries()));
  if (!parsed.success) return new Response("Bad query", { status: 400 });
  const { bbox, poly: polyStr, ofns, law, vclass } = parsed.data;
  const cityParam = (parsed.data.city || '').toString().toLowerCase();
  const includeUnknown = (parsed.data.includeUnknown || "0") === "1";
  // Parse bbox if provided (NYC format: lon,lat,lon,lat; SF sometimes lat,lon)
  let minLon: number | undefined, minLat: number | undefined, maxLon: number | undefined, maxLat: number | undefined;
  const hasBBox = typeof bbox === 'string' && bbox.length > 0;
  const hasPoly = typeof polyStr === 'string' && polyStr.length > 0;
  if (hasBBox) {
    const bboxParts = (bbox as string).split(",");
    const firstNum = Number(bboxParts[0]);
    const secondNum = Number(bboxParts[1]);
    if (firstNum > 30 && firstNum < 50 && secondNum < -100) {
      const [minLatStr, minLonStr, maxLatStr, maxLonStr] = bboxParts;
      minLat = Number(minLatStr);
      minLon = Number(minLonStr);
      maxLat = Number(maxLatStr);
      maxLon = Number(maxLonStr);
    } else {
      const [minLonStr, minLatStr, maxLonStr, maxLatStr] = bboxParts;
      minLon = Number(minLonStr);
      minLat = Number(minLatStr);
      maxLon = Number(maxLonStr);
      maxLat = Number(maxLatStr);
    }
    if (![minLon, minLat, maxLon, maxLat].every((n) => Number.isFinite(n))) return new Response("Bad bbox", { status: 400 });
  }

  // Parse optional polygon (GeoJSON Polygon/MultiPolygon)
  let polyGeo: any | null = null;
  if (hasPoly) {
    try { polyGeo = JSON.parse(polyStr as string); } catch {}
  }

  const centerLon = hasBBox ? (((minLon as number) + (maxLon as number)) / 2) : -73.97; // NYC default
  const centerLat = hasBBox ? (((minLat as number) + (maxLat as number)) / 2) : 40.75;
  const isSF = (lat: number, lon: number) => lat > 37.4 && lat < 38.2 && lon > -123.2 && lon < -122.0;
  const isSFRequest = cityParam === 'sf' || (cityParam !== 'nyc' && isSF(centerLat, centerLon));
  

  const startISO = toFloatingTimestamp(parsed.data.start ? new Date(parsed.data.start) : new Date(Date.now() - 1000 * 60 * 60 * 24 * 365 * 4));
  const endISO = toFloatingTimestamp(parsed.data.end ? new Date(parsed.data.end) : new Date());

  // If explicitly requested or viewport is over San Francisco, use SFPD Incident Reports datasets (no demographics available)
  if (isSFRequest) {
    try {
      const tFetchStart = Date.now();
      
      // Extract years from ISO dates for SF filtering
      const startYear = Number(startISO.slice(0, 4));
      const endYear = Number(endISO.slice(0, 4));
      
      console.log(`[SF] Requested range: ${startYear}-${endYear}`);
      
      let allRows: any[] = [];
      
      // Determine which APIs to use based on year range
      const needsLegacy = startYear <= 2017; // 2003-2018 API for years <= 2017
      const needsModern = endYear >= 2018;   // 2018-Present API for years >= 2018
      
      // Fetch from legacy API (2003-2018) if needed
      if (needsLegacy) {
        const legacyStartYear = Math.max(2003, startYear);
        const legacyEndYear = Math.min(2017, endYear);
        
        console.log(`[SF Legacy] Fetching ${legacyStartYear}-${legacyEndYear}`);
        
        // Build year conditions for legacy API
        const yearConditions: string[] = [];
        for (let year = legacyStartYear; year <= legacyEndYear; year++) {
          yearConditions.push(`date_extract_y(date)=${year}`);
        }
        
        const whereLegacy: string[] = [`(${yearConditions.join(' OR ')})`];
        
        // Add violence filtering
        const vsetLegacy = parseViolenceParam(vclass);
        const includesViolentLegacy = vsetLegacy.has("violent");
        const includesNonviolentLegacy = vsetLegacy.has("nonviolent");
        const violentCondLegacy = buildViolentSoqlCondition("category");
        if (includesViolentLegacy && !includesNonviolentLegacy) whereLegacy.push(violentCondLegacy);
        else if (!includesViolentLegacy && includesNonviolentLegacy) whereLegacy.push(`NOT (${violentCondLegacy})`);
        
        // Add offense filtering
        if (ofns) {
          const values = ofns.split(",").map((v) => `'${escapeSoqlString(v.trim())}'`).join(",");
          whereLegacy.push(`category IN (${values})`);
        }
        
        const legacyURL = buildSFIncidentsLegacyURL({ 
          where: whereLegacy, 
          select: ["incidntnum", "date", "category", "pddistrict", "x", "y"], 
          order: "date DESC" 
        });
        
        try {
          // Fetch data in chunks to avoid stack overflow
          let offset = 0;
          const chunkSize = 50000;
          let totalFetched = 0;
          
          while (true) {
            const chunkURL = legacyURL + `&$limit=${chunkSize}&$offset=${offset}`;
            const chunkRows = await fetchSocrata<any[]>(chunkURL, 5); // Shorter cache for responsiveness
            
            if (!chunkRows || chunkRows.length === 0) break;
            
            // Normalize legacy data
            for (const r of chunkRows) {
              allRows.push({
                incident_id: r.incidntnum,
                incident_datetime: r.date,
                incident_category: r.category,
                analysis_neighborhood: r.pddistrict,
                police_district: r.pddistrict,
                latitude: r.y,
                longitude: r.x
              });
            }
            
            totalFetched += chunkRows.length;
            offset += chunkSize;
            
            // If we got less than chunk size, we're done
            if (chunkRows.length < chunkSize) break;
            
            // Safety limit to prevent infinite loops
            if (totalFetched > 1000000) break;
          }
          
          console.log(`[SF Legacy] Fetched ${totalFetched} rows total`);
        } catch (legacyError: any) {
          console.error(`[SF Legacy] Error:`, legacyError?.message || legacyError);
        }
      }
      
      // Fetch from modern API (2018-Present) if needed
      if (needsModern) {
        const modernStartYear = Math.max(2018, startYear);
        const modernEndYear = Math.min(2025, endYear);
        
        console.log(`[SF Modern] Fetching ${modernStartYear}-${modernEndYear}`);
        
        // Build year conditions for modern API
        const yearConditions: string[] = [];
        for (let year = modernStartYear; year <= modernEndYear; year++) {
          yearConditions.push(`incident_year='${year}'`);
        }
        
        const whereModern: string[] = [`(${yearConditions.join(' OR ')})`];
        
        // Add violence filtering
        const vsetModern = parseViolenceParam(vclass);
        const includesViolentModern = vsetModern.has("violent");
        const includesNonviolentModern = vsetModern.has("nonviolent");
        const violentCondModern = buildViolentSoqlCondition("incident_category");
        if (includesViolentModern && !includesNonviolentModern) whereModern.push(violentCondModern);
        else if (!includesViolentModern && includesNonviolentModern) whereModern.push(`NOT (${violentCondModern})`);
        
        // Add offense filtering
        if (ofns) {
          const values = ofns.split(",").map((v) => `'${escapeSoqlString(v.trim())}'`).join(",");
          whereModern.push(`incident_category IN (${values})`);
        }
        
        const modernURL = buildSFIncidentsURL({ 
          where: whereModern, 
          select: ["incident_id", "incident_datetime", "incident_category", "analysis_neighborhood", "police_district", "latitude", "longitude"], 
          order: "incident_datetime DESC" 
        });
        
        try {
          // Fetch data in chunks to avoid stack overflow
          let offset = 0;
          const chunkSize = 50000;
          let totalFetched = 0;
          
          while (true) {
            const chunkURL = modernURL + `&$limit=${chunkSize}&$offset=${offset}`;
            const chunkRows = await fetchSocrata<any[]>(chunkURL, 5); // Shorter cache for responsiveness
            
            if (!chunkRows || chunkRows.length === 0) break;
            
            allRows.push(...chunkRows);
            totalFetched += chunkRows.length;
            offset += chunkSize;
            
            // If we got less than chunk size, we're done
            if (chunkRows.length < chunkSize) break;
            
            // Safety limit to prevent infinite loops
            if (totalFetched > 1000000) break;
          }
          
          console.log(`[SF Modern] Fetched ${totalFetched} rows total`);
        } catch (modernError: any) {
          console.error(`[SF Modern] Error:`, modernError?.message || modernError);
        }
      }
      
      console.log(`[SF] Total raw rows: ${allRows.length}`);
      
      // Process all stats from the combined result set
      // Neighborhood polygons (for "Where incidents occur" by lat/lon, not dataset column)
      let sfPolyInfos: { label: string; rings: number[][][]; bbox: [number, number, number, number] }[] = [];
      try {
        const fcPath = path.join(process.cwd(), "public", "sf_nta_2025.geojson");
        const raw = await fs.readFile(fcPath, "utf8");
        const fc = JSON.parse(raw);
        const guessLabelField = (props: any): string => {
          if (!props || typeof props !== "object") return "name";
          const cands = [
            "label", "name", "neighborhood",
            "ntaname2025", "nta_name_2025", "nta2025", "district", "analysis_neighborhood", "nta"
          ];
          for (const c of cands) { const hit = Object.keys(props).find((k) => k.toLowerCase() === c); if (hit) return hit; }
          return "name";
        };
        const labelField = guessLabelField(fc?.features?.[0]?.properties || {});
        if (fc && Array.isArray(fc.features)) {
          for (const f of fc.features) {
            const g = f?.geometry; if (!g) continue;
            let rings: number[][][] = [];
            if (g.type === "Polygon") rings = g.coordinates as any;
            else if (g.type === "MultiPolygon") rings = ([] as any[]).concat(...(g.coordinates as any[]));
            let minX = 180, minY = 90, maxX = -180, maxY = -90;
            for (const ring of rings) {
              for (const c of ring) { const x = c[0], y = c[1]; if (x < minX) minX = x; if (y < minY) minY = y; if (x > maxX) maxX = x; if (y > maxY) maxY = y; }
            }
            sfPolyInfos.push({ label: String(f?.properties?.[labelField] || ""), rings, bbox: [minX, minY, maxX, maxY] });
          }
        }
      } catch {}

      // If a neighborhood polygon is provided, restrict to that polygon
      let ringsForPoly: number[][][] | null = null;
      if (polyGeo) {
        const collectRings = (g: any): number[][][] => {
          if (!g) return [];
          if (g.type === 'Polygon') return g.coordinates as any;
          if (g.type === 'MultiPolygon') return ([] as any[]).concat(...(g.coordinates as any[]));
          return [];
        };
        ringsForPoly = collectRings(polyGeo);
      }
      const pointInPolygon = (x: number, y: number, rings: number[][][]): boolean => {
        let inside = false;
        for (const ring of rings) {
          let j = ring.length - 1;
          for (let i = 0; i < ring.length; i++) {
            const xi = ring[i][0], yi = ring[i][1];
            const xj = ring[j][0], yj = ring[j][1];
            const intersect = ((yi > y) !== (yj > y)) && (x < (xj - xi) * (y - yi) / ((yj - yi) || 1e-12) + xi);
            if (intersect) inside = !inside;
            j = i;
          }
        }
        return inside;
      };
      let total = 0;
      const ofnsMap = new Map<string, number>();
      const premMap = new Map<string, number>();
      const monthCounts = new Map<string, number>();
      
      for (const r of allRows) {
        // Geographic filtering
        const lat = Number(r.latitude);
        const lon = Number(r.longitude);
        if (!Number.isFinite(lat) || !Number.isFinite(lon)) continue;
        if (hasBBox && Number.isFinite(minLat as number) && Number.isFinite(maxLat as number) && Number.isFinite(minLon as number) && Number.isFinite(maxLon as number)) {
          if (lat < (minLat as number) || lat > (maxLat as number) || lon < (minLon as number) || lon > (maxLon as number)) continue;
        }
        if (ringsForPoly && ringsForPoly.length > 0) {
          if (!pointInPolygon(lon, lat, ringsForPoly)) continue;
        }
        
        total += 1;
        
        // Offense categories
        const ofns = String(r.incident_category || "UNKNOWN");
        ofnsMap.set(ofns, (ofnsMap.get(ofns) || 0) + 1);
        
        // Premises (neighborhood by point-in-polygon on sf_nta_2025.geojson)
        let prem = "UNKNOWN";
        if (sfPolyInfos.length > 0) {
          for (const p of sfPolyInfos) {
            const [minX, minY, maxX, maxY] = p.bbox;
            if (lon < minX || lon > maxX || lat < minY || lat > maxY) continue;
            if (pointInPolygon(lon, lat, p.rings)) { prem = String(p.label || "UNKNOWN"); break; }
          }
        }
        prem = prem.toUpperCase();
        premMap.set(prem, (premMap.get(prem) || 0) + 1);
        
        // Monthly timeseries
        const dateStr = String(r.incident_datetime || "");
        if (dateStr.length >= 7) {
          const ym = dateStr.substring(0, 7); // "2024-03" format
          monthCounts.set(ym, (monthCounts.get(ym) || 0) + 1);
        }
      }
      
      console.log(`[SF] Processed total: ${total}`);
      
      const ofnsTop = Array.from(ofnsMap.entries())
        .map(([label, count]) => ({ label, count }))
        .sort((a, b) => b.count - a.count);
        
      const byPremises = Array.from(premMap.entries())
        .map(([label, count]) => ({ label, count }))
        .sort((a, b) => b.count - a.count);

      // Build complete monthly timeseries
      const ymKey = (d: Date) => `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}`;
      const startDate = new Date(startISO.substring(0, 4) + "-" + startISO.substring(5, 7) + "-01T00:00:00.000Z");
      const endDateBase = new Date(endISO.substring(0, 4) + "-" + endISO.substring(5, 7) + "-01T00:00:00.000Z");
      const months: string[] = [];
      {
        const d = new Date(Date.UTC(startDate.getUTCFullYear(), startDate.getUTCMonth(), 1));
        const endYm = ymKey(endDateBase);
        for (let i = 0; i < 720; i++) {
          const ym = ymKey(d);
          months.push(ym);
          if (ym === endYm) break;
          d.setUTCMonth(d.getUTCMonth() + 1);
        }
      }
      const monthly = months.map((ym) => ({ month: ym, count: Number(monthCounts.get(ym) || 0) }));

      // Switch to yearly aggregation for long spans (>= 6 years)
      const yearSpan = endYear - startYear + 1;
      let series = monthly;
      let seriesStepMonths = 1;
      if (yearSpan >= 6) {
        const yearMap = new Map<string, number>();
        for (const m of monthly) {
          const y = m.month.slice(0, 4);
          yearMap.set(y, (yearMap.get(y) || 0) + Number(m.count || 0));
        }
        const yearsOrdered: string[] = [];
        for (let y = startYear; y <= endYear; y++) yearsOrdered.push(String(y));
        series = yearsOrdered.map((y) => ({ month: y, count: Number(yearMap.get(y) || 0) }));
        seriesStepMonths = 12;
      }

      const payload = { 
        total, 
        ofnsTop, 
        byLaw: [], 
        byBoro: [], 
        byPremises, 
        timeseries: series, 
        seriesStepMonths, 
        hasDemographics: false, 
        partial: false 
      };
      
      const tFetchEnd = Date.now();
      const serverTiming = [
        `fetch;dur=${tFetchEnd - tFetchStart}`,
        `process;dur=${Date.now() - tFetchEnd}`,
        `total;dur=${Date.now() - tReq}`,
      ].join(", ");
      
      return Response.json(payload, { 
        headers: { 
          "Cache-Control": "no-store, max-age=0, must-revalidate", 
          "X-Stats-Seq": parsed.data.seq || '', 
          "Server-Timing": serverTiming 
        } 
      });
    } catch (e: any) {
      console.error("/api/stats sf error:", e?.message || e);
      return Response.json({ 
        total: 0, 
        ofnsTop: [], 
        byLaw: [], 
        byBoro: [], 
        byPremises: [], 
        timeseries: [], 
        seriesStepMonths: 1, 
        hasDemographics: false, 
        partial: true 
      }, { 
        headers: { "Cache-Control": "no-store, max-age=0, must-revalidate" } 
      });
    }
  }

  const where: string[] = [
    `cmplnt_fr_dt >= '${startISO}'`,
    `cmplnt_fr_dt <= '${endISO}'`,
    `lat_lon IS NOT NULL`,
  ];
  if (hasBBox && Number.isFinite(minLat as number) && Number.isFinite(minLon as number) && Number.isFinite(maxLat as number) && Number.isFinite(maxLon as number)) {
    // Socrata within_box expects (min_lat, min_lon, max_lat, max_lon)
    where.push(`within_box(lat_lon, ${(minLat as number)}, ${(minLon as number)}, ${(maxLat as number)}, ${(maxLon as number)})`);
  }
  try {
    const seqLog = parsed.data.seq || "-";
    console.log(
      `[stats][NYC][seq=${seqLog}] request`,
      {
        bbox: hasBBox ? `${minLon},${minLat},${maxLon},${maxLat}` : '(none)',
        startISO,
        endISO,
        includeUnknown,
        vclass,
        ofns,
        law,
        poly: hasPoly ? 'yes' : 'no',
      }
    );
  } catch {}
  // When unknowns are excluded, drop any rows with UNKNOWN in offense or
  // suspect/victim demographic fields so totals, series, and tiles align.
  if (!includeUnknown) {
    const notUnknown = (col: string) => `(${col} IS NOT NULL AND trim(${col}) <> '' AND upper(${col}) NOT IN ('UNKNOWN','(UNKNOWN)','(NULL)','NULL','U','N/A','NA','UNK','UNKN','NONE'))`;
    where.push(
      // Complaints demographic fields (toggle target)
      notUnknown("susp_race"),
      notUnknown("susp_age_group"),
      notUnknown("susp_sex"),
      notUnknown("vic_race"),
      notUnknown("vic_age_group"),
      notUnknown("vic_sex")
    );
  }
  // Violent/non-violent filter on complaints
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

  // Aggregated monthly complaints series (citywide/viewport bbox). We will prefer this for timeseries when no polygon is selected
  const complaintsByMonthURL = buildComplaintsURL({
    where,
    select: ["date_trunc_ym(cmplnt_fr_dt) as ym", "count(1) as count"],
    group: ["ym"],
    order: "ym ASC",
    limit: 600,
  });
  const complaintsByMonthURLCur = buildComplaintsURLCurrent({
    where,
    select: ["date_trunc_ym(cmplnt_fr_dt) as ym", "count(1) as count"],
    group: ["ym"],
    order: "ym ASC",
    limit: 600,
  });

  // Build URLs for complaints data (historic and YTD)
  const tBuildStart = Date.now();
  // NOTE: we intentionally rely only on row-level pulls below and aggregate in app to avoid redundant Socrata queries.
  // Raw rows for deduped totals and ofns (align with map points)
  const complaintsRowsURL = buildComplaintsURL({ where, select: [
    "cmplnt_num",
    "ofns_desc",
    "law_cat_cd",
    "boro_nm",
    "prem_typ_desc",
    "susp_race",
    "susp_age_group",
    "susp_sex",
    "vic_race",
    "vic_age_group",
    "vic_sex",
    "cmplnt_fr_dt",
    "lat_lon",
    "latitude",
    "longitude"
  ], order: "cmplnt_fr_dt DESC", limit: 50000 });
  const complaintsRowsURLCur = buildComplaintsURLCurrent({ where, select: [
    "cmplnt_num",
    "ofns_desc",
    "law_cat_cd",
    "boro_nm",
    "prem_typ_desc",
    "susp_race",
    "susp_age_group",
    "susp_sex",
    "vic_race",
    "vic_age_group",
    "vic_sex",
    "cmplnt_fr_dt",
    "lat_lon",
    "latitude",
    "longitude"
  ], order: "cmplnt_fr_dt DESC", limit: 50000 });
  // Demographics (suspect-focused)
  const complaintByOfnsURL = buildComplaintsURL({ where, select: ["coalesce(ofns_desc, 'UNKNOWN') as label", "count(1) as count"], group: ["label"], order: "count DESC", limit: 5000 });
  const complaintByOfnsURLCur = buildComplaintsURLCurrent({ where, select: ["coalesce(ofns_desc, 'UNKNOWN') as label", "count(1) as count"], group: ["label"], order: "count DESC", limit: 5000 });
  const complaintByRaceURL = buildComplaintsURL({ where, select: ["coalesce(susp_race, 'UNKNOWN') as label", "count(1) as count"], group: ["label"], order: "count DESC", limit: 1000 });
  const complaintByRaceURLCur = buildComplaintsURLCurrent({ where, select: ["coalesce(susp_race, 'UNKNOWN') as label", "count(1) as count"], group: ["label"], order: "count DESC", limit: 1000 });
  const complaintByAgeURL = buildComplaintsURL({ where, select: ["coalesce(susp_age_group, 'UNKNOWN') as label", "count(1) as count"], group: ["label"], order: "count DESC", limit: 1000 });
  const complaintByAgeURLCur = buildComplaintsURLCurrent({ where, select: ["coalesce(susp_age_group, 'UNKNOWN') as label", "count(1) as count"], group: ["label"], order: "count DESC", limit: 1000 });
  // Where incidents occur (complaints)
  const complaintByPremURL = buildComplaintsURL({ where, select: ["coalesce(prem_typ_desc, 'UNKNOWN') as label", "count(1) as count"], group: ["label"], order: "count DESC", limit: 1000 });
  const complaintByPremURLCur = buildComplaintsURLCurrent({ where, select: ["coalesce(prem_typ_desc, 'UNKNOWN') as label", "count(1) as count"], group: ["label"], order: "count DESC", limit: 1000 });
  // Borough (complaints)
  const complaintByBoroURL = buildComplaintsURL({ where, select: ["coalesce(boro_nm, 'UNKNOWN') as label", "count(1) as count"], group: ["label"], order: "count DESC", limit: 1000 });
  const complaintByBoroURLCur = buildComplaintsURLCurrent({ where, select: ["coalesce(boro_nm, 'UNKNOWN') as label", "count(1) as count"], group: ["label"], order: "count DESC", limit: 1000 });
  // Race-on-race cross-tab (suspect vs victim)
  const complaintRaceOnRaceURL = buildComplaintsURL({
    where,
    select: ["coalesce(susp_race, 'UNKNOWN') as s", "coalesce(vic_race, 'UNKNOWN') as v", "count(1) as count"],
    group: ["s", "v"],
    order: "count DESC",
    limit: 500,
  });
  const complaintRaceOnRaceURLCur = buildComplaintsURLCurrent({
    where,
    select: ["coalesce(susp_race, 'UNKNOWN') as s", "coalesce(vic_race, 'UNKNOWN') as v", "count(1) as count"],
    group: ["s", "v"],
    order: "count DESC",
    limit: 1000,
  });
  // Sex-on-sex cross-tab (suspect vs victim)
  const complaintSexOnSexURL = buildComplaintsURL({
    where,
    select: ["coalesce(susp_sex, 'UNKNOWN') as s", "coalesce(vic_sex, 'UNKNOWN') as v", "count(1) as count"],
    group: ["s", "v"],
    order: "count DESC",
    limit: 1000,
  });
  const complaintSexOnSexURLCur = buildComplaintsURLCurrent({
    where,
    select: ["coalesce(susp_sex, 'UNKNOWN') as s", "coalesce(vic_sex, 'UNKNOWN') as v", "count(1) as count"],
    group: ["s", "v"],
    order: "count DESC",
    limit: 1000,
  });
  // Sex+Race on Sex+Race cross-tab (suspect vs victim)
  const complaintSexRaceOnSexRaceURL = buildComplaintsURL({
    where,
    select: [
      "coalesce(susp_sex, 'UNKNOWN') as ss",
      "coalesce(susp_race, 'UNKNOWN') as sr",
      "coalesce(vic_sex, 'UNKNOWN') as vs",
      "coalesce(vic_race, 'UNKNOWN') as vr",
      "count(1) as count",
    ],
    group: ["ss", "sr", "vs", "vr"],
    order: "count DESC",
    limit: 2000,
  });
  const complaintSexRaceOnSexRaceURLCur = buildComplaintsURLCurrent({
    where,
    select: [
      "coalesce(susp_sex, 'UNKNOWN') as ss",
      "coalesce(susp_race, 'UNKNOWN') as sr",
      "coalesce(vic_sex, 'UNKNOWN') as vs",
      "coalesce(vic_race, 'UNKNOWN') as vr",
      "count(1) as count",
    ],
    group: ["ss", "sr", "vs", "vr"],
    order: "count DESC",
    limit: 2000,
  });

  // Build URLs for shooting data
  const shootingWhere: string[] = [
    `occur_date >= '${startISO}'`,
    `occur_date <= '${endISO}'`,
    `geocoded_column IS NOT NULL`,
  ];
  if (hasBBox && Number.isFinite(minLat as number) && Number.isFinite(minLon as number) && Number.isFinite(maxLat as number) && Number.isFinite(maxLon as number)) {
    shootingWhere.push(`within_box(geocoded_column, ${(minLat as number)}, ${(minLon as number)}, ${(maxLat as number)}, ${(maxLon as number)})`);
  }
  // Apply includeUnknown to shootings demographics as well so stats mirror tiles/aggregate
  if (!includeUnknown) {
    const notUnknown = (col: string) => `(${col} IS NOT NULL AND trim(${col}) <> '' AND upper(${col}) NOT IN ('UNKNOWN','(UNKNOWN)','(NULL)','NULL','U','N/A','NA','UNK','UNKN','NONE'))`;
    shootingWhere.push(
      notUnknown("perp_race"),
      notUnknown("perp_age_group"),
      notUnknown("perp_sex"),
      notUnknown("vic_race"),
      notUnknown("vic_age_group"),
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

  // Apply violent class to shootings: if violent not included, skip all shootings
  if (!includesViolent) {
    shootingWhere.push("1 = 0");
  }

  const shootingTotalURL = buildShootingsURL({ where: shootingWhere, select: ["count(1) as count"], limit: 1 });
  const shootingTotalURLCur = buildShootingsURLCurrent({ where: shootingWhere, select: ["count(1) as count"], limit: 1 });
  const shootingByBoroURL = buildShootingsURL({ where: shootingWhere, select: ["boro", "count(1) as count"], group: ["boro"], order: "count DESC", limit: 1000 });
  const shootingByBoroURLCur = buildShootingsURLCurrent({ where: shootingWhere, select: ["boro", "count(1) as count"], group: ["boro"], order: "count DESC", limit: 1000 });
  const shootingByRaceURL = buildShootingsURL({ where: shootingWhere, select: ["coalesce(perp_race, 'UNKNOWN') as label", "count(1) as count"], group: ["label"], order: "count DESC", limit: 1000 });
  const shootingByRaceURLCur = buildShootingsURLCurrent({ where: shootingWhere, select: ["coalesce(perp_race, 'UNKNOWN') as label", "count(1) as count"], group: ["label"], order: "count DESC", limit: 1000 });
  const shootingByAgeURL = buildShootingsURL({ where: shootingWhere, select: ["coalesce(perp_age_group, 'UNKNOWN') as label", "count(1) as count"], group: ["label"], order: "count DESC", limit: 1000 });
  const shootingByAgeURLCur = buildShootingsURLCurrent({ where: shootingWhere, select: ["coalesce(perp_age_group, 'UNKNOWN') as label", "count(1) as count"], group: ["label"], order: "count DESC", limit: 1000 });
  // Shooting murders URL (declare before referencing below)
  const shootingMurdersURL = buildShootingsURL({ 
    where: [...shootingWhere, "statistical_murder_flag = true"], 
    select: ["count(1) as count"], 
    limit: 1 
  });
  const shootingMurdersURLCur = buildShootingsURLCurrent({ 
    where: [...shootingWhere, "statistical_murder_flag = true"], 
    select: ["count(1) as count"], 
    limit: 1 
  });
  // Shooting offense-type aggregation via totals and murders split
  const shootingTotalsByTypeURL = shootingTotalURL; // total count
  const shootingTotalsByTypeURLCur = shootingTotalURLCur;
  const shootingMurdersByTypeURL = shootingMurdersURL; // murders count
  const shootingMurdersByTypeURLCur = shootingMurdersURLCur;
  const shootingsByMonthURL = buildShootingsURL({ where: shootingWhere, select: ["date_trunc_ym(occur_date) as ym", "count(1) as count"], group: ["ym"], order: "ym ASC", limit: 600 });
  const shootingsByMonthURLCur = buildShootingsURLCurrent({ where: shootingWhere, select: ["date_trunc_ym(occur_date) as ym", "count(1) as count"], group: ["ym"], order: "ym ASC", limit: 600 });
  const shootingRaceOnRaceURL = buildShootingsURL({
    where: shootingWhere,
    select: ["coalesce(perp_race, 'UNKNOWN') as s", "coalesce(vic_race, 'UNKNOWN') as v", "count(1) as count"],
    group: ["s", "v"],
    order: "count DESC",
    limit: 1000,
  });
  const shootingRaceOnRaceURLCur = buildShootingsURLCurrent({
    where: shootingWhere,
    select: ["coalesce(perp_race, 'UNKNOWN') as s", "coalesce(vic_race, 'UNKNOWN') as v", "count(1) as count"],
    group: ["s", "v"],
    order: "count DESC",
    limit: 1000,
  });
  const shootingSexOnSexURL = buildShootingsURL({
    where: shootingWhere,
    select: ["coalesce(perp_sex, 'UNKNOWN') as s", "coalesce(vic_sex, 'UNKNOWN') as v", "count(1) as count"],
    group: ["s", "v"],
    order: "count DESC",
    limit: 1000,
  });
  const shootingSexOnSexURLCur = buildShootingsURLCurrent({
    where: shootingWhere,
    select: ["coalesce(perp_sex, 'UNKNOWN') as s", "coalesce(vic_sex, 'UNKNOWN') as v", "count(1) as count"],
    group: ["s", "v"],
    order: "count DESC",
    limit: 1000,
  });
  const shootingSexRaceOnSexRaceURL = buildShootingsURL({
    where: shootingWhere,
    select: [
      "coalesce(perp_sex, 'UNKNOWN') as ss",
      "coalesce(perp_race, 'UNKNOWN') as sr",
      "coalesce(vic_sex, 'UNKNOWN') as vs",
      "coalesce(vic_race, 'UNKNOWN') as vr",
      "count(1) as count",
    ],
    group: ["ss", "sr", "vs", "vr"],
    order: "count DESC",
    limit: 2000,
  });
  const shootingSexRaceOnSexRaceURLCur = buildShootingsURLCurrent({
    where: shootingWhere,
    select: [
      "coalesce(perp_sex, 'UNKNOWN') as ss",
      "coalesce(perp_race, 'UNKNOWN') as sr",
      "coalesce(vic_sex, 'UNKNOWN') as vs",
      "coalesce(vic_race, 'UNKNOWN') as vr",
      "count(1) as count",
    ],
    group: ["ss", "sr", "vs", "vr"],
    order: "count DESC",
    limit: 2000,
  });
  // Where incidents occur (shootings)
  const shootingByPremURL = buildShootingsURL({ where: shootingWhere, select: ["coalesce(location_desc, 'UNKNOWN') as label", "count(1) as count"], group: ["label"], order: "count DESC", limit: 1000 });
  const shootingByPremURLCur = buildShootingsURLCurrent({ where: shootingWhere, select: ["coalesce(location_desc, 'UNKNOWN') as label", "count(1) as count"], group: ["label"], order: "count DESC", limit: 1000 });
  // Borough already defined above for shootings
  // Raw rows for deduped totals and ofns (align with map points)
  const shootingRowsURL = buildShootingsURL({ where: shootingWhere, select: [
    "incident_key",
    "statistical_murder_flag",
    "occur_date",
    "boro",
    "location_desc",
    "perp_race",
    "perp_age_group",
    "perp_sex",
    "vic_race",
    "vic_age_group",
    "vic_sex",
    "latitude",
    "longitude",
    "geocoded_column"
  ], order: "occur_date DESC", limit: 20000 });
  const shootingRowsURLCur = buildShootingsURLCurrent({ where: shootingWhere, select: [
    "incident_key",
    "statistical_murder_flag",
    "occur_date",
    "boro",
    "location_desc",
    "perp_race",
    "perp_age_group",
    "perp_sex",
    "vic_race",
    "vic_age_group",
    "vic_sex",
    "latitude",
    "longitude",
    "geocoded_column"
  ], order: "occur_date DESC", limit: 20000 });

  try {
    const tFetchStart = Date.now();
    // If we explicitly filtered shootings out, don't hit the shootings dataset at all
    const skipShootings = shootingWhere.some(w => w.trim() === "1 = 0");
    try {
      console.log(
        `[stats][NYC][seq=${parsed.data.seq || '-'}] fetch phase start`,
        { skipShootings }
      );
    } catch {}

    // Quantize bbox in cache key so nearby bboxes reuse row pulls; WHERE stays precise to preserve parity
    const q = (n: number) => Math.round(n * 1000) / 1000; // ~110m grid
    const quantKey = hasBBox
      ? `bbox:${q(minLon as number)},${q(minLat as number)},${q(maxLon as number)},${q(maxLat as number)}|s:${startISO}|e:${endISO}|iu:${includeUnknown?'1':'0'}|of:${ofns||''}|law:${law||''}|vc:${vclass||''}`
      : `poly|s:${startISO}|e:${endISO}|iu:${includeUnknown?'1':'0'}|of:${ofns||''}|law:${law||''}|vc:${vclass||''}`;
    // Unified row loaders with short TTL cache to eliminate duplicate pulls between endpoints
    let complaintsMs = 0;
    let shootingsMs = 0;
    const pComplaints = (async () => {
      const t0 = Date.now();
      const rowsAll = await loadComplaintsRowsCombined(where, 20000, `complaints|${quantKey}`);
      let rows = rowsAll;
      if (polyGeo && rowsAll && rowsAll.length) {
        try {
          const poly = polyGeo;
          const pointInPolygon = (x: number, y: number, rings: number[][][]): boolean => {
            let inside = false;
            for (const ring of rings) {
              let j = ring.length - 1;
              for (let i = 0; i < ring.length; i++) {
                const xi = ring[i][0], yi = ring[i][1];
                const xj = ring[j][0], yj = ring[j][1];
                const intersect = ((yi > y) !== (yj > y)) && (x < (xj - xi) * (y - yi) / ((yj - yi) || 1e-12) + xi);
                if (intersect) inside = !inside;
                j = i;
              }
            }
            return inside;
          };
          const collectRings = (g: any): number[][][] => {
            if (!g) return [];
            if (g.type === 'Polygon') return g.coordinates as any;
            if (g.type === 'MultiPolygon') return ([] as any[]).concat(...(g.coordinates as any[]));
            return [];
          };
          const rings = collectRings(poly);
          rows = rowsAll.filter((r: any) => {
            let lat: any = r.latitude; let lon: any = r.longitude;
            if ((!lat || !lon) && r.lat_lon) {
              if (typeof r.lat_lon === 'string') {
                const m = r.lat_lon.match(/(-?\d+\.?\d*)\s+[ ,]\s*(-?\d+\.?\d*)/);
                if (m) { const a = Number(m[1]); const b = Number(m[2]); if (Math.abs(a) <= 90 && Math.abs(b) <= 180) { lat = a; lon = b; } else { lat = b; lon = a; } }
              } else if (typeof r.lat_lon === 'object') {
                lat = r.lat_lon.latitude; lon = r.lat_lon.longitude;
              }
            }
            const x = Number(lon); const y = Number(lat);
            if (!Number.isFinite(x) || !Number.isFinite(y)) return false;
            return pointInPolygon(x, y, rings);
          });
        } catch {}
      }
      complaintsMs = Date.now() - t0;
      try { console.log(`[stats][NYC][seq=${parsed.data.seq || '-'}] complaints rows fetched`, { rows: rows.length, ms: complaintsMs, poly: !!polyGeo }); } catch {}
      return rows as any[];
    })();
    const pShootings = skipShootings
      ? Promise.resolve([])
      : (async () => {
          const t0 = Date.now();
          const rowsAll = await loadShootingsRowsCombined(shootingWhere, 20000, `shootings|${quantKey}`);
          let rows = rowsAll;
          if (polyGeo && rowsAll && rowsAll.length) {
            try {
              const poly = polyGeo;
              const pointInPolygon = (x: number, y: number, rings: number[][][]): boolean => {
                let inside = false;
                for (const ring of rings) {
                  let j = ring.length - 1;
                  for (let i = 0; i < ring.length; i++) {
                    const xi = ring[i][0], yi = ring[i][1];
                    const xj = ring[j][0], yj = ring[j][1];
                    const intersect = ((yi > y) !== (yj > y)) && (x < (xj - xi) * (y - yi) / ((yj - yi) || 1e-12) + xi);
                    if (intersect) inside = !inside;
                    j = i;
                  }
                }
                return inside;
              };
              const collectRings = (g: any): number[][][] => {
                if (!g) return [];
                if (g.type === 'Polygon') return g.coordinates as any;
                if (g.type === 'MultiPolygon') return ([] as any[]).concat(...(g.coordinates as any[]));
                return [];
              };
              const rings = collectRings(poly);
              rows = rowsAll.filter((r: any) => {
                let lat: any = r.latitude; let lon: any = r.longitude;
                if ((!lat || !lon) && r.geocoded_column) {
                  if (typeof r.geocoded_column === 'string') {
                    const m = r.geocoded_column.match(/(-?\d+\.?\d*)\s*[ ,]\s*(-?\d+\.?\d*)/);
                    if (m) { const a = Number(m[1]); const b = Number(m[2]); if (Math.abs(a) <= 90 && Math.abs(b) <= 180) { lat = a; lon = b; } else { lat = b; lon = a; } }
                  } else if (typeof r.geocoded_column === 'object' && Array.isArray((r.geocoded_column as any).coordinates)) {
                    lon = (r.geocoded_column as any).coordinates[0]; lat = (r.geocoded_column as any).coordinates[1];
                  }
                }
                const x = Number(lon); const y = Number(lat);
                if (!Number.isFinite(x) || !Number.isFinite(y)) return false;
                return pointInPolygon(x, y, rings);
              });
            } catch {}
          }
          shootingsMs = Date.now() - t0;
          try { console.log(`[stats][NYC][seq=${parsed.data.seq || '-'}] shootings rows fetched`, { rows: rows.length, ms: shootingsMs, poly: !!polyGeo }); } catch {}
          return rows as any[];
        })();
    // In parallel, fetch monthly aggregates for full coverage across long ranges (used when no polygon filter is applied)
    const pComplaintsMonthly = fetchSocrata<any[]>(complaintsByMonthURL, 30)
      .then((rows) => rows || [])
      .catch(() => []);
    const pComplaintsMonthlyCur = fetchSocrata<any[]>(complaintsByMonthURLCur, 30)
      .then((rows) => rows || [])
      .catch(() => []);
    const pShootingsMonthly = fetchSocrata<any[]>(shootingsByMonthURL, 30)
      .then((rows) => rows || [])
      .catch(() => []);
    const pShootingsMonthlyCur = fetchSocrata<any[]>(shootingsByMonthURLCur, 30)
      .then((rows) => rows || [])
      .catch(() => []);

    const pOfns = Promise.all([
      fetchSocrata<any[]>(complaintByOfnsURL, 30).catch(() => []),
      fetchSocrata<any[]>(complaintByOfnsURLCur, 30).catch(() => []),
    ]);
    const pPrem = Promise.all([
      fetchSocrata<any[]>(complaintByPremURL, 30).catch(() => []),
      fetchSocrata<any[]>(complaintByPremURLCur, 30).catch(() => []),
      fetchSocrata<any[]>(shootingByPremURL, 30).catch(() => []),
      fetchSocrata<any[]>(shootingByPremURLCur, 30).catch(() => []),
    ]);
    const pBoro = Promise.all([
      fetchSocrata<any[]>(complaintByBoroURL, 30).catch(() => []),
      fetchSocrata<any[]>(complaintByBoroURLCur, 30).catch(() => []),
      fetchSocrata<any[]>(shootingByBoroURL, 30).catch(() => []),
      fetchSocrata<any[]>(shootingByBoroURLCur, 30).catch(() => []),
    ]);
    const pRace = Promise.all([
      fetchSocrata<any[]>(complaintByRaceURL, 30).catch(() => []),
      fetchSocrata<any[]>(complaintByRaceURLCur, 30).catch(() => []),
      fetchSocrata<any[]>(shootingByRaceURL, 30).catch(() => []),
      fetchSocrata<any[]>(shootingByRaceURLCur, 30).catch(() => []),
    ]);
    const pAge = Promise.all([
      fetchSocrata<any[]>(complaintByAgeURL, 30).catch(() => []),
      fetchSocrata<any[]>(complaintByAgeURLCur, 30).catch(() => []),
      fetchSocrata<any[]>(shootingByAgeURL, 30).catch(() => []),
      fetchSocrata<any[]>(shootingByAgeURLCur, 30).catch(() => []),
    ]);
    // Pairs (aggregated) for citywide parity
    const pPairsRace = Promise.all([
      fetchSocrata<any[]>(complaintRaceOnRaceURL, 30).catch(() => []),
      fetchSocrata<any[]>(complaintRaceOnRaceURLCur, 30).catch(() => []),
      fetchSocrata<any[]>(shootingRaceOnRaceURL, 30).catch(() => []),
      fetchSocrata<any[]>(shootingRaceOnRaceURLCur, 30).catch(() => []),
    ]);
    const pPairsSex = Promise.all([
      fetchSocrata<any[]>(complaintSexOnSexURL, 30).catch(() => []),
      fetchSocrata<any[]>(complaintSexOnSexURLCur, 30).catch(() => []),
      fetchSocrata<any[]>(shootingSexOnSexURL, 30).catch(() => []),
      fetchSocrata<any[]>(shootingSexOnSexURLCur, 30).catch(() => []),
    ]);
    const pPairsBoth = Promise.all([
      fetchSocrata<any[]>(complaintSexRaceOnSexRaceURL, 30).catch(() => []),
      fetchSocrata<any[]>(complaintSexRaceOnSexRaceURLCur, 30).catch(() => []),
      fetchSocrata<any[]>(shootingSexRaceOnSexRaceURL, 30).catch(() => []),
      fetchSocrata<any[]>(shootingSexRaceOnSexRaceURLCur, 30).catch(() => []),
    ]);
    // Shooting totals for offense breakdown
    const pShootTotals = Promise.all([
      fetchSocrata<any[]>(shootingTotalsByTypeURL, 30).catch(() => []),
      fetchSocrata<any[]>(shootingTotalsByTypeURLCur, 30).catch(() => []),
      fetchSocrata<any[]>(shootingMurdersByTypeURL, 30).catch(() => []),
      fetchSocrata<any[]>(shootingMurdersByTypeURLCur, 30).catch(() => []),
    ]);

    const [complaintRows, shootingRows, cMonH, cMonC, sMonH, sMonC, ofnsAgg, premAgg, boroAgg, raceAgg, ageAgg, pairsRaceAgg, pairsSexAgg, pairsBothAgg, shootTotalsAgg] = await Promise.all([
      pComplaints, pShootings, pComplaintsMonthly, pComplaintsMonthlyCur, pShootingsMonthly, pShootingsMonthlyCur, pOfns, pPrem, pBoro, pRace, pAge, pPairsRace, pPairsSex, pPairsBoth, pShootTotals,
    ]);
    const tFetchEnd = Date.now();
    try {
      console.log(
        `[stats][NYC][seq=${parsed.data.seq || '-'}] fetch phase done`,
        {
          complaintsRows: complaintRows.length,
          complaintsMs,
          shootingsRows: shootingRows.length,
          shootingsMs,
          fetchMs: tFetchEnd - tFetchStart,
        }
      );
    } catch {}

    const parseLatLon = (r: any): { lat: number; lon: number } | null => {
      let lat: any = r.latitude;
      let lon: any = r.longitude;
      if ((!lat || !lon) && r.lat_lon) {
        if (typeof r.lat_lon === "string") {
          const m = r.lat_lon.match(/(-?\d+\.?\d*)\s+[ ,]\s*(-?\d+\.?\d*)/);
          if (m) {
            const a = Number(m[1]);
            const b = Number(m[2]);
            if (Math.abs(a) <= 90 && Math.abs(b) <= 180) { lat = a; lon = b; } else { lat = b; lon = a; }
          }
        } else if (typeof r.lat_lon === "object") {
          lat = r.lat_lon.latitude;
          lon = r.lat_lon.longitude;
        }
      }
      const nlat = Number(lat);
      const nlon = Number(lon);
      if (!Number.isFinite(nlat) || !Number.isFinite(nlon)) return null;
      return { lat: nlat, lon: nlon };
    };
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
    const seen = new Set<string>();
    const dedupOfns = new Map<string, number>();
    const dedupLaw = new Map<string, number>();
    const dedupBoro = new Map<string, number>();
    const dedupPrem = new Map<string, number>();
    const dedupRace = new Map<string, number>();
    const dedupAge = new Map<string, number>();
    const racePair = new Map<string, number>(); // key: S__V
    const sexPair = new Map<string, number>();  // key: S__V
    const bothPair = new Map<string, number>(); // key: SS+SR__VS+VR
    const monthCounts = new Map<string, number>();
    let dedupTotal = 0;
    const tDedupStart = Date.now();
    for (const r of complaintRows) {
      const p = parseLatLon(r);
      if (!p) continue;
      const key = `${r.cmplnt_num || ''}|${p.lat.toFixed(5)},${p.lon.toFixed(5)}`;
      if (seen.has(key)) continue;
      seen.add(key);
      dedupTotal += 1;
      const label = r.ofns_desc || "(unknown)";
      dedupOfns.set(label, (dedupOfns.get(label) || 0) + 1);
      const law = r.law_cat_cd || "(unknown)";
      dedupLaw.set(law, (dedupLaw.get(law) || 0) + 1);
      const boro = r.boro_nm || "(unknown)";
      dedupBoro.set(boro, (dedupBoro.get(boro) || 0) + 1);
      const prem = r.prem_typ_desc || "(unknown)";
      dedupPrem.set(prem, (dedupPrem.get(prem) || 0) + 1);
      // Always maintain a row-driven monthly fallback so series never renders empty
      const ym = String(r.cmplnt_fr_dt || "").slice(0, 7);
      if (ym) monthCounts.set(ym, (monthCounts.get(ym) || 0) + 1);
      const sRace = String(r.susp_race || "UNKNOWN").toUpperCase();
      const vRace = String(r.vic_race || "UNKNOWN").toUpperCase();
      racePair.set(`${sRace}__${vRace}`, (racePair.get(`${sRace}__${vRace}`) || 0) + 1);
      const sSex = String(r.susp_sex || "UNKNOWN").toUpperCase().replace(/^M$/, "MALE").replace(/^F$/, "FEMALE");
      const vSex = String(r.vic_sex || "UNKNOWN").toUpperCase().replace(/^M$/, "MALE").replace(/^F$/, "FEMALE");
      sexPair.set(`${sSex}__${vSex}`, (sexPair.get(`${sSex}__${vSex}`) || 0) + 1);
      const bothKey = `${sSex}+${sRace}__${vSex}+${vRace}`;
      bothPair.set(bothKey, (bothPair.get(bothKey) || 0) + 1);
      const sAge = String(r.susp_age_group || "UNKNOWN").toUpperCase();
      dedupAge.set(sAge, (dedupAge.get(sAge) || 0) + 1);
    }
    for (const r of shootingRows) {
      const p = parseShootLatLon(r);
      if (!p) continue;
      const key = `${r.incident_key || ''}|${p.lat.toFixed(5)},${p.lon.toFixed(5)}`;
      if (seen.has(key)) continue;
      seen.add(key);
      dedupTotal += 1;
      const label = r.statistical_murder_flag ? "MURDER & NON-NEGL. MANSLAUGHTER" : "SHOOTING INCIDENT";
      dedupOfns.set(label, (dedupOfns.get(label) || 0) + 1);
      dedupLaw.set("FELONY", (dedupLaw.get("FELONY") || 0) + 1);
      const boro = r.boro || "(unknown)";
      dedupBoro.set(boro, (dedupBoro.get(boro) || 0) + 1);
      const prem = r.location_desc || "(unknown)";
      dedupPrem.set(prem, (dedupPrem.get(prem) || 0) + 1);
      const ym2 = String(r.occur_date || "").slice(0, 7);
      if (ym2) monthCounts.set(ym2, (monthCounts.get(ym2) || 0) + 1);
      const sRace = String(r.perp_race || "UNKNOWN").toUpperCase();
      const vRace = String(r.vic_race || "UNKNOWN").toUpperCase();
      racePair.set(`${sRace}__${vRace}`, (racePair.get(`${sRace}__${vRace}`) || 0) + 1);
      const sSex = String(r.perp_sex || "UNKNOWN").toUpperCase().replace(/^M$/, "MALE").replace(/^F$/, "FEMALE");
      const vSex = String(r.vic_sex || "UNKNOWN").toUpperCase().replace(/^M$/, "MALE").replace(/^F$/, "FEMALE");
      sexPair.set(`${sSex}__${vSex}`, (sexPair.get(`${sSex}__${vSex}`) || 0) + 1);
      const bothKey2 = `${sSex}+${sRace}__${vSex}+${vRace}`;
      bothPair.set(bothKey2, (bothPair.get(bothKey2) || 0) + 1);
      const sAge = String(r.perp_age_group || "UNKNOWN").toUpperCase();
      dedupAge.set(sAge, (dedupAge.get(sAge) || 0) + 1);
    }
    const tDedupEnd = Date.now();
    try {
      console.log(
        `[stats][NYC][seq=${parsed.data.seq || '-'}] dedup/process`,
        {
          dedupTotal,
          distinctOfns: dedupOfns.size,
          distinctLaw: dedupLaw.size,
          distinctBoro: dedupBoro.size,
          distinctPrem: dedupPrem.size,
          ms: tDedupEnd - tDedupStart,
        }
      );
    } catch {}

    // Totals
    let total = dedupTotal;

    // Offense descriptions: prefer aggregated counts when no polygon filter, else dedup rows
    let ofnsTop: { label: string; count: number }[] = [];
    if (!polyGeo && Array.isArray(ofnsAgg)) {
      const rows = [...(ofnsAgg?.[0] || []), ...(ofnsAgg?.[1] || [])];
      const mergedComplaints = mergeAggregateRows(rows, ["label"]).map((r: any) => ({ label: String(r.label || "UNKNOWN"), count: Number(r.count || 0) }));
      // Add shootings as two offense buckets using totals - murders split
      let shootingTotal = 0, shootingMurders = 0;
      try { shootingTotal += Number((shootTotalsAgg?.[0]?.[0]?.count || 0)); } catch {}
      try { shootingTotal += Number((shootTotalsAgg?.[1]?.[0]?.count || 0)); } catch {}
      try { shootingMurders += Number((shootTotalsAgg?.[2]?.[0]?.count || 0)); } catch {}
      try { shootingMurders += Number((shootTotalsAgg?.[3]?.[0]?.count || 0)); } catch {}
      const shootingNonMurders = Math.max(0, shootingTotal - shootingMurders);
      const addMap = new Map<string, number>();
      for (const it of mergedComplaints) addMap.set(it.label, (addMap.get(it.label) || 0) + Number(it.count || 0));
      if (shootingMurders > 0) addMap.set("MURDER & NON-NEGL. MANSLAUGHTER", (addMap.get("MURDER & NON-NEGL. MANSLAUGHTER") || 0) + shootingMurders);
      if (shootingNonMurders > 0) addMap.set("SHOOTING INCIDENT", (addMap.get("SHOOTING INCIDENT") || 0) + shootingNonMurders);
      ofnsTop = Array.from(addMap.entries()).map(([label, count]) => ({ label, count })).sort((a, b) => b.count - a.count);
    } else {
      const ofnsMap = new Map<string, number>();
      dedupOfns.forEach((v, k) => ofnsMap.set(k, v));
      ofnsTop = Array.from(ofnsMap.entries()).map(([label, count]) => ({ label, count })).sort((a, b) => b.count - a.count);
    }

    // Law categories from dedup
    const lawMap = new Map<string, number>();
    dedupLaw.forEach((v, k) => lawMap.set(k, v));
    let byLaw = Array.from(lawMap.entries())
      .map(([label, count]) => ({ label, count }))
      .sort((a, b) => b.count - a.count)
      .slice(0, 10);

    // Borough: prefer aggregated (complaints+shootings) when no polygon, else dedup rows
    let byBoro: { label: string; count: number }[] = [];
    if (!polyGeo && Array.isArray(boroAgg)) {
      const rows = [...(boroAgg?.[0] || []), ...(boroAgg?.[1] || []), ...(boroAgg?.[2] || []), ...(boroAgg?.[3] || [])];
      const merged = mergeAggregateRows(rows, ["label"]).map((r: any) => ({ label: String(r.label || "UNKNOWN"), count: Number(r.count || 0) }));
      byBoro = merged.sort((a, b) => b.count - a.count).slice(0, 10);
    } else {
      const boroMap = new Map<string, number>();
      dedupBoro.forEach((v, k) => boroMap.set(k, v));
      byBoro = Array.from(boroMap.entries())
        .map(([label, count]) => ({ label, count }))
        .sort((a, b) => b.count - a.count)
        .slice(0, 10);
    }

    // Demographics (suspect-based): prefer aggregated when no polygon, else dedup rows
    const normalizeLabel = (s: any) => (s ?? "").toString();
    const upper = (s: string) => s.trim().toUpperCase();

    // Hoisted so it's available before first use
    function canonicalizePrem(labelRaw: any) {
      const L = upper(normalizeLabel(labelRaw));
      if (!L || L === "(UNKNOWN)" || L === "(NULL)" || L === "NULL" || L === "U" || L === "UNKNOWN") return "UNKNOWN";
      return L;
    }

    // Race aggregation with UNKNOWN kept (collapsed to single token)
    const canonicalizeRace = (labelRaw: any) => {
      const L = upper(normalizeLabel(labelRaw));
      if (!L || L === "(UNKNOWN)" || L === "(NULL)" || L === "NULL" || L === "U" || L === "UNKNOWN") return "UNKNOWN";
      return L;
    };
    let byRace: { label: string; count: number }[] = [];
    if (!polyGeo && Array.isArray(raceAgg)) {
      const rows = [...(raceAgg?.[0] || []), ...(raceAgg?.[1] || []), ...(raceAgg?.[2] || []), ...(raceAgg?.[3] || [])];
      const merged = mergeAggregateRows(rows, ["label"]).map((r: any) => ({ label: String(canonicalizeRace((r as any).label || "UNKNOWN")), count: Number((r as any).count || 0) }));
      byRace = merged.filter(x => x.count > 0).sort((a, b) => b.count - a.count).slice(0, 12);
    } else {
      const raceTotals = new Map<string, number>();
      racePair.forEach((c, k) => { const [s, v] = k.split("__"); raceTotals.set(s, (raceTotals.get(s)||0)+c); raceTotals.set(v, (raceTotals.get(v)||0)+c); });
      byRace = Array.from(raceTotals.entries())
        .map(([label, count]) => ({ label, count }))
        .filter(x => x.count > 0)
        .sort((a, b) => b.count - a.count)
        .slice(0, 12);
    }
    if (!includeUnknown) {
      byRace = byRace.filter((x) => x.label !== "UNKNOWN");
    }

    // Age aggregation with canonicalization + unknown/code removal + ordering
    const canonicalizeAge = (labelRaw: string): string => {
      let L = upper(labelRaw).replace(/–/g, "-");
      if (!L || L === "(UNKNOWN)" || L === "(NULL)" || L === "NULL" || L === "U" || L === "UNKNOWN" || /^-?\d+$/.test(L)) return "UNKNOWN";
      if (L === "LESS THAN 18" || L === "UNDER 18" || L === "<18") return "<18";
      if (L === "65 - 74") return "65-74";
      if (/^\d{2}-\d{2}$/.test(L)) return L; // e.g., 18-24, 25-34, 25-44, 45-64
      if (/^\d{2}\+$/.test(L)) return L;    // e.g., 65+
      if (L === "75+") return "75+";
      return L;
    };
    const ageOrderKey = (label: string): number => {
      const L = label;
      if (L === "<18") return 0;
      if (L === "18-24") return 1;
      if (L === "25-34") return 2;
      if (L === "25-44") return 2.5; // ensure after 18-24, before 45-64
      if (L === "35-44") return 3;
      if (L === "45-64") return 4;
      if (L === "65-74") return 5;
      if (L === "65+") return 5;
      if (L === "75+") return 6;
      const m = L.match(/^(\d{2})-(\d{2})$/);
      if (m) return parseInt(m[1], 10);
      const p = L.match(/^(\d{2})\+$/);
      if (p) return 100 + parseInt(p[1], 10);
      return 999;
    };
    let byAge: { label: string; count: number }[] = [];
    if (!polyGeo && Array.isArray(ageAgg)) {
      const rows = [...(ageAgg?.[0] || []), ...(ageAgg?.[1] || []), ...(ageAgg?.[2] || []), ...(ageAgg?.[3] || [])];
      const merged = mergeAggregateRows(rows, ["label"]).map((r: any) => ({ label: canonicalizeAge(String((r as any).label || "UNKNOWN")), count: Number((r as any).count || 0) }));
      byAge = merged.filter(x => x.count > 0).sort((a, b) => ageOrderKey(a.label) - ageOrderKey(b.label)).slice(0, 12);
    } else {
      const ageMapAgg = new Map<string, number>();
      dedupAge.forEach((c, k) => {
        const canon = canonicalizeAge(normalizeLabel(k));
        ageMapAgg.set(canon, (ageMapAgg.get(canon) || 0) + Number(c || 0));
      });
      byAge = Array.from(ageMapAgg.entries())
        .map(([label, count]) => ({ label, count }))
        .filter(x => x.count > 0)
        .sort((a, b) => ageOrderKey(a.label) - ageOrderKey(b.label))
        .slice(0, 12);
    }

    // Where incidents occur: aggregated path for citywide
    let byPremises: { label: string; count: number }[] = [];
    if (!polyGeo && Array.isArray(premAgg)) {
      const rows = [...(premAgg?.[0] || []), ...(premAgg?.[1] || []), ...(premAgg?.[2] || []), ...(premAgg?.[3] || [])];
      const merged = mergeAggregateRows(rows, ["label"]).map((r: any) => ({ label: String((r as any).label || "UNKNOWN"), count: Number((r as any).count || 0) }));
      byPremises = merged.filter(x => x.count > 0).sort((a, b) => b.count - a.count);
    } else {
      // existing dedup-based byPremises already computed above
      // reuse dedupPrem map built from rows
      const premMap2 = new Map<string, number>();
      const addPrem2 = (lbl: any, c: any) => {
        const k = canonicalizePrem(lbl);
        premMap2.set(k, (premMap2.get(k) || 0) + Number(c || 0));
      };
      dedupPrem.forEach((c, k) => addPrem2(k, c));
      byPremises = Array.from(premMap2.entries()).map(([label, count]) => ({ label, count })).filter(x => x.count > 0).sort((a, b) => b.count - a.count);
    }
    if (!includeUnknown) {
      byAge = byAge.filter((x) => x.label !== "UNKNOWN");
    }

    // Race-on-race matrix (prefer aggregated for citywide)
    const canonicalRace = (labelRaw: any) => canonicalizeRace(labelRaw);
    const pairKey = (s: string, v: string) => `${s}__${v}`;
    let suspects: string[] = [];
    let victims: string[] = [];
    let countsMatrix: number[][] = [];
    if (!polyGeo && Array.isArray(pairsRaceAgg)) {
      const rows = [...(pairsRaceAgg?.[0] || []), ...(pairsRaceAgg?.[1] || []), ...(pairsRaceAgg?.[2] || []), ...(pairsRaceAgg?.[3] || [])];
      const map = new Map<string, number>();
      const sTotals = new Map<string, number>();
      const vTotals = new Map<string, number>();
      for (const r of rows as any[]) {
        const s = canonicalRace((r as any).s);
        const v = canonicalRace((r as any).v);
        const c = Number((r as any).count || 0);
        map.set(pairKey(s, v), (map.get(pairKey(s, v)) || 0) + c);
        sTotals.set(s, (sTotals.get(s) || 0) + c);
        vTotals.set(v, (vTotals.get(v) || 0) + c);
      }
      suspects = Array.from(sTotals.entries()).sort((a,b)=>b[1]-a[1]).slice(0,7).map(([s])=>s);
      victims = Array.from(vTotals.entries()).sort((a,b)=>b[1]-a[1]).slice(0,7).map(([v])=>v);
      if (!includeUnknown) { suspects = suspects.filter(s=>s!=="UNKNOWN"); victims = victims.filter(v=>v!=="UNKNOWN"); }
      countsMatrix = victims.map(v => suspects.map(s => map.get(pairKey(s, v)) || 0));
    } else {
      const pairCounts = racePair;
      const suspectTotals = new Map<string, number>();
      const victimTotals = new Map<string, number>();
      for (const [k, c] of pairCounts.entries()) {
        const [S, V] = k.split("__");
        suspectTotals.set(S, (suspectTotals.get(S) || 0) + c);
        victimTotals.set(V, (victimTotals.get(V) || 0) + c);
      }
      suspects = Array.from(suspectTotals.entries()).sort((a,b)=>b[1]-a[1]).slice(0, 7).map(([s])=>s);
      victims = Array.from(victimTotals.entries()).sort((a,b)=>b[1]-a[1]).slice(0, 7).map(([v])=>v);
      if (!includeUnknown) { suspects = suspects.filter((s) => s !== "UNKNOWN"); victims = victims.filter((v) => v !== "UNKNOWN"); }
      countsMatrix = victims.map(v => suspects.map(s => pairCounts.get(pairKey(s, v)) || 0));
    }

    // Sex-on-sex matrix (suspect sex vs victim sex) — keep UNKNOWN categories
    const canonicalizeSex = (labelRaw: any) => {
      const L = upper(normalizeLabel(labelRaw));
      if (!L || L === "(UNKNOWN)" || L === "(NULL)" || L === "NULL" || L === "U" || L === "UNKNOWN") return "UNKNOWN";
      if (L === "M" || L === "MALE") return "MALE";
      if (L === "F" || L === "FEMALE") return "FEMALE";
      return L;
    };
    let suspectsSex: string[] = [];
    let victimsSex: string[] = [];
    let countsMatrixSex: number[][] = [];
    if (!polyGeo && Array.isArray(pairsSexAgg)) {
      const rows = [...(pairsSexAgg?.[0] || []), ...(pairsSexAgg?.[1] || []), ...(pairsSexAgg?.[2] || []), ...(pairsSexAgg?.[3] || [])];
      const map = new Map<string, number>();
      const sTotals = new Map<string, number>();
      const vTotals = new Map<string, number>();
      for (const r of rows as any[]) {
        const s = canonicalizeSex((r as any).s);
        const v = canonicalizeSex((r as any).v);
        const c = Number((r as any).count || 0);
        map.set(pairKey(s, v), (map.get(pairKey(s, v)) || 0) + c);
        sTotals.set(s, (sTotals.get(s) || 0) + c);
        vTotals.set(v, (vTotals.get(v) || 0) + c);
      }
      suspectsSex = Array.from(sTotals.entries()).sort((a,b)=>b[1]-a[1]).slice(0,7).map(([s])=>s);
      victimsSex = Array.from(vTotals.entries()).sort((a,b)=>b[1]-a[1]).slice(0,7).map(([v])=>v);
      if (!includeUnknown) { suspectsSex = suspectsSex.filter(s=>s!=="UNKNOWN"); victimsSex = victimsSex.filter(v=>v!=="UNKNOWN"); }
      countsMatrixSex = victimsSex.map(v => suspectsSex.map(s => map.get(pairKey(s, v)) || 0));
    } else {
      const pairCountsSex = sexPair;
      const suspectTotalsSex = new Map<string, number>();
      const victimTotalsSex = new Map<string, number>();
      for (const [k, c] of pairCountsSex.entries()) {
        const [S, V] = k.split("__");
        suspectTotalsSex.set(S, (suspectTotalsSex.get(S) || 0) + c);
        victimTotalsSex.set(V, (victimTotalsSex.get(V) || 0) + c);
      }
      suspectsSex = Array.from(suspectTotalsSex.entries()).sort((a,b)=>b[1]-a[1]).slice(0, 7).map(([s])=>s);
      victimsSex = Array.from(victimTotalsSex.entries()).sort((a,b)=>b[1]-a[1]).slice(0, 7).map(([v])=>v);
      if (!includeUnknown) { suspectsSex = suspectsSex.filter((s) => s !== "UNKNOWN"); victimsSex = victimsSex.filter((v) => v !== "UNKNOWN"); }
      countsMatrixSex = victimsSex.map(v => suspectsSex.map(s => pairCountsSex.get(pairKey(s, v)) || 0));
    }

    // Sex+Race on Sex+Race matrix (suspect [sex+race] vs victim [sex+race])
    const bothKey = (sex: string, race: string) => `${canonicalizeSex(sex)}+${canonicalRace(race)}`;
    let suspectsBoth: string[] = [];
    let victimsBoth: string[] = [];
    let countsMatrixBoth: number[][] = [];
    if (!polyGeo && Array.isArray(pairsBothAgg)) {
      const rows = [...(pairsBothAgg?.[0] || []), ...(pairsBothAgg?.[1] || []), ...(pairsBothAgg?.[2] || []), ...(pairsBothAgg?.[3] || [])];
      const map = new Map<string, number>();
      const sTotals = new Map<string, number>();
      const vTotals = new Map<string, number>();
      for (const r of rows as any[]) {
        const S = bothKey((r as any).ss, (r as any).sr);
        const V = bothKey((r as any).vs, (r as any).vr);
        const c = Number((r as any).count || 0);
        map.set(pairKey(S, V), (map.get(pairKey(S, V)) || 0) + c);
        sTotals.set(S, (sTotals.get(S) || 0) + c);
        vTotals.set(V, (vTotals.get(V) || 0) + c);
      }
      suspectsBoth = Array.from(sTotals.entries()).sort((a,b)=>b[1]-a[1]).slice(0,7).map(([s])=>s);
      victimsBoth = Array.from(vTotals.entries()).sort((a,b)=>b[1]-a[1]).slice(0,7).map(([v])=>v);
      if (!includeUnknown) { const isUnknownCombo = (x: string) => x.startsWith("UNKNOWN+") || x.endsWith("+UNKNOWN") || x === "UNKNOWN+UNKNOWN"; suspectsBoth = suspectsBoth.filter(s=>!isUnknownCombo(s)); victimsBoth = victimsBoth.filter(v=>!isUnknownCombo(v)); }
      countsMatrixBoth = victimsBoth.map(v => suspectsBoth.map(s => map.get(pairKey(s, v)) || 0));
    } else {
      const pairCountsBoth = bothPair;
      const suspectTotalsBoth = new Map<string, number>();
      const victimTotalsBoth = new Map<string, number>();
      for (const [k, c] of pairCountsBoth.entries()) {
        const [S, V] = k.split("__");
        suspectTotalsBoth.set(S, (suspectTotalsBoth.get(S) || 0) + c);
        victimTotalsBoth.set(V, (victimTotalsBoth.get(V) || 0) + c);
      }
      suspectsBoth = Array.from(suspectTotalsBoth.entries()).sort((a,b)=>b[1]-a[1]).slice(0, 7).map(([s])=>s);
      victimsBoth = Array.from(victimTotalsBoth.entries()).sort((a,b)=>b[1]-a[1]).slice(0, 7).map(([v])=>v);
      if (!includeUnknown) { const isUnknownCombo = (x: string) => x.startsWith("UNKNOWN+") || x.endsWith("+UNKNOWN") || x === "UNKNOWN+UNKNOWN"; suspectsBoth = suspectsBoth.filter((s) => !isUnknownCombo(s)); victimsBoth = victimsBoth.filter((v) => !isUnknownCombo(v)); }
      countsMatrixBoth = victimsBoth.map(v => suspectsBoth.map(s => pairCountsBoth.get(pairKey(s, v)) || 0));
    }

    // Where incidents occur — merge complaints prem_typ_desc + shootings location_desc
    const premMap = new Map<string, number>();
    const addPrem = (lbl: any, c: any) => {
      const k = canonicalizePrem(lbl);
      premMap.set(k, (premMap.get(k) || 0) + Number(c || 0));
    };
    dedupPrem.forEach((c, k) => addPrem(k, c));
    const byPremisesRows = Array.from(premMap.entries())
      .map(([label, count]) => ({ label, count }))
      .filter(x => x.count > 0)
      .sort((a, b) => b.count - a.count);
    if (byPremises.length === 0) byPremises = byPremisesRows;
    // Keep UNKNOWN premises category; unknown toggle applies to demo fields only.

    // Timeseries: prefer aggregated monthly fetches when no polygon is provided (covers full 2022–2025 range without row caps)
    const toYm = (s: any) => String(s || "").slice(0, 7); // YYYY-MM
    const tsMap = new Map<string, number>();
    if (!polyGeo) {
      try {
        const normalizeYm = (val: any): string => {
          const s = String(val || "");
          if (!s) return "";
          // Accept "2022-01" or "2022-01-01T..."
          if (s.length >= 7) return s.slice(0, 7);
          return s;
        };
        const complaintsMonthly = mergeAggregateRows<any>([...cMonH, ...cMonC], ["ym"]).map((r) => ({ ym: normalizeYm((r as any).ym), count: Number((r as any).count || 0) }));
        const shootingsMonthly = mergeAggregateRows<any>([...sMonH, ...sMonC], ["ym"]).map((r) => ({ ym: normalizeYm((r as any).ym), count: Number((r as any).count || 0) }));
        for (const r of complaintsMonthly) { if (r.ym) tsMap.set(r.ym, (tsMap.get(r.ym) || 0) + Number(r.count || 0)); }
        for (const r of shootingsMonthly) { if (r.ym) tsMap.set(r.ym, (tsMap.get(r.ym) || 0) + Number(r.count || 0)); }
      } catch {}
    } else {
      // Polygon path: rely on row-driven monthCounts built above after point-in-polygon filtering
      monthCounts.forEach((v, k) => tsMap.set(k, Number(v || 0)));
    }
    // Fallback: if aggregated series came back empty, fall back to row-driven monthly counts
    if (tsMap.size === 0) {
      monthCounts.forEach((v, k) => tsMap.set(k, Number(v || 0)));
    }
    // Build complete month sequence from start to end and fill missing months with 0
    const ymKey = (d: Date) => `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}`;
    const startDate = new Date(startISO.substring(0, 4) + "-" + startISO.substring(5, 7) + "-01T00:00:00.000Z");
    const endDateBase = new Date(endISO.substring(0, 4) + "-" + endISO.substring(5, 7) + "-01T00:00:00.000Z");
    const months: string[] = [];
    {
      const d = new Date(Date.UTC(startDate.getUTCFullYear(), startDate.getUTCMonth(), 1));
      const endYm = ymKey(endDateBase);
      for (let i = 0; i < 720; i++) { // hard cap safety ~60 years
        const ym = ymKey(d);
        months.push(ym);
        if (ym === endYm) break;
        d.setUTCMonth(d.getUTCMonth() + 1);
      }
    }
    const monthly = months.map((ym) => ({ month: ym, count: Number(tsMap.get(ym) || 0) }))
      .sort((a, b) => a.month.localeCompare(b.month));

    // end dedup overrides

    // Switch to yearly aggregation for long spans (>= 6 years)
    const startY = Number(startISO.slice(0, 4));
    const endY = Number(endISO.slice(0, 4));
    const yearSpan = (Number.isFinite(startY) && Number.isFinite(endY)) ? (endY - startY + 1) : 0;
    let timeseries = monthly;
    let seriesStepMonths = 1;
    if (yearSpan >= 6) {
      const yearMap = new Map<string, number>();
      for (const m of monthly) {
        const y = m.month.slice(0, 4);
        yearMap.set(y, (yearMap.get(y) || 0) + Number(m.count || 0));
      }
      const yearsOrdered: string[] = [];
      for (let y = startY; y <= endY; y++) yearsOrdered.push(String(y));
      timeseries = yearsOrdered.map((y) => ({ month: y, count: Number(yearMap.get(y) || 0) }));
      seriesStepMonths = 12;
    }

    // Prefer accurate totals from monthly aggregates when available and no polygon filter is applied
    const monthlyTotal = timeseries.reduce((acc, d) => acc + Number(d.count || 0), 0);
    const sums = {
      totalChosen: (!polyGeo ? monthlyTotal : total),
      timeseriesSum: monthlyTotal,
      ofnsSum: ofnsTop.reduce((a, b) => a + Number(b.count || 0), 0),
      byPremisesSum: byPremises.reduce((a, b) => a + Number(b.count || 0), 0),
      byBoroSum: byBoro.reduce((a, b) => a + Number(b.count || 0), 0),
      raceSum: byRace.reduce((a, b) => a + Number(b.count || 0), 0),
      ageSum: byAge.reduce((a, b) => a + Number(b.count || 0), 0),
      pairsRaceSum: countsMatrix.reduce((acc, row) => acc + row.reduce((x, y) => x + Number(y || 0), 0), 0),
      pairsSexSum: countsMatrixSex.reduce((acc, row) => acc + row.reduce((x, y) => x + Number(y || 0), 0), 0),
      pairsBothSum: countsMatrixBoth.reduce((acc, row) => acc + row.reduce((x, y) => x + Number(y || 0), 0), 0),
    };
    const payload = { total: sums.totalChosen, ofnsTop, byLaw, byBoro, byRace, byAge, byPremises, timeseries, seriesStepMonths, raceOnRace: { suspects, victims, counts: countsMatrix }, sexOnSex: { suspects: suspectsSex, victims: victimsSex, counts: countsMatrixSex }, sexRaceOnSexRace: { suspects: suspectsBoth, victims: victimsBoth, counts: countsMatrixBoth }, sums, partial: false };
    // micro-cache keyed by quantized filters (drop seq to allow reuse across HMR/fast refresh)
    try {
      const cache = (globalThis as any).__statsCache as Map<string, { expiresAt: number; data: any }> || new Map();
      (globalThis as any).__statsCache = cache;
      const q = (n: number) => Math.round(n * 10000) / 10000;
      const cacheKey = hasBBox
        ? `${q(minLon as number)}|${q(minLat as number)}|${q(maxLon as number)}|${q(maxLat as number)}|${startISO}|${endISO}|${includeUnknown?'1':'0'}|${ofns||''}|${law||''}|${vclass||''}`
        : `poly|${startISO}|${endISO}|${includeUnknown?'1':'0'}|${ofns||''}|${law||''}|${vclass||''}`;
      cache.set(cacheKey, { expiresAt: Date.now() + 5000, data: payload });
    } catch {}
    const tDone = Date.now();
    const serverTiming = [
      `build;dur=${tFetchStart - tBuildStart}`,
      `fetch;dur=${tFetchEnd - tFetchStart}`,
      `complaints;dur=${complaintsMs}`,
      `shootings;dur=${shootingsMs}`,
      `process;dur=${tDone - tFetchEnd}`,
      `dedup;desc=deduplicate_and_pair;dur=${tDedupEnd - tFetchEnd}`,
      `total;dur=${tDone - tReq}`,
    ].join(", ");
    try {
      console.log(
        `[stats][NYC][seq=${parsed.data.seq || '-'}] timings`,
        {
          buildMs: tFetchStart - tBuildStart,
          fetchMs: tFetchEnd - tFetchStart,
          complaintsMs,
          shootingsMs,
          processMs: tDone - tFetchEnd,
          totalMs: tDone - tReq,
        }
      );
    } catch {}
    return Response.json(payload, { headers: { "Cache-Control": "no-store, max-age=0, must-revalidate", "X-Stats-Seq": parsed.data.seq || '', "Server-Timing": serverTiming } });
  } catch (e: any) {
    console.error("/api/stats fatal error:", e);
    return Response.json({ error: e?.message || String(e) }, { status: 500, headers: { "Cache-Control": "no-store, max-age=0, must-revalidate" } });
  }
}


