import { NextRequest } from "next/server";
import { unstable_cache as unstableCache } from "next/cache";
import { buildComplaintsURL, buildShootingsURL, fetchSocrata, toFloatingTimestamp, buildComplaintsURLCurrent, buildShootingsURLCurrent, buildSFIncidentsURL, buildSFIncidentsLegacyURL } from "@/lib/socrata";

export async function GET(req: NextRequest) {
  const startISO = toFloatingTimestamp(new Date(new Date().getFullYear() - 4, 0, 1));
  const city = (req.nextUrl.searchParams.get("city") || "nyc").toLowerCase();
  
  // City-specific builders
  const complaintsUrl = buildComplaintsURL({
    where: [
      `cmplnt_fr_dt >= '${startISO}'`,
      `ofns_desc IS NOT NULL`,
    ],
    select: ["ofns_desc", "count(1) as count"],
    group: ["ofns_desc"],
    order: "count DESC",
    limit: 1000,
  });
  const complaintsUrlCur = buildComplaintsURLCurrent({
    where: [
      `cmplnt_fr_dt >= '${startISO}'`,
      `ofns_desc IS NOT NULL`,
    ],
    select: ["ofns_desc", "count(1) as count"],
    group: ["ofns_desc"],
    order: "count DESC",
    limit: 1000,
  });

  // Get shooting data count (NYC only)
  const shootingsUrl = buildShootingsURL({ where: [`occur_date >= '${startISO}'`], select: ["count(1) as count"], limit: 1 });
  const shootingsUrlCur = buildShootingsURLCurrent({ where: [`occur_date >= '${startISO}'`], select: ["count(1) as count"], limit: 1 });

  try {
    if (city === "sf") {
      const compute = async () => {
        // SF categories from both modern and legacy APIs
        const [modernRows, legacyRows] = await Promise.all([
          // Modern API (2018-Present)
          fetchSocrata<Array<{ label?: unknown; count?: unknown }>>(buildSFIncidentsURL({
            where: [
              `incident_year IN ('2018','2019','2020','2021','2022','2023','2024','2025')`,
              `incident_category IS NOT NULL`
            ],
            select: ["incident_category as label", "count(1) as count"],
            group: ["label"],
            order: "count DESC",
            limit: 1000,
          }), 3600),
          // Legacy API (2003-2018)
          fetchSocrata<Array<{ label?: unknown; count?: unknown }>>(buildSFIncidentsLegacyURL({
            where: [
              `date_extract_y(date) >= 2003`,
              `category IS NOT NULL`
            ],
            select: ["category as label", "count(1) as count"],
            group: ["label"],
            order: "count DESC",
            limit: 1000,
          }), 3600)
        ]);
        return { modernRows, legacyRows };
      };
      const { modernRows, legacyRows } = await unstableCache(compute, ["crime-types:sf"], { revalidate: 3600, tags: ["crime-types:sf"] })();
      
      // Merge categories from both APIs with case-insensitive dedupe.
      // Prefer modern API label casing when both exist; normalize legacy-only labels to Title Case.
      type CatAgg = { label: string; count: number };
      const byKey = new Map<string, CatAgg>();
      const canonicalize = (s: string) =>
        s
          .trim()
          .toUpperCase()
          .replace(/[^A-Z0-9]+/g, " ") // collapse punctuation like "/" and "-" to spaces
          .replace(/\s+/g, " ")
          .trim();
      const toTitleCase = (s: string) =>
        s
          .toLowerCase()
          .split(/\s+/)
          .map((w) => (w ? w.charAt(0).toUpperCase() + w.slice(1) : w))
          .join(" ");

      // First, add modern categories (authoritative labels)
      for (const r of modernRows || []) {
        if (!r || r.label == null) continue;
        const raw = String(r.label);
        const key = canonicalize(raw);
        const pretty = raw; // modern dataset already provides desired casing
        const count = Number((r as { count?: unknown }).count || 0);
        const prev = byKey.get(key);
        if (prev) prev.count += count;
        else byKey.set(key, { label: pretty, count });
      }

      // Then, add legacy categories (normalize to Title Case if modern label absent)
      for (const r of legacyRows || []) {
        if (!r || r.label == null) continue;
        const raw = String(r.label);
        const key = canonicalize(raw);
        const count = Number((r as { count?: unknown }).count || 0);
        const prev = byKey.get(key);
        if (prev) {
          prev.count += count;
        } else {
          const pretty = toTitleCase(raw.replace(/_/g, " ").replace(/\s+/g, " ").replace(/\//g, " "));
          byKey.set(key, { label: pretty, count });
        }
      }

      const values = Array.from(byKey.values()).sort((a, b) => b.count - a.count);
        
      return Response.json(values, { headers: { "Cache-Control": "public, s-maxage=3600" } });
    }

    // NYC fallback
    const computeNYC = async () => {
      const [complaintsRowsH, complaintsRowsC, shootingsRowsH, shootingsRowsC] = await Promise.all([
        fetchSocrata<Array<{ ofns_desc?: unknown; count?: unknown }>>(complaintsUrl, 3600),
        fetchSocrata<Array<{ ofns_desc?: unknown; count?: unknown }>>(complaintsUrlCur, 3600),
        fetchSocrata<Array<{ count?: unknown }>>(shootingsUrl, 3600),
        fetchSocrata<Array<{ count?: unknown }>>(shootingsUrlCur, 3600),
      ]);
      return { complaintsRowsH, complaintsRowsC, shootingsRowsH, shootingsRowsC };
    };
    const { complaintsRowsH, complaintsRowsC, shootingsRowsH, shootingsRowsC } = await unstableCache(computeNYC, ["crime-types:nyc"], { revalidate: 3600, tags: ["crime-types:nyc"] })();
    const complaintsRows = [...complaintsRowsH, ...complaintsRowsC];
    const shootingsRows = [...shootingsRowsH, ...shootingsRowsC];

    // Process complaint types
    const complaintTypes = complaintsRows
      .filter((r) => r.ofns_desc != null)
      .map((r) => ({ label: String(r.ofns_desc), count: Number(r.count) }));

    // Add shooting incidents as crime types
    const shootingCount = shootingsRows[0]?.count ? Number(shootingsRows[0].count) : 0;
    
    // Get detailed shooting breakdown
    const shootingMurdersUrl = buildShootingsURL({
      where: [
        `occur_date >= '${startISO}'`,
        "statistical_murder_flag = true",
      ],
      select: ["count(1) as count"],
      limit: 1,
    });
    
    const shootingMurdersRows = await fetchSocrata<Array<{ count?: unknown }>>(shootingMurdersUrl, 3600);
    const murderCount = shootingMurdersRows[0]?.count != null ? Number(shootingMurdersRows[0].count) : 0;
    const nonFatalShootingCount = shootingCount - murderCount;
    
    const shootingTypes = [
      { label: "SHOOTING INCIDENT", count: nonFatalShootingCount }, // Non-fatal shootings get their own category
      { label: "MURDER & NON-NEGL. MANSLAUGHTER", count: murderCount }, // Fatal shootings merge with existing murders
    ];

    // Merge shooting data with complaint data
    const typeMap = new Map<string, number>();
    
    // Add complaint types
    complaintTypes.forEach(type => {
      typeMap.set(type.label, (typeMap.get(type.label) || 0) + type.count);
    });

    // Add shooting types (merge with existing)
    shootingTypes.forEach(type => {
      if (type.count > 0) {
        typeMap.set(type.label, (typeMap.get(type.label) || 0) + type.count);
      }
    });

    // Convert back to array and sort
    const values = Array.from(typeMap.entries())
      .map(([label, count]) => ({ label, count }))
      .sort((a, b) => b.count - a.count);

    return Response.json(values, { headers: { "Cache-Control": "public, s-maxage=3600" } });
  } catch (e: unknown) {
    return new Response("Failed to load crime types: " + (e instanceof Error ? e.message : String(e)), { status: 500 });
  }
}


