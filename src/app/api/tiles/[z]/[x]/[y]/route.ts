import { NextRequest } from "next/server";
import { z } from "zod";
import { buildComplaintsURL, buildShootingsURL, escapeSoqlString, fetchSocrata, fourYearsAgoISOString, toFloatingTimestamp, ShootingRow, buildComplaintsURLCurrent, buildShootingsURLCurrent, buildSFIncidentsURL, buildSFIncidentsLegacyURL } from "@/lib/socrata";
import { buildViolentSoqlCondition, parseViolenceParam } from "@/lib/categories";
import { featuresToTilePBF, GeoJSONFeature } from "@/lib/tiles";

// Tile API: returns MVT for z/x/y using on-demand pull from Socrata bounded by tile bbox and last-4-years.
// Note: This implementation keeps payloads to <= 1,000 rows per request due to Socrata limits.
// It trades completeness for responsiveness until we add background ETL. High zoom tiles typically fit <1k rows.

const QuerySchema = z.object({
  start: z.string().optional(),
  end: z.string().optional(),
  ofns: z.string().optional(), // comma-separated offense descriptions
  law: z.string().optional(), // comma-separated law_cat_cd
  vclass: z.string().optional(), // comma-separated: violent,nonviolent
  includeUnknown: z.string().optional(), // "1" to include
});

// Compute bbox for a tile with buffer to avoid missing boundary data
function tileToBBOX(z: number, x: number, y: number) {
  const n = Math.pow(2, z);
  const lonMin = (x / n) * 360 - 180;
  const latRadMax = Math.atan(Math.sinh(Math.PI * (1 - (2 * y) / n)));
  const latMax = (latRadMax * 180) / Math.PI;
  const lonMax = ((x + 1) / n) * 360 - 180;
  const latRadMin = Math.atan(Math.sinh(Math.PI * (1 - (2 * (y + 1)) / n)));
  const latMin = (latRadMin * 180) / Math.PI;
  
  // Use a tiny buffer to avoid seam artifacts at tile boundaries but keep it small
  // to minimize duplicate contributions across adjacent tiles.
  const buffer = 0.0005; // ~50m
  return { 
    minLon: lonMin - buffer, 
    minLat: latMin - buffer, 
    maxLon: lonMax + buffer, 
    maxLat: latMax + buffer 
  };
}

export async function GET(
  req: NextRequest,
  ctx: { params: Promise<{ z: string; x: string; y: string }> }
) {
  const tReq = Date.now();
  const { z, x, y } = await ctx.params;
  const ySanitized = y.replace(/\.mvt$/i, "");
  const zNum = Number(z);
  const xNum = Number(x);
  const yNum = Number(ySanitized);

  if (!Number.isFinite(zNum) || !Number.isFinite(xNum) || !Number.isFinite(yNum)) {
    return new Response("Invalid z/x/y", { status: 400 });
  }

  const query = QuerySchema.safeParse(Object.fromEntries(req.nextUrl.searchParams.entries()));
  if (!query.success) {
    return new Response("Invalid query", { status: 400 });
  }

  const { minLon, minLat, maxLon, maxLat } = tileToBBOX(zNum, xNum, yNum);

  const centerLon = (minLon + maxLon) / 2;
  const centerLat = (minLat + maxLat) / 2;
  const isSF = (lat: number, lon: number) => lat > 37.4 && lat < 38.2 && lon > -123.2 && lon < -122.0;

  // Adaptive limits by zoom to keep latency predictable
  function limitsForZoom(z: number) {
    if (z >= 15) return { complaints: 10000, shootings: 4000 };
    if (z >= 13) return { complaints: 7000, shootings: 2500 };
    if (z >= 11) return { complaints: 5000, shootings: 2000 };
    return { complaints: 3000, shootings: 1200 };
  }
  const lim = limitsForZoom(zNum);

  const startISO = toFloatingTimestamp(
    query.data.start ? new Date(query.data.start) : new Date(Date.now() - 1000 * 60 * 60 * 24 * 365 * 4)
  );
  const endISO = toFloatingTimestamp(query.data.end ? new Date(query.data.end) : new Date());

  // NYC complaints WHERE and selects
  const whereNYC: string[] = [
    `cmplnt_fr_dt >= '${startISO}'`,
    `cmplnt_fr_dt <= '${endISO}'`,
    `lat_lon IS NOT NULL`,
    `within_box(lat_lon, ${minLat}, ${minLon}, ${maxLat}, ${maxLon})`,
  ];
  if ((query.data.includeUnknown || "0") !== "1") {
    const notUnknown = (col: string) => `(${col} IS NOT NULL AND trim(${col}) <> '' AND upper(${col}) NOT IN ('UNKNOWN','(UNKNOWN)','(NULL)','NULL','U','N/A','NA','UNK','UNKN','NONE'))`;
    whereNYC.push(
      notUnknown("susp_race"),
      notUnknown("susp_age_group"),
      notUnknown("susp_sex"),
      notUnknown("vic_race"),
      notUnknown("vic_age_group"),
      notUnknown("vic_sex")
    );
  }
  const vset = parseViolenceParam(query.data.vclass);
  const includesViolent = vset.has("violent");
  const includesNonviolent = vset.has("nonviolent");
  const violentCondNYC = buildViolentSoqlCondition("ofns_desc");
  if (includesViolent && !includesNonviolent) {
    whereNYC.push(violentCondNYC);
  } else if (!includesViolent && includesNonviolent) {
    whereNYC.push(`NOT (${violentCondNYC})`);
  }
  if (query.data.ofns) {
    const values = query.data.ofns.split(",").map((v) => `'${escapeSoqlString(v.trim())}'`).join(",");
    whereNYC.push(`ofns_desc IN (${values})`);
  }
  if (query.data.law) {
    const values = query.data.law.split(",").map((v) => `'${escapeSoqlString(v.trim())}'`).join(",");
    whereNYC.push(`law_cat_cd IN (${values})`);
  }
  const selectNYC = ["cmplnt_num","ofns_desc","law_cat_cd","pd_desc","boro_nm","cmplnt_fr_dt","lat_lon","latitude","longitude"];
  const complaintsUrl = buildComplaintsURL({ where: whereNYC, select: selectNYC, order: "cmplnt_fr_dt DESC", limit: lim.complaints });
  const complaintsUrlCur = buildComplaintsURLCurrent({ where: whereNYC, select: selectNYC, order: "cmplnt_fr_dt DESC", limit: lim.complaints });

  // SF WHERE and selects
  const whereSF: string[] = [
    `incident_datetime >= '${startISO}'`,
    `incident_datetime <= '${endISO}'`,
    // Use numeric lat/lon bounds instead of within_box on point to avoid Socrata quirks
    `latitude IS NOT NULL`,
    `longitude IS NOT NULL`,
    `latitude >= ${minLat}`,
    `latitude <= ${maxLat}`,
    `longitude >= ${minLon}`,
    `longitude <= ${maxLon}`,
  ];
  // Violent/non-violent based on incident_category
  const violentCondSF = buildViolentSoqlCondition("incident_category");
  if (includesViolent && !includesNonviolent) whereSF.push(violentCondSF);
  else if (!includesViolent && includesNonviolent) whereSF.push(`NOT (${violentCondSF})`);
  if (query.data.ofns) {
    const values = query.data.ofns.split(",").map((v) => `'${escapeSoqlString(v.trim())}'`).join(",");
    whereSF.push(`incident_category IN (${values})`);
  }
  const selectSF = [
    "incident_id",
    "incident_datetime",
    "incident_category",
    "incident_subcategory",
    "incident_description",
    "analysis_neighborhood",
    "police_district",
    "latitude",
    "longitude",
    "point",
  ];

  // Fetch shooting data - map to similar structure
  const shootingWhere: string[] = [
    `occur_date >= '${startISO}'`,
    `occur_date <= '${endISO}'`,
    `geocoded_column IS NOT NULL`,
    `within_box(geocoded_column, ${minLat}, ${minLon}, ${maxLat}, ${maxLon})`,
  ];
  if ((query.data.includeUnknown || "0") !== "1") {
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
  if (query.data.ofns) {
    const selectedOffenses = query.data.ofns.split(",").map(v => v.trim());
    const includesMurder = selectedOffenses.includes("MURDER & NON-NEGL. MANSLAUGHTER");
    const includesShootings = selectedOffenses.includes("SHOOTING INCIDENT");
    
    // If neither murder nor shooting incidents are selected, don't fetch shooting data
    if (!includesMurder && !includesShootings) {
      // Skip shooting data entirely
    } else if (includesMurder && !includesShootings) {
      // Only fetch murders (statistical_murder_flag = true)
      shootingWhere.push("statistical_murder_flag = true");
    } else if (!includesMurder && includesShootings) {
      // Only fetch non-murders (statistical_murder_flag = false)
      shootingWhere.push("statistical_murder_flag = false");
    }
    // If both are selected, fetch all shooting data (no additional filter needed)
  }

  // Apply law category filters to shooting data (all shootings are felonies)
  if (query.data.law) {
    const selectedLawCats = query.data.law.split(",").map(v => v.trim());
    if (!selectedLawCats.includes("FELONY")) {
      // If FELONY is not selected, skip shooting data entirely
      shootingWhere.push("1 = 0"); // This will return no results
    }
  }

  const shootingSelect = [
    "incident_key",
    "occur_date",
    "boro",
    "statistical_murder_flag",
    "location_desc",
    "geocoded_column",
    "latitude",
    "longitude",
  ];

  // Determine if we should fetch shooting data
  const shouldFetchShootings = (() => {
    // If violent class is not selected, do not fetch shootings at all
    if (!includesViolent) return false;
    if (query.data.ofns) {
      const selectedOffenses = query.data.ofns.split(",").map(v => v.trim());
      const includesMurder = selectedOffenses.includes("MURDER & NON-NEGL. MANSLAUGHTER");
      const includesShootings = selectedOffenses.includes("SHOOTING INCIDENT");
      return includesMurder || includesShootings;
    }
    if (query.data.law) {
      const selectedLawCats = query.data.law.split(",").map(v => v.trim());
      return selectedLawCats.includes("FELONY");
    }
    return true; // No offense/law filters; violent class selected -> include shootings
  })();

  const shootingsUrl = shouldFetchShootings ? buildShootingsURL({
    where: shootingWhere,
    select: shootingSelect,
    order: "occur_date DESC",
    limit: lim.shootings,
  }) : null;
  const shootingsUrlCur = shouldFetchShootings ? buildShootingsURLCurrent({
    where: shootingWhere,
    select: shootingSelect,
    order: "occur_date DESC",
    limit: lim.shootings,
  }) : null;

  try {
    // Micro-cache for MVT by exact queryURL (safe: includes z/x/y and filters)
    const cacheKey = req.nextUrl.toString();
    try {
      const cache = (globalThis as any).__tileCache as Map<string, { expiresAt: number; body: Uint8Array }> || new Map();
      (globalThis as any).__tileCache = cache;
      const cached = cache.get(cacheKey);
      if (cached && cached.expiresAt > Date.now()) {
        return new Response(cached.body as BodyInit, {
          status: 200,
          headers: {
            "Content-Type": "application/vnd.mapbox-vector-tile",
            "Cache-Control": "public, s-maxage=60, stale-while-revalidate=600",
            "Server-Timing": `cache;desc=hit;dur=0, total;dur=${Date.now() - tReq}`,
          },
        });
      }
    } catch {}

    const tFetchStart = Date.now();
    // Fetch datasets - tolerate partial failures so the tile still renders
    const promises: Promise<any[]>[] = [];
    // Branch by city: if tile center is San Francisco, use SF dataset; otherwise NYC
    const useSF = isSF(centerLat, centerLon);
    if (useSF) {
      // For SF, choose API based on date range
      const startYear = Number(startISO.slice(0, 4));
      const endYear = Number(endISO.slice(0, 4));
      
      if (endYear < 2018) {
        // Use legacy API only (2003-2018)
        const yearConditions: string[] = [];
        for (let year = Math.max(2003, startYear); year <= Math.min(2017, endYear); year++) {
          yearConditions.push(`date_extract_y(date)=${year}`);
        }
        const legacyWhere = [
          `(${yearConditions.join(' OR ')})`,
          `x IS NOT NULL`,
          `y IS NOT NULL`,
          // BBox constraint for performance and correctness
          `y >= ${minLat}`,
          `y <= ${maxLat}`,
          `x >= ${minLon}`,
          `x <= ${maxLon}`,
        ];
        
        // Add violence filtering
        const vsetLegacy = parseViolenceParam(query.data.vclass);
        const includesViolentLegacy = vsetLegacy.has("violent");
        const includesNonviolentLegacy = vsetLegacy.has("nonviolent");
        const violentCondLegacy = buildViolentSoqlCondition("category");
        if (includesViolentLegacy && !includesNonviolentLegacy) legacyWhere.push(violentCondLegacy);
        else if (!includesViolentLegacy && includesNonviolentLegacy) legacyWhere.push(`NOT (${violentCondLegacy})`);
        
        if (query.data.ofns) {
          const values = query.data.ofns.split(",").map((v) => `'${escapeSoqlString(v.trim())}'`).join(",");
          legacyWhere.push(`category IN (${values})`);
        }
        
        const legacySelect = ["incidntnum", "date", "category", "pddistrict", "x", "y"];
        const sfLegacyUrl = buildSFIncidentsLegacyURL({ where: legacyWhere, select: legacySelect, order: "date DESC", limit: lim.complaints });
        promises.push(fetchSocrata<any[]>(sfLegacyUrl, 5)); // Short cache for responsiveness
      } else if (startYear >= 2018) {
        // Use modern API only (2018-Present)
        const yearConditions: string[] = [];
        for (let year = Math.max(2018, startYear); year <= Math.min(2025, endYear); year++) {
          yearConditions.push(`incident_year='${year}'`);
        }
        const modernWhere = [
          `(${yearConditions.join(' OR ')})`,
          `latitude IS NOT NULL`,
          `longitude IS NOT NULL`,
          // BBox constraint for performance and correctness
          `latitude >= ${minLat}`,
          `latitude <= ${maxLat}`,
          `longitude >= ${minLon}`,
          `longitude <= ${maxLon}`,
        ];
        
        // Add violence filtering
        const vsetModern = parseViolenceParam(query.data.vclass);
        const includesViolentModern = vsetModern.has("violent");
        const includesNonviolentModern = vsetModern.has("nonviolent");
        const violentCondModern = buildViolentSoqlCondition("incident_category");
        if (includesViolentModern && !includesNonviolentModern) modernWhere.push(violentCondModern);
        else if (!includesViolentModern && includesNonviolentModern) modernWhere.push(`NOT (${violentCondModern})`);
        
        if (query.data.ofns) {
          const values = query.data.ofns.split(",").map((v) => `'${escapeSoqlString(v.trim())}'`).join(",");
          modernWhere.push(`incident_category IN (${values})`);
        }
        
        const modernSelect = ["incident_id", "incident_datetime", "incident_category", "analysis_neighborhood", "police_district", "latitude", "longitude"];
        const sfUrl = buildSFIncidentsURL({ where: modernWhere, select: modernSelect, order: "incident_datetime DESC", limit: lim.complaints });
        promises.push(fetchSocrata<any[]>(sfUrl, 5)); // Short cache for responsiveness
      } else {
        // Use BOTH APIs for tiles spanning 2018 to include full historical data
        // Modern (2018+)
        const modernYearConditions: string[] = [];
        for (let year = Math.max(2018, startYear); year <= Math.min(2025, endYear); year++) {
          modernYearConditions.push(`incident_year='${year}'`);
        }
        const modernWhere = [
          `(${modernYearConditions.join(' OR ')})`,
          `latitude IS NOT NULL`,
          `longitude IS NOT NULL`,
          `latitude >= ${minLat}`,
          `latitude <= ${maxLat}`,
          `longitude >= ${minLon}`,
          `longitude <= ${maxLon}`,
        ];
        const vsetModern = parseViolenceParam(query.data.vclass);
        const includesViolentModern = vsetModern.has("violent");
        const includesNonviolentModern = vsetModern.has("nonviolent");
        const violentCondModern = buildViolentSoqlCondition("incident_category");
        if (includesViolentModern && !includesNonviolentModern) modernWhere.push(violentCondModern);
        else if (!includesViolentModern && includesNonviolentModern) modernWhere.push(`NOT (${violentCondModern})`);
        if (query.data.ofns) {
          const values = query.data.ofns.split(",").map((v) => `'${escapeSoqlString(v.trim())}'`).join(",");
          modernWhere.push(`incident_category IN (${values})`);
        }
        const modernSelect = ["incident_id", "incident_datetime", "incident_category", "analysis_neighborhood", "police_district", "latitude", "longitude"];
        const sfModernUrl = buildSFIncidentsURL({ where: modernWhere, select: modernSelect, order: "incident_datetime DESC", limit: lim.complaints });
        promises.push(fetchSocrata<any[]>(sfModernUrl, 5));

        // Legacy (<=2017)
        const legacyYearConditions: string[] = [];
        for (let year = Math.max(2003, startYear); year <= Math.min(2017, endYear); year++) {
          legacyYearConditions.push(`date_extract_y(date)=${year}`);
        }
        const legacyWhere = [
          `(${legacyYearConditions.join(' OR ')})`,
          `x IS NOT NULL`,
          `y IS NOT NULL`,
          `y >= ${minLat}`,
          `y <= ${maxLat}`,
          `x >= ${minLon}`,
          `x <= ${maxLon}`,
        ];
        const vsetLegacy = parseViolenceParam(query.data.vclass);
        const includesViolentLegacy = vsetLegacy.has("violent");
        const includesNonviolentLegacy = vsetLegacy.has("nonviolent");
        const violentCondLegacy = buildViolentSoqlCondition("category");
        if (includesViolentLegacy && !includesNonviolentLegacy) legacyWhere.push(violentCondLegacy);
        else if (!includesViolentLegacy && includesNonviolentLegacy) legacyWhere.push(`NOT (${violentCondLegacy})`);
        if (query.data.ofns) {
          const values = query.data.ofns.split(",").map((v) => `'${escapeSoqlString(v.trim())}'`).join(",");
          legacyWhere.push(`category IN (${values})`);
        }
        const legacySelect = ["incidntnum", "date", "category", "pddistrict", "x", "y"];
        const sfLegacyUrl = buildSFIncidentsLegacyURL({ where: legacyWhere, select: legacySelect, order: "date DESC", limit: lim.complaints });
        promises.push(fetchSocrata<any[]>(sfLegacyUrl, 5));
      }
    } else {
      promises.push(fetchSocrata<any[]>(complaintsUrl));
      promises.push(fetchSocrata<any[]>(complaintsUrlCur));
    }
    if (shouldFetchShootings && shootingsUrl && shootingsUrlCur) {
      promises.push(fetchSocrata<ShootingRow[]>(shootingsUrl));
      promises.push(fetchSocrata<ShootingRow[]>(shootingsUrlCur));
    }
    const settled = await Promise.allSettled(promises);
    const tFetchEnd = Date.now();
    const getOk = (i: number): any[] => (settled[i] && settled[i].status === "fulfilled" ? (settled[i] as any).value : []);
    const useSF2 = isSF(centerLat, centerLon);
    let complaintsRows: any[] = [];
    let shootingRows: ShootingRow[] = [];
    if (useSF2) {
      // All tasks are SF complaints (modern and/or legacy)
      for (let i = 0; i < settled.length; i++) {
        const rows = getOk(i);
        if (Array.isArray(rows) && rows.length) complaintsRows.push(...rows);
      }
    } else {
      complaintsRows = [...getOk(0), ...getOk(1)];
      if (shouldFetchShootings) {
        shootingRows = ([...getOk(2), ...getOk(3)] as ShootingRow[]);
      }
    }

    // Log if we're hitting limits
    if (complaintsRows.length >= lim.complaints) {
      console.warn(`Tile ${zNum}/${xNum}/${yNum}: Hit complaints limit (${complaintsRows.length} rows) - data may be incomplete`);
    }
    if (shootingRows.length >= lim.shootings) {
      console.warn(`Tile ${zNum}/${xNum}/${yNum}: Hit shootings limit (${shootingRows.length} rows) - data may be incomplete`);
    }

    // Process complaints data
    const parseLatLon = (r: any): { lat: number; lon: number } | null => {
      let lat: any = r.latitude || r.y; // SF legacy uses 'y' for latitude
      let lon: any = r.longitude || r.x; // SF legacy uses 'x' for longitude
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
      if ((!lat || !lon) && r.point) {
        if (typeof r.point === "string") {
          const m = r.point.match(/(-?\d+\.?\d*)\s*[ ,]\s*(-?\d+\.?\d*)/);
          if (m) {
            // WKT POINT is usually lon lat
            const a = Number(m[1]);
            const b = Number(m[2]);
            // Try both orderings safely
            if (Math.abs(a) <= 90 && Math.abs(b) <= 180) { lon = a; lat = b; } else { lon = b; lat = a; }
          }
        }
      }
      const nlat = Number(lat);
      const nlon = Number(lon);
      if (!Number.isFinite(nlat) || !Number.isFinite(nlon)) return null;
      return { lat: nlat, lon: nlon };
    };

    // IncludeUnknown applied via WHERE above; do not further filter ofns here
    const includeUnknown = (query.data.includeUnknown || "0") === "1";
    const sanitizeProps = (obj: Record<string, any>): Record<string, string | number | boolean> => {
      const out: Record<string, string | number | boolean> = {};
      for (const k in obj) {
        const v = (obj as any)[k];
        if (v === null || v === undefined) { out[k] = ""; continue; }
        const t = typeof v;
        if (t === "string") out[k] = v as string;
        else if (t === "number") out[k] = Number.isFinite(v as number) ? (v as number) : 0;
        else if (t === "boolean") out[k] = v as boolean;
        else out[k] = String(v);
      }
      return out;
    };

    const complaintFeatures: GeoJSONFeature[] = complaintsRows
      .map((r) => {
        const p = parseLatLon(r);
        if (!p) return null;
        const props = sanitizeProps({
          cmplnt_num: String(r.cmplnt_num || r.incident_id || r.incidntnum || ""),
          ofns_desc: String(r.ofns_desc || r.incident_category || r.category || ""),
          law_cat_cd: String(r.law_cat_cd || ""),
          pd_desc: String(r.pd_desc || r.incident_description || r.descript || ""),
          boro_nm: String(r.boro_nm || r.analysis_neighborhood || r.police_district || r.pddistrict || ""),
          cmplnt_fr_dt: String(r.cmplnt_fr_dt || r.incident_datetime || r.date || ""),
          data_source: "complaints",
        });
        return {
          type: "Feature",
          geometry: { type: "Point", coordinates: [p.lon, p.lat] },
          properties: props,
        };
      })
      .filter(Boolean) as GeoJSONFeature[];

    // Process shooting data - normalize coordinates with fallbacks from geocoded_column
    const parseShootLatLon = (r: any): { lat: number; lon: number } | null => {
      let lat: any = r.latitude;
      let lon: any = r.longitude;
      if ((!lat || !lon) && r.geocoded_column) {
        if (typeof r.geocoded_column === "string") {
          // Could be "POINT (-73.9 40.7)" or "(40.7, -73.9)"
          const m = r.geocoded_column.match(/(-?\d+\.?\d*)\s*[ ,]\s*(-?\d+\.?\d*)/);
          if (m) {
            const a = Number(m[1]);
            const b = Number(m[2]);
            if (Math.abs(a) <= 90 && Math.abs(b) <= 180) { lat = a; lon = b; } else { lat = b; lon = a; }
          }
        } else if (typeof r.geocoded_column === "object" && Array.isArray((r.geocoded_column as any).coordinates)) {
          const coords = (r.geocoded_column as any).coordinates;
          // Socrata stores as [lon, lat]
          lon = coords[0];
          lat = coords[1];
        }
      }
      const nlat = Number(lat);
      const nlon = Number(lon);
      if (!Number.isFinite(nlat) || !Number.isFinite(nlon)) return null;
      return { lat: nlat, lon: nlon };
    };
    const shootingFeatures: GeoJSONFeature[] = shootingRows
      .map((r) => {
        const p = parseShootLatLon(r);
        if (!p) return null;
        const props = sanitizeProps({
          cmplnt_num: String(r.incident_key || ""),
          ofns_desc: String(r.statistical_murder_flag ? "MURDER & NON-NEGL. MANSLAUGHTER" : "SHOOTING INCIDENT"),
          law_cat_cd: "FELONY",
          pd_desc: String(r.statistical_murder_flag ? "MURDER" : "SHOOTING INCIDENT"),
          boro_nm: String(r.boro || ""),
          cmplnt_fr_dt: String(r.occur_date || ""),
          data_source: "shootings",
        });
        return {
          type: "Feature",
          geometry: { type: "Point", coordinates: [p.lon, p.lat] },
          properties: props,
        };
      })
      .filter(Boolean) as GeoJSONFeature[];

    // Combine both datasets
    const features = [...complaintFeatures, ...shootingFeatures];
    // Safety: de-duplicate identical coord+id pairs in case upstream sent duplicates
    const seen = new Set<string>();
    const deduped: GeoJSONFeature[] = [];
    for (const f of features) {
      const id = `${f.properties.cmplnt_num || ''}|${(f.geometry.coordinates || []).join(',')}`;
      if (seen.has(id)) continue;
      seen.add(id);
      deduped.push(f);
    }

    // Debug logging to help track data loading
    if (features.length > 0) {
      console.log(`Tile ${zNum}/${xNum}/${yNum}: ${features.length} features (${complaintFeatures.length} complaints, ${shootingFeatures.length} shootings)`);
      
      // Log specific offense types when filtering
      if (query.data.ofns) {
        const offenseTypes = features.map(f => f.properties.ofns_desc).filter(Boolean);
        const uniqueOffenses = [...new Set(offenseTypes)];
        console.log(`  Filtered offenses in tile: ${uniqueOffenses.join(', ')}`);
        console.log(`  Total filtered features: ${features.length}`);
      }
    }

    const body = featuresToTilePBF(deduped, zNum, xNum, yNum);
    try {
      const cache = (globalThis as any).__tileCache as Map<string, { expiresAt: number; body: Uint8Array }> || new Map();
      (globalThis as any).__tileCache = cache;
      cache.set(cacheKey, { expiresAt: Date.now() + 60000, body });
    } catch {}
    const tDone = Date.now();
    const serverTiming = [
      `fetch;dur=${tFetchEnd - tFetchStart}`,
      `encode;dur=${tDone - tFetchEnd}`,
      `total;dur=${tDone - tReq}`,
    ].join(", ");
    return new Response(body, {
      status: 200,
      headers: {
        "Content-Type": "application/vnd.mapbox-vector-tile",
        // Prevent stale tiles after filter or city changes
        "Cache-Control": "no-store, max-age=0, must-revalidate",
        "Server-Timing": serverTiming,
      },
    });
  } catch (err: any) {
    console.error("/api/tiles error:", err?.message);
    // Return an empty but valid MVT tile when upstream fails (avoid 500s that clear the layer)
    try {
      const body = featuresToTilePBF([], zNum, xNum, yNum);
      return new Response(body, { status: 200, headers: { "Content-Type": "application/vnd.mapbox-vector-tile", "Cache-Control": "public, s-maxage=60" } });
    } catch {
      return new Response(`Upstream error: ${err?.message || "unknown"}`, { status: 200, headers: { "Content-Type": "application/vnd.mapbox-vector-tile" } });
    }
  }
}


