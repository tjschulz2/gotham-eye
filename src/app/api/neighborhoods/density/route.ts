import { NextRequest } from "next/server";
import { z } from "zod";
import { loadComplaintsRowsCombined, loadShootingsRowsCombined, buildSFIncidentsURL, buildSFIncidentsLegacyURL, fetchSocrata, escapeSoqlString } from "@/lib/socrata";
import { buildViolentSoqlCondition, parseViolenceParam } from "@/lib/categories";
import fs from "fs/promises";
import path from "path";

const Query = z.object({
  city: z.string().optional(),
  start: z.string().optional(),
  end: z.string().optional(),
  ofns: z.string().optional(),
  law: z.string().optional(),
  vclass: z.string().optional(),
  includeUnknown: z.string().optional(), // "1" to include
});

export async function GET(req: NextRequest) {
  const p = Query.safeParse(Object.fromEntries(req.nextUrl.searchParams.entries()));
  if (!p.success) return new Response("Bad query", { status: 400 });
  const { ofns, law, vclass } = p.data;
  const city = ((p.data.city || "nyc") as string).toLowerCase();
  const includeUnknown = (p.data.includeUnknown || "0") === "1";

  const start = p.data.start ? new Date(p.data.start) : new Date(Date.now() - 1000 * 60 * 60 * 24 * 365 * 4);
  const end = p.data.end ? new Date(p.data.end) : new Date();
  const toFloating = (d: Date) => {
    const pad = (n: number, w = 2) => String(n).padStart(w, "0");
    return `${d.getUTCFullYear()}-${pad(d.getUTCMonth()+1)}-${pad(d.getUTCDate())}T${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}:${pad(d.getUTCSeconds())}.${pad(d.getUTCMilliseconds(),3)}`;
  };
  const startISO = toFloating(start);
  const endISO = toFloating(end);

  // Load city polygons from public
  const fcPath = path.join(process.cwd(), "public", city === "sf" ? "sf_nta_2025.geojson" : "nyc_nta_2020.geojson");
  const raw = await fs.readFile(fcPath, "utf8");
  const nta = JSON.parse(raw);
  if (!nta || !Array.isArray(nta.features)) return Response.json({ type: "FeatureCollection", features: [] });

  // Guess neighborhood label field
  const guessLabelField = (props: any): string => {
    if (!props || typeof props !== "object") return "name";
    const cands = [
      // Common
      "label", "name", "neighborhood",
      // NYC
      "ntaname", "nta_name", "ntaname2020", "ntaname_2020",
      // SF variants
      "ntaname2025", "nta_name_2025", "nta2025", "district", "analysis_neighborhood", "nta"
    ];
    for (const c of cands) { const hit = Object.keys(props).find((k) => k.toLowerCase() === c); if (hit) return hit; }
    return "name";
  };
  const labelField = guessLabelField(nta.features?.[0]?.properties || {});

  // Precompute polygon rings + bbox
  type PolyInfo = { label: string; rings: number[][][]; bbox: [number, number, number, number]; };
  const polyInfos: PolyInfo[] = [];
  for (const f of nta.features) {
    const g = f?.geometry; if (!g) continue;
    let rings: number[][][] = [];
    if (g.type === "Polygon") rings = g.coordinates as any;
    else if (g.type === "MultiPolygon") rings = ([] as any[]).concat(...(g.coordinates as any[]));
    let minX = 180, minY = 90, maxX = -180, maxY = -90;
    for (const ring of rings) {
      for (const c of ring) { const x = c[0], y = c[1]; if (x < minX) minX = x; if (y < minY) minY = y; if (x > maxX) maxX = x; if (y > maxY) maxY = y; }
    }
    polyInfos.push({ label: String(f.properties?.[labelField] || ""), rings, bbox: [minX, minY, maxX, maxY] });
  }

  // Spatial helpers
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

  const counts = new Map<string, number>();
  const bump = (label: string) => counts.set(label, (counts.get(label) || 0) + 1);
  const tryAssign = (lon: number, lat: number) => {
    for (const p of polyInfos) {
      const [minX, minY, maxX, maxY] = p.bbox;
      if (lon < minX || lon > maxX || lat < minY || lat > maxY) continue;
      if (pointInPolygon(lon, lat, p.rings)) { bump(p.label); break; }
    }
  };

  if (city === "sf") {
    // Build year-based ranges for SF datasets
    const startYear = Number(startISO.slice(0, 4));
    const endYear = Number(endISO.slice(0, 4));
    const needsLegacy = Number.isFinite(startYear) && startYear <= 2017;
    const needsModern = Number.isFinite(endYear) && endYear >= 2018;

    // Build WHERE clauses for SF modern dataset
    if (needsModern) {
      const modernStartYear = Math.max(2018, startYear || 2018);
      const modernEndYear = Math.min(2025, endYear || new Date().getUTCFullYear());
      const yearConds: string[] = [];
      for (let y = modernStartYear; y <= modernEndYear; y++) yearConds.push(`incident_year='${y}'`);
      const whereModern: string[] = [ `(${yearConds.join(' OR ')})` ];
      // Violence filter on incident_category
      const violentCondSF = buildViolentSoqlCondition("incident_category");
      const vsetSF = parseViolenceParam(vclass);
      const includesViolentSF = vsetSF.has("violent");
      const includesNonviolentSF = vsetSF.has("nonviolent");
      if (includesViolentSF && !includesNonviolentSF) whereModern.push(violentCondSF);
      else if (!includesViolentSF && includesNonviolentSF) whereModern.push(`NOT (${violentCondSF})`);
      // Offense filter
      if (ofns) {
        const values = ofns.split(",").map((v) => `'${escapeSoqlString(v.trim())}'`).join(",");
        whereModern.push(`incident_category IN (${values})`);
      }
      const modernURL = buildSFIncidentsURL({
        where: whereModern,
        select: [
          "incident_id",
          "incident_datetime",
          "incident_category",
          "analysis_neighborhood",
          "police_district",
          "latitude",
          "longitude"
        ],
        order: "incident_datetime DESC",
      });
      // Page in chunks
      try {
        let offset = 0;
        const chunk = 50000;
        while (true) {
          const page = await fetchSocrata<any[]>(`${modernURL}&$limit=${chunk}&$offset=${offset}`, 3600);
          if (!page || page.length === 0) break;
          for (const r of page) {
            const lat = Number((r as any).latitude);
            const lon = Number((r as any).longitude);
            if (!Number.isFinite(lat) || !Number.isFinite(lon)) continue;
            tryAssign(lon, lat);
          }
          offset += chunk;
          if (page.length < chunk) break;
        }
      } catch {}
    }

    // Legacy dataset (2003-2018)
    if (needsLegacy) {
      const legacyStartYear = Math.max(2003, startYear || 2003);
      const legacyEndYear = Math.min(2017, endYear || 2017);
      const yearConds: string[] = [];
      for (let y = legacyStartYear; y <= legacyEndYear; y++) yearConds.push(`date_extract_y(date)=${y}`);
      const whereLegacy: string[] = [ `(${yearConds.join(' OR ')})` ];
      const violentCondLegacy = buildViolentSoqlCondition("category");
      const vsetSF = parseViolenceParam(vclass);
      const includesViolentSF = vsetSF.has("violent");
      const includesNonviolentSF = vsetSF.has("nonviolent");
      if (includesViolentSF && !includesNonviolentSF) whereLegacy.push(violentCondLegacy);
      else if (!includesViolentSF && includesNonviolentSF) whereLegacy.push(`NOT (${violentCondLegacy})`);
      if (ofns) {
        const values = ofns.split(",").map((v) => `'${escapeSoqlString(v.trim())}'`).join(",");
        whereLegacy.push(`category IN (${values})`);
      }
      const legacyURL = buildSFIncidentsLegacyURL({
        where: whereLegacy,
        select: ["incidntnum", "date", "category", "pddistrict", "x", "y"],
        order: "date DESC",
      });
      try {
        let offset = 0;
        const chunk = 50000;
        while (true) {
          const page = await fetchSocrata<any[]>(`${legacyURL}&$limit=${chunk}&$offset=${offset}`, 3600);
          if (!page || page.length === 0) break;
          for (const r of page) {
            const lat = Number((r as any).y);
            const lon = Number((r as any).x);
            if (!Number.isFinite(lat) || !Number.isFinite(lon)) continue;
            tryAssign(lon, lat);
          }
          offset += chunk;
          if (page.length < chunk) break;
        }
      } catch {}
    }
  } else {
    // NYC path: Build WHERE for citywide pulls (no bbox)
    const where: string[] = [
      `cmplnt_fr_dt >= '${startISO}'`,
      `cmplnt_fr_dt <= '${endISO}'`,
      `lat_lon IS NOT NULL`,
    ];
    if (!includeUnknown) {
      const notUnknown = (col: string) => `(${col} IS NOT NULL AND trim(${col}) <> '' AND upper(${col}) NOT IN ('UNKNOWN','(UNKNOWN)','(NULL)','NULL','U','N/A','NA','UNK','UNKN','NONE'))`;
      where.push(
        notUnknown("susp_race"), notUnknown("susp_age_group"), notUnknown("susp_sex"),
        notUnknown("vic_race"), notUnknown("vic_age_group"), notUnknown("vic_sex")
      );
    }
    const vset = parseViolenceParam(vclass);
    const includesViolent = vset.has("violent");
    const includesNonviolent = vset.has("nonviolent");
    const violentCond = buildViolentSoqlCondition("ofns_desc");
    if (includesViolent && !includesNonviolent) where.push(violentCond);
    else if (!includesViolent && includesNonviolent) where.push(`NOT (${violentCond})`);
    if (ofns) { const vals = ofns.split(",").map(v=>`'${v.trim().replace(/'/g, "''")}'`).join(","); where.push(`ofns_desc IN (${vals})`); }
    if (law) { const vals = law.split(",").map(v=>`'${v.trim().replace(/'/g, "''")}'`).join(","); where.push(`law_cat_cd IN (${vals})`); }

    // Fetch citywide rows (historic + YTD)
    const quantKey = `nta-density|${startISO}|${endISO}|${includeUnknown?'1':'0'}|${ofns||''}|${law||''}|${vclass||''}`;
    const [complaints, shootings] = await Promise.all([
      loadComplaintsRowsCombined(where, 20000, `complaints|${quantKey}`),
      loadShootingsRowsCombined([`occur_date >= '${startISO}'`,`occur_date <= '${endISO}'`,`geocoded_column IS NOT NULL`], 20000, `shootings|${quantKey}`),
    ]);
    for (const r of complaints) {
      let lat: any = (r as any).latitude; let lon: any = (r as any).longitude;
      if ((!lat || !lon) && (r as any).lat_lon) {
        const s = (r as any).lat_lon;
        if (typeof s === 'string') {
          const m = s.match(/(-?\d+\.?\d*)\s+[ ,]\s*(-?\d+\.?\d*)/); if (m) {
            const a = Number(m[1]); const b = Number(m[2]); if (Math.abs(a) <= 90 && Math.abs(b) <= 180) { lat = a; lon = b; } else { lat = b; lon = a; }
          }
        } else if (typeof s === 'object') { lat = s.latitude; lon = s.longitude; }
      }
      const y = Number(lat), x = Number(lon); if (!Number.isFinite(x) || !Number.isFinite(y)) continue; tryAssign(x, y);
    }
    for (const r of shootings) {
      let lat: any = (r as any).latitude; let lon: any = (r as any).longitude;
      const g = (r as any).geocoded_column;
      if ((!lat || !lon) && g) {
        if (typeof g === 'string') { const m = g.match(/(-?\d+\.?\d*)\s*[ ,]\s*(-?\d+\.?\d*)/); if (m) { const a = Number(m[1]); const b = Number(m[2]); if (Math.abs(a) <= 90 && Math.abs(b) <= 180) { lat = a; lon = b; } else { lat = b; lon = a; } } }
        else if (typeof g === 'object' && Array.isArray((g as any).coordinates)) { lon = (g as any).coordinates[0]; lat = (g as any).coordinates[1]; }
      }
      const y = Number(lat), x = Number(lon); if (!Number.isFinite(x) || !Number.isFinite(y)) continue; tryAssign(x, y);
    }
  }

  // Compute rank-based deciles guaranteeing exact top/bottom ~10%
  // - Bottom bucket (q=0): exactly round(n*0.10) lowest neighborhoods (min 1)
  // - Top bucket (q=9): exactly round(n*0.10) highest neighborhoods (min 1)
  // - Middle buckets (q=1..8): evenly divide the remainder by rank
  const entries = Array.from(counts.entries());
  entries.sort((a, b) => a[1] - b[1]);
  const n = Math.max(1, entries.length);
  const bottomN = Math.max(1, Math.round(n * 0.10));
  const topN = Math.max(1, Math.round(n * 0.10));
  const midCount = Math.max(0, n - bottomN - topN);
  const nameToPQ = new Map<string, { p: number; q: number }>();
  for (let i = 0; i < n; i++) {
    const name = entries[i][0];
    let q = 0;
    if (i < bottomN) {
      q = 0;
    } else if (i >= n - topN) {
      q = 9;
    } else if (midCount > 0) {
      const idxMid = i - bottomN;
      q = 1 + Math.floor((idxMid * 8) / midCount); // 1..8
      if (q < 1) q = 1; if (q > 8) q = 8;
    } else {
      q = i < n - 1 ? 0 : 9;
    }
    const p = n > 1 ? (i / (n - 1)) : 0; // still compute percentile for reference
    nameToPQ.set(name, { p, q });
  }

  // Enrich GeoJSON with counts + percentile p (0..1) and decile q (0..9)
  const enriched = {
    type: "FeatureCollection",
    features: nta.features.map((f: any) => {
      const name = String(f.properties?.[labelField] || "");
      const cnt = counts.get(name) || 0;
      const pq = nameToPQ.get(name) || { p: 0, q: 0 };
      return { ...f, properties: { ...(f.properties || {}), label: name, count: cnt, p: pq.p, q: pq.q } };
    })
  };

  return Response.json(enriched, { headers: { "Cache-Control": "no-store, max-age=0, must-revalidate" } });
}


