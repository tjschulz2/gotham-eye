import { NextRequest } from "next/server";
import { buildComplaintsURL, buildShootingsURL, fetchSocrata, buildComplaintsURLCurrent, buildShootingsURLCurrent, buildSFIncidentsURL, buildSFIncidentsLegacyURL } from "@/lib/socrata";

export async function GET() {
  try {
    const complaintsUrl = buildComplaintsURL({
      select: ["min(cmplnt_fr_dt) as min_dt", "max(cmplnt_fr_dt) as max_dt"],
      limit: 1,
    });
    const complaintsUrlCur = buildComplaintsURLCurrent({
      select: ["min(cmplnt_fr_dt) as min_dt", "max(cmplnt_fr_dt) as max_dt"],
      limit: 1,
    });
    const shootingsUrl = buildShootingsURL({
      select: ["min(occur_date) as min_dt", "max(occur_date) as max_dt"],
      limit: 1,
    });
    const shootingsUrlCur = buildShootingsURLCurrent({
      select: ["min(occur_date) as min_dt", "max(occur_date) as max_dt"],
      limit: 1,
    });

    const [cRows, cRowsCur, sRows, sRowsCur, sfRows, sfLegacyRows] = await Promise.all([
      fetchSocrata<any[]>(complaintsUrl, 86400),
      fetchSocrata<any[]>(complaintsUrlCur, 86400),
      fetchSocrata<any[]>(shootingsUrl, 86400),
      fetchSocrata<any[]>(shootingsUrlCur, 86400),
      fetchSocrata<any[]>(buildSFIncidentsURL({ select: ["min(incident_datetime) as min_dt", "max(incident_datetime) as max_dt"], limit: 1 }), 86400),
      fetchSocrata<any[]>(buildSFIncidentsLegacyURL({ select: ["min(date) as min_dt", "max(date) as max_dt"], limit: 1 }), 86400),
    ]);

    const cMin = cRows?.[0]?.min_dt ? new Date(cRows[0].min_dt) : null;
    const cMax = cRowsCur?.[0]?.max_dt ? new Date(cRowsCur[0].max_dt) : (cRows?.[0]?.max_dt ? new Date(cRows[0].max_dt) : null);
    const sMin = sRows?.[0]?.min_dt ? new Date(sRows[0].min_dt) : null;
    const sMax = sRowsCur?.[0]?.max_dt ? new Date(sRowsCur[0].max_dt) : (sRows?.[0]?.max_dt ? new Date(sRows[0].max_dt) : null);

    const sfMin = sfRows?.[0]?.min_dt ? new Date(sfRows[0].min_dt) : null;
    const sfMax = sfRows?.[0]?.max_dt ? new Date(sfRows[0].max_dt) : null;
    const sfLegacyMin = sfLegacyRows?.[0]?.min_dt ? new Date(sfLegacyRows[0].min_dt) : null;
    const sfLegacyMax = sfLegacyRows?.[0]?.max_dt ? new Date(sfLegacyRows[0].max_dt) : null;
    const dates = [cMin, cMax, sMin, sMax, sfMin, sfMax, sfLegacyMin, sfLegacyMax].filter((d): d is Date => !!d && !isNaN(d.getTime()));
    if (dates.length < 2) {
      return Response.json({ minYear: 2021, maxYear: new Date().getFullYear() }, { headers: { "Cache-Control": "public, s-maxage=86400" } });
    }

    const minDate = dates.reduce((a, b) => (a < b ? a : b));
    const maxDate = dates.reduce((a, b) => (a > b ? a : b));
    let minYear = minDate.getUTCFullYear();
    let maxYear = maxDate.getUTCFullYear();
    // Clamp earliest selectable year to 2006 as per product requirement
    if (minYear < 2006) minYear = 2006;
    if (maxYear < minYear) maxYear = minYear;

    return Response.json({ minYear, maxYear }, { headers: { "Cache-Control": "public, s-maxage=86400" } });
  } catch (e: any) {
    return new Response("Failed to load year range: " + (e?.message || String(e)), { status: 500 });
  }
}


