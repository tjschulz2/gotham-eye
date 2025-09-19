// scripts/ingest.mjs
// Node 18+ required (built-in fetch). Run with: node scripts/ingest.mjs

const CH_HTTP = process.env.CLICKHOUSE_HTTP_URL;
const CH_USER = process.env.CLICKHOUSE_USER;
const CH_PASS = process.env.CLICKHOUSE_PASS;
const SOCRATA_APP_TOKEN = process.env.SOCRATA_APP_TOKEN || "";

if (!CH_HTTP || !CH_USER || !CH_PASS) {
  console.error("Missing CLICKHOUSE_HTTP_URL / CLICKHOUSE_USER / CLICKHOUSE_PASS in env");
  process.exit(1);
}

const AUTH = "Basic " + Buffer.from(`${CH_USER}:${CH_PASS}`).toString("base64");

// --------- helpers ----------
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function chInsertJSONEachRow(rows) {
  if (!rows.length) return;
  const body = rows.map(r => JSON.stringify(r)).join("\n");
  const url = `${CH_HTTP}/?query=` + encodeURIComponent(
    "INSERT INTO public.crime_events FORMAT JSONEachRow"
  );
  const res = await fetch(url, {
    method: "POST",
    headers: { Authorization: AUTH, "Content-Type": "application/json" },
    body
  });
  if (!res.ok) {
    const t = await res.text();
    throw new Error(`ClickHouse insert failed: ${res.status} ${t}`);
  }
}

async function* pullPaged(baseUrl, selectCols, where, page = 50000) {
  let offset = 0;
  while (true) {
    const u = new URL(baseUrl);
    u.searchParams.set("$select", selectCols.join(","));
    u.searchParams.set("$limit", String(page));
    u.searchParams.set("$offset", String(offset));
    if (where) u.searchParams.set("$where", where);

    const headers = {};
    if (SOCRATA_APP_TOKEN) headers["X-App-Token"] = SOCRATA_APP_TOKEN;

    let res = await fetch(u.toString(), { headers });
    // rudimentary 429/5xx backoff
    let tries = 0;
    while (!res.ok && (res.status === 429 || res.status >= 500) && tries < 6) {
      const wait = 500 * Math.pow(2, tries);
      console.warn(`Socrata ${res.status}. Backing off ${wait}ms…`);
      await sleep(wait);
      res = await fetch(u.toString(), { headers });
      tries++;
    }
    if (!res.ok) {
      const t = await res.text();
      throw new Error(`Socrata fetch failed: ${res.status} ${t}`);
    }
    const json = await res.json();
    if (!json.length) break;
    yield json;
    offset += json.length;
  }
}

function toDateTime(dateStr, timeStr) {
  const d = (dateStr || "").slice(0, 10);
  const t = (timeStr || "00:00:00").slice(0, 8);
  if (!d) return ""; // will be filtered out
  return `${d} ${t}`;
}

// --------- NYC COMPLAINTS (historic + YTD) ---------
async function ingestNYCComplaints() {
  const urls = [
    "https://data.cityofnewyork.us/resource/qgea-i56i.json", // historic
    "https://data.cityofnewyork.us/resource/5uac-w243.json", // YTD
  ];
  const select = [
    "cmplnt_num","cmplnt_fr_dt","cmplnt_fr_tm",
    "ofns_desc","law_cat_cd","boro_nm","addr_pct_cd",
    "prem_typ_desc","loc_of_occur_desc",
    "susp_race","susp_sex","susp_age_group",
    "vic_race","vic_sex","vic_age_group",
    "latitude","longitude"
  ];
  const where = "cmplnt_fr_dt >= '2022-01-01T00:00:00.000' AND cmplnt_fr_dt <= '2025-12-31T23:59:59.999' AND latitude IS NOT NULL AND longitude IS NOT NULL";

  let total = 0;
  for (const url of urls) {
    for await (const batch of pullPaged(url, select, where)) {
      const mapped = batch.map(r => {
        const occurred_at = toDateTime(r.cmplnt_fr_dt, r.cmplnt_fr_tm);
        return {
          city: "nyc",
          source: "complaints",
          event_id: String(r.cmplnt_num ?? ""),
          occurred_at,
          lat: Number(r.latitude),
          lon: Number(r.longitude),
          offense: r.ofns_desc ?? "",
          law_class: r.law_cat_cd ?? "",
          borough: r.boro_nm ?? "",
          precinct: r.addr_pct_cd != null ? String(r.addr_pct_cd) : "",
          district: "",
          raw: JSON.stringify({
            prem_typ_desc: r.prem_typ_desc ?? "",
            loc_of_occur_desc: r.loc_of_occur_desc ?? "",
            susp_race: r.susp_race ?? "",
            susp_sex: r.susp_sex ?? "",
            susp_age_group: r.susp_age_group ?? "",
            vic_race: r.vic_race ?? "",
            vic_sex: r.vic_sex ?? "",
            vic_age_group: r.vic_age_group ?? "",
          })
        };
      }).filter(x => x.event_id && x.occurred_at && Number.isFinite(x.lat) && Number.isFinite(x.lon));
      await chInsertJSONEachRow(mapped);
      total += mapped.length;
      console.log(`NYC complaints [${url}] +${mapped.length} (cum ${total})`);
    }
  }
  return total;
}

// --------- NYC SHOOTINGS (historic + YTD) ---------
async function ingestNYCShootings() {
  const urls = [
    "https://data.cityofnewyork.us/resource/833y-fsy8.json", // historic
    "https://data.cityofnewyork.us/resource/5ucz-vwe8.json", // YTD
  ];
  const select = [
    "incident_key","occur_date","occur_time","boro","precinct",
    "statistical_murder_flag","location_desc",
    "perp_race","perp_sex","perp_age_group",
    "vic_race","vic_sex","vic_age_group",
    "latitude","longitude"
  ];
  const where = "occur_date >= '2022-01-01T00:00:00.000' AND occur_date <= '2025-12-31T23:59:59.999' AND latitude IS NOT NULL AND longitude IS NOT NULL";

  let total = 0;
  for (const url of urls) {
    for await (const batch of pullPaged(url, select, where)) {
      const mapped = batch.map(r => {
        const occurred_at = toDateTime(r.occur_date, r.occur_time);
        const offense =
          r?.statistical_murder_flag === "true" || r?.statistical_murder_flag === true
            ? "Shooting (Murder)"
            : (r.location_desc ?? "Shooting");
        return {
          city: "nyc",
          source: "shootings",
          event_id: String(r.incident_key ?? ""),
          occurred_at,
          lat: Number(r.latitude),
          lon: Number(r.longitude),
          offense,
          law_class: "",
          borough: r.boro ?? "",
          precinct: r.precinct != null ? String(r.precinct) : "",
          district: "",
          raw: JSON.stringify({
            location_desc: r.location_desc ?? "",
            perp_race: r.perp_race ?? "",
            perp_sex: r.perp_sex ?? "",
            perp_age_group: r.perp_age_group ?? "",
            vic_race: r.vic_race ?? "",
            vic_sex: r.vic_sex ?? "",
            vic_age_group: r.vic_age_group ?? "",
          })
        };
      }).filter(x => x.event_id && x.occurred_at && Number.isFinite(x.lat) && Number.isFinite(x.lon));
      await chInsertJSONEachRow(mapped);
      total += mapped.length;
      console.log(`NYC shootings [${url}] +${mapped.length} (cum ${total})`);
    }
  }
  return total;
}

// --------- SF INCIDENTS (single dataset) ---------
async function ingestSFIncidents() {
  const url = "https://data.sfgov.org/resource/wg3w-h783.json";
  const select = [
    "incident_id","incident_number","incident_datetime","report_datetime",
    "incident_category","police_district", "analysis_neighborhood", "latitude","longitude"
  ];
  const where = "incident_datetime >= '2022-01-01T00:00:00.000' AND incident_datetime <= '2025-12-31T23:59:59.999' AND latitude IS NOT NULL AND longitude IS NOT NULL";

  let total = 0;
  for await (const batch of pullPaged(url, select, where)) {
    const mapped = batch.map(r => {
      const dt = (r.incident_datetime || r.report_datetime || "").replace("T", " ").replace("Z", "");
      return {
        city: "sf",
        source: "incidents",
        event_id: String(r.incident_id ?? r.incident_number ?? ""),
        occurred_at: dt,
        lat: Number(r.latitude),
        lon: Number(r.longitude),
        offense: r.incident_category ?? "",
        law_class: "",
        borough: "",
        precinct: "",
        district: r.police_district ?? "",
        raw: JSON.stringify(r)
      };
    }).filter(x => x.event_id && x.occurred_at && Number.isFinite(x.lat) && Number.isFinite(x.lon));
    await chInsertJSONEachRow(mapped);
    total += mapped.length;
    console.log(`SF incidents +${mapped.length} (cum ${total})`);
  }
  return total;
}

// --------- run all ---------
(async () => {
  const t0 = Date.now();
  console.log("Starting ingest 2022–2025…");

  const nycComplaints = await ingestNYCComplaints();
  const nycShootings  = await ingestNYCShootings();
  const sfIncidents   = await ingestSFIncidents();

  const mins = ((Date.now() - t0) / 60000).toFixed(1);
  console.log(`Done. NYC complaints=${nycComplaints}, NYC shootings=${nycShootings}, SF incidents=${sfIncidents}. Took ${mins} min.`);
})().catch(err => {
  console.error(err);
  process.exit(1);
});
